#!/usr/bin/env tsx
/**
 * s07_task_system.ts - Tasks
 *
 * Tasks persist as JSON files in .tasks/ so they survive context compression.
 * Each task has a dependency graph (blockedBy/blocks).
 *
 *     .tasks/
 *       task_1.json  {"id":1, "subject":"...", "status":"completed", ...}
 *       task_2.json  {"id":2, "blockedBy":[1], "status":"pending", ...}
 *       task_3.json  {"id":3, "blockedBy":[2], "blocks":[], ...}
 *
 *     Dependency resolution:
 *     +----------+     +----------+     +----------+
 *     | task 1   | --> | task 2   | --> | task 3   |
 *     | complete |     | blocked  |     | blocked  |
 *     +----------+     +----------+     +----------+
 *          |                ^
 *          +--- completing task 1 removes it from task 2's blockedBy
 *
 * Key insight: "State that survives compression -- because it's outside the conversation."
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
const TASKS_DIR = path.join(WORKDIR, ".tasks");

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use task tools to plan and track work.`;

interface Task {
  id: number;
  subject: string;
  description: string;
  status: "pending" | "in_progress" | "completed";
  blockedBy: number[];
  blocks: number[];
  owner: string;
}

// -- TaskManager: CRUD with dependency graph, persisted as JSON files --
class TaskManager {
  private nextId: number;

  constructor(private tasksDir: string) {
    fs.mkdirSync(tasksDir, { recursive: true });
    this.nextId = this.maxId() + 1;
  }

  private maxId(): number {
    const files = fs.readdirSync(this.tasksDir).filter((f) => /^task_\d+\.json$/.test(f));
    if (!files.length) return 0;
    return Math.max(...files.map((f) => parseInt(f.split("_")[1])));
  }

  private taskPath(id: number): string {
    return path.join(this.tasksDir, `task_${id}.json`);
  }

  private load(id: number): Task {
    const p = this.taskPath(id);
    if (!fs.existsSync(p)) throw new Error(`Task ${id} not found`);
    return JSON.parse(fs.readFileSync(p, "utf-8")) as Task;
  }

  private save(task: Task): void {
    fs.writeFileSync(this.taskPath(task.id), JSON.stringify(task, null, 2), "utf-8");
  }

  create(subject: string, description = ""): string {
    const task: Task = {
      id: this.nextId, subject, description,
      status: "pending", blockedBy: [], blocks: [], owner: "",
    };
    this.save(task);
    this.nextId++;
    return JSON.stringify(task, null, 2);
  }

  get(id: number): string {
    return JSON.stringify(this.load(id), null, 2);
  }

  update(id: number, status?: string, addBlockedBy?: number[], addBlocks?: number[]): string {
    const task = this.load(id);
    if (status) {
      if (!["pending", "in_progress", "completed"].includes(status))
        throw new Error(`Invalid status: ${status}`);
      task.status = status as Task["status"];
      if (status === "completed") this.clearDependency(id);
    }
    if (addBlockedBy) {
      task.blockedBy = [...new Set([...task.blockedBy, ...addBlockedBy])];
    }
    if (addBlocks) {
      task.blocks = [...new Set([...task.blocks, ...addBlocks])];
      for (const blockedId of addBlocks) {
        try {
          const blocked = this.load(blockedId);
          if (!blocked.blockedBy.includes(id)) {
            blocked.blockedBy.push(id);
            this.save(blocked);
          }
        } catch { /* task may not exist */ }
      }
    }
    this.save(task);
    return JSON.stringify(task, null, 2);
  }

  private clearDependency(completedId: number): void {
    const files = fs.readdirSync(this.tasksDir).filter((f) => /^task_\d+\.json$/.test(f));
    for (const f of files) {
      const task = JSON.parse(fs.readFileSync(path.join(this.tasksDir, f), "utf-8")) as Task;
      if (task.blockedBy.includes(completedId)) {
        task.blockedBy = task.blockedBy.filter((id) => id !== completedId);
        this.save(task);
      }
    }
  }

  listAll(): string {
    const files = fs.readdirSync(this.tasksDir)
      .filter((f) => /^task_\d+\.json$/.test(f))
      .sort();
    if (!files.length) return "No tasks.";
    const tasks = files.map((f) => JSON.parse(fs.readFileSync(path.join(this.tasksDir, f), "utf-8")) as Task);
    const markers: Record<string, string> = { pending: "[ ]", in_progress: "[>]", completed: "[x]" };
    const lines = tasks.map((t) => {
      const marker = markers[t.status] || "[?]";
      const blocked = t.blockedBy.length ? ` (blocked by: ${JSON.stringify(t.blockedBy)})` : "";
      return `${marker} #${t.id}: ${t.subject}${blocked}`;
    });
    return lines.join("\n");
  }
}

const TASKS = new TaskManager(TASKS_DIR);

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
  bash:        (kw) => runBash(kw.command as string),
  read_file:   (kw) => runRead(kw.path as string, kw.limit as number | undefined),
  write_file:  (kw) => runWrite(kw.path as string, kw.content as string),
  edit_file:   (kw) => runEdit(kw.path as string, kw.old_text as string, kw.new_text as string),
  task_create: (kw) => TASKS.create(kw.subject as string, kw.description as string | undefined),
  task_update: (kw) => TASKS.update(kw.task_id as number, kw.status as string | undefined, kw.addBlockedBy as number[] | undefined, kw.addBlocks as number[] | undefined),
  task_list:   () => TASKS.listAll(),
  task_get:    (kw) => TASKS.get(kw.task_id as number),
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
  { name: "task_create", description: "Create a new task.",
    input_schema: { type: "object" as const, properties: { subject: { type: "string" }, description: { type: "string" } }, required: ["subject"] } },
  { name: "task_update", description: "Update a task's status or dependencies.",
    input_schema: { type: "object" as const, properties: { task_id: { type: "integer" }, status: { type: "string", enum: ["pending", "in_progress", "completed"] }, addBlockedBy: { type: "array", items: { type: "integer" } }, addBlocks: { type: "array", items: { type: "integer" } } }, required: ["task_id"] } },
  { name: "task_list", description: "List all tasks with status summary.",
    input_schema: { type: "object" as const, properties: {} } },
  { name: "task_get", description: "Get full details of a task by ID.",
    input_schema: { type: "object" as const, properties: { task_id: { type: "integer" } }, required: ["task_id"] } },
];

async function agentLoop(messages: Anthropic.MessageParam[]): Promise<void> {
  while (true) {
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
  const ask = () => new Promise<string>((resolve) => rl.question("\x1b[36ms07 >> \x1b[0m", resolve));

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
