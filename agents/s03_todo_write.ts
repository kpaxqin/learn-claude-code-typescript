#!/usr/bin/env tsx
/**
 * s03_todo_write.ts - TodoWrite
 *
 * The model tracks its own progress via a TodoManager. A nag reminder
 * forces it to keep updating when it forgets.
 *
 *     +----------+      +-------+      +---------+
 *     |   User   | ---> |  LLM  | ---> | Tools   |
 *     |  prompt  |      |       |      | + todo  |
 *     +----------+      +---+---+      +----+----+
 *                           ^               |
 *                           |   tool_result |
 *                           +---------------+
 *                                 |
 *                     +-----------+-----------+
 *                     | TodoManager state     |
 *                     | [ ] task A            |
 *                     | [>] task B <- doing   |
 *                     | [x] task C            |
 *                     +-----------------------+
 *                                 |
 *                     if rounds_since_todo >= 3:
 *                       inject <reminder>
 *
 * Key insight: "The agent can track its own progress -- and I can see it."
 */

import Anthropic from "@anthropic-ai/sdk";
import * as dotenv from "dotenv";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";

dotenv.config({ override: true });

const client = new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL });
const MODEL = process.env.MODEL_ID!;
const WORKDIR = process.cwd();

const SYSTEM = `You are a coding agent at ${WORKDIR}.
Use the todo tool to plan multi-step tasks. Mark in_progress before starting, completed when done.
Prefer tools over prose.`;

// -- TodoManager: structured state the LLM writes to --
interface TodoItem {
  id: string;
  text: string;
  status: "pending" | "in_progress" | "completed";
}

class TodoManager {
  private items: TodoItem[] = [];

  update(items: Array<{ id?: string; text?: string; status?: string }>): string {
    if (items.length > 20) throw new Error("Max 20 todos allowed");
    const validated: TodoItem[] = [];
    let inProgressCount = 0;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const text = String(item.text || "").trim();
      const status = String(item.status || "pending").toLowerCase() as TodoItem["status"];
      const id = String(item.id || String(i + 1));
      if (!text) throw new Error(`Item ${id}: text required`);
      if (!["pending", "in_progress", "completed"].includes(status))
        throw new Error(`Item ${id}: invalid status '${status}'`);
      if (status === "in_progress") inProgressCount++;
      validated.push({ id, text, status });
    }
    if (inProgressCount > 1) throw new Error("Only one task can be in_progress at a time");
    this.items = validated;
    return this.render();
  }

  render(): string {
    if (!this.items.length) return "No todos.";
    const markers: Record<string, string> = { pending: "[ ]", in_progress: "[>]", completed: "[x]" };
    const lines = this.items.map((item) => `${markers[item.status]} #${item.id}: ${item.text}`);
    const done = this.items.filter((t) => t.status === "completed").length;
    lines.push(`\n(${done}/${this.items.length} completed)`);
    return lines.join("\n");
  }
}

const TODO = new TodoManager();

type ToolInput = Record<string, unknown>;

function safePath(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  if (!resolved.startsWith(WORKDIR)) throw new Error(`Path escapes workspace: ${p}`);
  return resolved;
}

function runBash(command: string): string {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((d) => command.includes(d))) return "Error: Dangerous command blocked";
  const result = spawnSync("bash", ["-c", command], { cwd: WORKDIR, timeout: 120000, encoding: "utf-8" });
  if (result.error?.message?.includes("ETIMEDOUT")) return "Error: Timeout (120s)";
  const out = ((result.stdout || "") + (result.stderr || "")).trim();
  return (out || "(no output)").slice(0, 50000);
}

function runRead(filePath: string, limit?: number): string {
  try {
    const lines = fs.readFileSync(safePath(filePath), "utf-8").split("\n");
    const limited = (limit && limit < lines.length)
      ? [...lines.slice(0, limit), `... (${lines.length - limit} more)`]
      : lines;
    return limited.join("\n").slice(0, 50000);
  } catch (e) { return `Error: ${e}`; }
}

