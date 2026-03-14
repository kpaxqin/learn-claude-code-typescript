#!/usr/bin/env tsx
/**
 * s08_background_tasks.ts - Background Tasks
 *
 * Run commands in background. A notification queue is drained
 * before each LLM call to deliver results.
 *
 *     Main loop                   Background exec
 *     +-----------------+         +-----------------+
 *     | agent loop      |         | task executes   |
 *     | ...             |         | ...             |
 *     | [LLM call] <---+--------- | enqueue(result) |
 *     |  ^drain queue   |         +-----------------+
 *     +-----------------+
 *
 *     Timeline:
 *     Agent ----[spawn A]----[spawn B]----[other work]----
 *                  |              |
 *                  v              v
 *               [A runs]      [B runs]        (parallel)
 *                  |              |
 *                  +-- notification queue --> [results injected]
 *
 * Key insight: "Fire and forget -- the agent doesn't block while the command runs."
 */

import Anthropic from "@anthropic-ai/sdk";
import * as dotenv from "dotenv";
import { spawnSync, exec } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { randomUUID } from "crypto";

dotenv.config({ override: true });

const client = new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL });
const MODEL = process.env.MODEL_ID!;
const WORKDIR = process.cwd();

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use background_run for long-running commands.`;

interface BgTask {
  status: "running" | "completed" | "timeout" | "error";
  result: string | null;
  command: string;
}

interface Notification {
  task_id: string;
  status: string;
  command: string;
  result: string;
}

// -- BackgroundManager: async execution + notification queue --
class BackgroundManager {
  private tasks: Map<string, BgTask> = new Map();
  private notificationQueue: Notification[] = [];

  run(command: string): string {
    const taskId = randomUUID().slice(0, 8);
    this.tasks.set(taskId, { status: "running", result: null, command });

    exec(command, { cwd: WORKDIR, timeout: 300000 }, (error, stdout, stderr) => {
      const task = this.tasks.get(taskId)!;
      if (error && error.killed) {
        task.status = "timeout";
        task.result = "Error: Timeout (300s)";
      } else {
        task.status = "completed";
        task.result = ((stdout || "") + (stderr || "")).trim().slice(0, 50000) || "(no output)";
      }
      this.notificationQueue.push({
        task_id: taskId,
        status: task.status,
        command: command.slice(0, 80),
        result: task.result!.slice(0, 500),
      });
    });

    return `Background task ${taskId} started: ${command.slice(0, 80)}`;
  }

  check(taskId?: string): string {
    if (taskId) {
      const t = this.tasks.get(taskId);
      if (!t) return `Error: Unknown task ${taskId}`;
      return `[${t.status}] ${t.command.slice(0, 60)}\n${t.result || "(running)"}`;
    }
    const lines: string[] = [];
    for (const [tid, t] of this.tasks) {
      lines.push(`${tid}: [${t.status}] ${t.command.slice(0, 60)}`);
    }
    return lines.join("\n") || "No background tasks.";
  }

  drainNotifications(): Notification[] {
    const notifs = [...this.notificationQueue];
    this.notificationQueue.length = 0;
    return notifs;
  }
}

const BG = new BackgroundManager();

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
  bash:             (kw) => runBash(kw.command as string),
  read_file:        (kw) => runRead(kw.path as string, kw.limit as number | undefined),
  write_file:       (kw) => runWrite(kw.path as string, kw.content as string),
  edit_file:        (kw) => runEdit(kw.path as string, kw.old_text as string, kw.new_text as string),
  background_run:   (kw) => BG.run(kw.command as string),
  check_background: (kw) => BG.check(kw.task_id as string | undefined),
};

const TOOLS: Anthropic.Tool[] = [
  { name: "bash", description: "Run a shell command (blocking).",
    input_schema: { type: "object" as const, properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "read_file", description: "Read file contents.",
    input_schema: { type: "object" as const, properties: { path: { type: "string" }, limit: { type: "integer" } }, required: ["path"] } },
  { name: "write_file", description: "Write content to file.",
    input_schema: { type: "object" as const, properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "edit_file", description: "Replace exact text in file.",
    input_schema: { type: "object" as const, properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } },
  { name: "background_run", description: "Run command in background. Returns task_id immediately.",
    input_schema: { type: "object" as const, properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "check_background", description: "Check background task status. Omit task_id to list all.",
    input_schema: { type: "object" as const, properties: { task_id: { type: "string" } } } },
];

async function agentLoop(messages: Anthropic.MessageParam[]): Promise<void> {
  while (true) {
    // Drain background notifications and inject as system message before LLM call
    const notifs = BG.drainNotifications();
    if (notifs.length && messages.length) {
      const notifText = notifs.map((n) => `[bg:${n.task_id}] ${n.status}: ${n.result}`).join("\n");
      messages.push({ role: "user", content: `<background-results>\n${notifText}\n</background-results>` });
      messages.push({ role: "assistant", content: "Noted background results." });
    }
    const response = await client.messages.create({
      model: MODEL, system: SYSTEM, messages, tools: TOOLS, max_tokens: 8000,
    });
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") return;
    const results: Anthropic.ToolResultBlockParam[] = [];
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
      }
    }
    messages.push({ role: "user", content: results });
  }
}

async function main() {
  const history: Anthropic.MessageParam[] = [];
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = () => new Promise<string>((resolve) => rl.question("\x1b[36ms08 >> \x1b[0m", resolve));

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