function runWrite(filePath: string, content: string): string {
  try {
    const fp = safePath(filePath);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content, "utf-8");
    return `Wrote ${content.length} bytes`;
  } catch (e) { return `Error: ${e}`; }
}

function runEdit(filePath: string, oldText: string, newText: string): string {
  try {
    const fp = safePath(filePath);
    const content = fs.readFileSync(fp, "utf-8");
    if (!content.includes(oldText)) return `Error: Text not found in ${filePath}`;
    fs.writeFileSync(fp, content.replace(oldText, newText), "utf-8");
    return `Edited ${filePath}`;
  } catch (e) { return `Error: ${e}`; }
}

const TOOL_HANDLERS: Record<string, (kw: ToolInput) => string> = {
  bash:       (kw) => runBash(kw.command as string),
  read_file:  (kw) => runRead(kw.path as string, kw.limit as number | undefined),
  write_file: (kw) => runWrite(kw.path as string, kw.content as string),
  edit_file:  (kw) => runEdit(kw.path as string, kw.old_text as string, kw.new_text as string),
  todo:       (kw) => TODO.update(kw.items as Array<{ id?: string; text?: string; status?: string }>),
};

const TOOLS: Anthropic.Tool[] = [
  { name: "bash", description: "Run a shell command.",
    input_schema: { type: "object" as const, properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "read_file", description: "Read file contents.",
    input_schema: { type: "object" as const, properties: { path: { type: "string" }, limit: { type: "integer" } }, required: ["path"] } },
  { name: "write_file", description: "Write content to file.",
    input_schema: { type: "object" as const, properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "edit_file", description: "Replace exact text in file.",
    input_schema: { type: "object" as const, properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } },
  { name: "todo", description: "Update task list. Track progress on multi-step tasks.",
    input_schema: { type: "object" as const, properties: { items: { type: "array", items: { type: "object", properties: { id: { type: "string" }, text: { type: "string" }, status: { type: "string", enum: ["pending", "in_progress", "completed"] } }, required: ["id", "text", "status"] } } }, required: ["items"] } },
];

// -- Agent loop with nag reminder injection --
async function agentLoop(messages: Anthropic.MessageParam[]): Promise<void> {
  let roundsSinceTodo = 0;
  while (true) {
    const response = await client.messages.create({
      model: MODEL, system: SYSTEM, messages, tools: TOOLS, max_tokens: 8000,
    });
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") return;
    const results: Array<Anthropic.ToolResultBlockParam | { type: "text"; text: string }> = [];
    let usedTodo = false;
    for (const block of response.content) {
      if (block.type === "tool_use") {
        const handler = TOOL_HANDLERS[block.name];
        let output: string;
        try {
          output = handler ? handler(block.input as ToolInput) : `Unknown tool: ${block.name}`;
        } catch (e) {
          output = `Error: ${e}`;
        }
        process.stdout.write(`> ${block.name}: ${String(output).slice(0, 200)}\n`);
        results.push({ type: "tool_result", tool_use_id: block.id, content: String(output) });
        if (block.name === "todo") usedTodo = true;
      }
    }
    roundsSinceTodo = usedTodo ? 0 : roundsSinceTodo + 1;
    if (roundsSinceTodo >= 3) {
      results.unshift({ type: "text", text: "<reminder>Update your todos.</reminder>" });
    }
    messages.push({ role: "user", content: results as Anthropic.MessageParam["content"] });
  }
}

async function main() {
  const history: Anthropic.MessageParam[] = [];
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = () => new Promise<string>((resolve) => rl.question("\x1b[36ms03 >> \x1b[0m", resolve));

  while (true) {
    let query: string;
    try { query = await ask(); } catch { break; }
    if (["q", "exit", ""].includes(query.trim().toLowerCase())) break;
    history.push({ role: "user", content: query });
    await agentLoop(history);
    const last = history[history.length - 1];
    if (last.role === "assistant" && Array.isArray(last.content)) {
      for (const block of last.content) {
        if (block.type === "text") process.stdout.write(block.text + "\n");
      }
    }
    process.stdout.write("\n");
  }
  rl.close();
}

main().catch(console.error);
