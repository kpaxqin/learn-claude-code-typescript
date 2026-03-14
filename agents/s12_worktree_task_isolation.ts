#!/usr/bin/env tsx
/**
 * s12_worktree_task_isolation.ts - Worktree + Task Isolation
 *
 * Directory-level isolation for parallel task execution.
 * Tasks are the control plane and worktrees are the execution plane.
 *
 *     .tasks/task_12.json
 *       {
 *         "id": 12,
 *         "subject": "Implement auth refactor",
 *         "status": "in_progress",
 *         "worktree": "auth-refactor"
 *       }
 *
 *     .worktrees/index.json
 *       {
 *         "worktrees": [
 *           {
 *             "name": "auth-refactor",
 *             "path": ".../.worktrees/auth-refactor",
 *             "branch": "wt/auth-refactor",
 *             "task_id": 12,
 *             "status": "active"
 *           }
 *         ]
 *       }
 *
 * Key insight: "Isolate by directory, coordinate by task ID."
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

function detectRepoRoot(cwd: string): string | null {
  try {
    const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd, timeout: 10000, encoding: "utf-8",
    });
    if (result.status !== 0) return null;
    const root = result.stdout.trim();
    return fs.existsSync(root) ? root : null;
  } catch { return null; }
}

const REPO_ROOT = detectRepoRoot(WORKDIR) || WORKDIR;

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use task + worktree tools for multi-task work. For parallel or risky changes: create tasks, allocate worktree lanes, run commands in those lanes, then choose keep/remove for closeout. Use worktree_events when you need lifecycle visibility.`;

// -- EventBus: append-only lifecycle events for observability --
class EventBus {
  constructor(private eventLogPath: string) {
    fs.mkdirSync(path.dirname(eventLogPath), { recursive: true });
    if (!fs.existsSync(eventLogPath)) fs.writeFileSync(eventLogPath, "", "utf-8");
  }

  emit(event: string, task: Record<string, unknown> = {}, worktree: Record<string, unknown> = {}, error?: string): void {
    const payload: Record<string, unknown> = { event, ts: Date.now() / 1000, task, worktree };
    if (error) payload.error = error;
    fs.appendFileSync(this.eventLogPath, JSON.stringify(payload) + "\n", "utf-8");
  }

  listRecent(limit = 20): string {
    const n = Math.max(1, Math.min(Math.floor(limit || 20), 200));
    const lines = fs.readFileSync(this.eventLogPath, "utf-8").split("\n").filter(Boolean);
    const recent = lines.slice(-n);
    const items = recent.map((line) => { try { return JSON.parse(line) as unknown; } catch { return { event: "parse_error", raw: line }; } });
    return JSON.stringify(items, null, 2);
  }
}

interface Task {
  id: number; subject: string; description: string;
  status: "pending" | "in_progress" | "completed";
  owner: string; worktree: string; blockedBy: number[];
  created_at: number; updated_at: number;
}

// -- TaskManager: persistent task board with optional worktree binding --
class TaskManager {
  private nextId: number;

  constructor(private tasksDir: string) {
    fs.mkdirSync(tasksDir, { recursive: true });
    this.nextId = this.maxId() + 1;
  }

  private maxId(): number {
    const ids = fs.readdirSync(this.tasksDir)
      .filter((f) => /^task_\d+\.json$/.test(f))
      .map((f) => parseInt(f.split("_")[1]));
    return ids.length ? Math.max(...ids) : 0;
  }

  private taskPath(id: number): string { return path.join(this.tasksDir, `task_${id}.json`); }

  private load(id: number): Task {
    const p = this.taskPath(id);
    if (!fs.existsSync(p)) throw new Error(`Task ${id} not found`);
    return JSON.parse(fs.readFileSync(p, "utf-8")) as Task;
  }

  private save(task: Task): void { fs.writeFileSync(this.taskPath(task.id), JSON.stringify(task, null, 2), "utf-8"); }

  exists(id: number): boolean { return fs.existsSync(this.taskPath(id)); }

  create(subject: string, description = ""): string {
    const now = Date.now() / 1000;
    const task: Task = { id: this.nextId, subject, description, status: "pending", owner: "", worktree: "", blockedBy: [], created_at: now, updated_at: now };
    this.save(task); this.nextId++;
    return JSON.stringify(task, null, 2);
  }

  get(id: number): string { return JSON.stringify(this.load(id), null, 2); }

  update(id: number, status?: string, owner?: string): string {
    const task = this.load(id);
    if (status) {
      if (!["pending", "in_progress", "completed"].includes(status)) throw new Error(`Invalid status: ${status}`);
      task.status = status as Task["status"];
    }
    if (owner !== undefined) task.owner = owner;
    task.updated_at = Date.now() / 1000;
    this.save(task);
    return JSON.stringify(task, null, 2);
  }

  bindWorktree(id: number, worktree: string, owner = ""): string {
    const task = this.load(id);
    task.worktree = worktree;
    if (owner) task.owner = owner;
    if (task.status === "pending") task.status = "in_progress";
    task.updated_at = Date.now() / 1000;
    this.save(task);
    return JSON.stringify(task, null, 2);
  }

  unbindWorktree(id: number): string {
    const task = this.load(id);
    task.worktree = ""; task.updated_at = Date.now() / 1000;
    this.save(task);
    return JSON.stringify(task, null, 2);
  }

  listAll(): string {
    const files = fs.readdirSync(this.tasksDir).filter((f) => /^task_\d+\.json$/.test(f)).sort();
    if (!files.length) return "No tasks.";
    const markers: Record<string, string> = { pending: "[ ]", in_progress: "[>]", completed: "[x]" };
    return files.map((f) => {
      const t = JSON.parse(fs.readFileSync(path.join(this.tasksDir, f), "utf-8")) as Task;
      const marker = markers[t.status] || "[?]";
      const owner = t.owner ? ` owner=${t.owner}` : "";
      const wt = t.worktree ? ` wt=${t.worktree}` : "";
      return `${marker} #${t.id}: ${t.subject}${owner}${wt}`;
    }).join("\n");
  }
}

const TASKS = new TaskManager(path.join(REPO_ROOT, ".tasks"));
const EVENTS = new EventBus(path.join(REPO_ROOT, ".worktrees", "events.jsonl"));

interface WorktreeEntry {
  name: string; path: string; branch: string;
  task_id: number | null; status: string; created_at: number;
  removed_at?: number; kept_at?: number;
}

interface WorktreeIndex { worktrees: WorktreeEntry[]; }

// -- WorktreeManager: create/list/run/remove git worktrees + lifecycle index --
class WorktreeManager {
  private indexPath: string;
  public gitAvailable: boolean;

  constructor(private repoRoot: string, private tasks: TaskManager, private events: EventBus) {
    const wtDir = path.join(repoRoot, ".worktrees");
    fs.mkdirSync(wtDir, { recursive: true });
    this.indexPath = path.join(wtDir, "index.json");
    if (!fs.existsSync(this.indexPath)) fs.writeFileSync(this.indexPath, JSON.stringify({ worktrees: [] }, null, 2), "utf-8");
    this.gitAvailable = this.isGitRepo();
  }

  private isGitRepo(): boolean {
    try {
      const r = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: this.repoRoot, timeout: 10000, encoding: "utf-8" });
      return r.status === 0;
    } catch { return false; }
  }

  private runGit(args: string[]): string {
    if (!this.gitAvailable) throw new Error("Not in a git repository. worktree tools require git.");
    const r = spawnSync("git", args, { cwd: this.repoRoot, timeout: 120000, encoding: "utf-8" });
    if (r.status !== 0) { const msg = ((r.stdout || "") + (r.stderr || "")).trim(); throw new Error(msg || `git ${args.join(" ")} failed`); }
    return ((r.stdout || "") + (r.stderr || "")).trim() || "(no output)";
  }

  private loadIndex(): WorktreeIndex { return JSON.parse(fs.readFileSync(this.indexPath, "utf-8")) as WorktreeIndex; }
  private saveIndex(data: WorktreeIndex): void { fs.writeFileSync(this.indexPath, JSON.stringify(data, null, 2), "utf-8"); }
  private find(name: string): WorktreeEntry | undefined { return this.loadIndex().worktrees.find((w) => w.name === name); }

  private validateName(name: string): void {
    if (!/^[A-Za-z0-9._-]{1,40}$/.test(name || "")) throw new Error("Invalid worktree name. Use 1-40 chars: letters, numbers, ., _, -");
  }

  create(name: string, taskId?: number, baseRef = "HEAD"): string {
    this.validateName(name);
    if (this.find(name)) throw new Error(`Worktree '${name}' already exists in index`);
    if (taskId !== undefined && !this.tasks.exists(taskId)) throw new Error(`Task ${taskId} not found`);

    const wtPath = path.join(this.repoRoot, ".worktrees", name);
    const branch = `wt/${name}`;
    this.events.emit("worktree.create.before", taskId !== undefined ? { id: taskId } : {}, { name, base_ref: baseRef });
    try {
      this.runGit(["worktree", "add", "-b", branch, wtPath, baseRef]);
      const entry: WorktreeEntry = { name, path: wtPath, branch, task_id: taskId ?? null, status: "active", created_at: Date.now() / 1000 };
      const idx = this.loadIndex();
      idx.worktrees.push(entry);
      this.saveIndex(idx);
      if (taskId !== undefined) this.tasks.bindWorktree(taskId, name);
      this.events.emit("worktree.create.after", taskId !== undefined ? { id: taskId } : {}, { name, path: wtPath, branch, status: "active" });
      return JSON.stringify(entry, null, 2);
    } catch (e) {
      this.events.emit("worktree.create.failed", taskId !== undefined ? { id: taskId } : {}, { name, base_ref: baseRef }, String(e));
      throw e;
    }
  }

  listAll(): string {
    const wts = this.loadIndex().worktrees;
    if (!wts.length) return "No worktrees in index.";
    return wts.map((wt) => {
      const suffix = wt.task_id !== null ? ` task=${wt.task_id}` : "";
      return `[${wt.status || "unknown"}] ${wt.name} -> ${wt.path} (${wt.branch || "-"})${suffix}`;
    }).join("\n");
  }

  status(name: string): string {
    const wt = this.find(name);
    if (!wt) return `Error: Unknown worktree '${name}'`;
    if (!fs.existsSync(wt.path)) return `Error: Worktree path missing: ${wt.path}`;
    const r = spawnSync("git", ["status", "--short", "--branch"], { cwd: wt.path, timeout: 60000, encoding: "utf-8" });
    return ((r.stdout || "") + (r.stderr || "")).trim() || "Clean worktree";
  }

  run(name: string, command: string): string {
    const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
    if (dangerous.some((d) => command.includes(d))) return "Error: Dangerous command blocked";
    const wt = this.find(name);
    if (!wt) return `Error: Unknown worktree '${name}'`;
    if (!fs.existsSync(wt.path)) return `Error: Worktree path missing: ${wt.path}`;
    const r = spawnSync("bash", ["-c", command], { cwd: wt.path, timeout: 300000, encoding: "utf-8" });
    const out = ((r.stdout || "") + (r.stderr || "")).trim();
    return (out || "(no output)").slice(0, 50000);
  }

  remove(name: string, force = false, completeTask = false): string {
    const wt = this.find(name);
    if (!wt) return `Error: Unknown worktree '${name}'`;
    this.events.emit("worktree.remove.before", wt.task_id !== null ? { id: wt.task_id } : {}, { name, path: wt.path });
    try {
      const args = ["worktree", "remove"];
      if (force) args.push("--force");
      args.push(wt.path);
      this.runGit(args);
      if (completeTask && wt.task_id !== null) {
        const before = JSON.parse(this.tasks.get(wt.task_id)) as Task;
        this.tasks.update(wt.task_id, "completed");
        this.tasks.unbindWorktree(wt.task_id);
        this.events.emit("task.completed", { id: wt.task_id, subject: before.subject, status: "completed" }, { name });
      }
      const idx = this.loadIndex();
      for (const item of idx.worktrees) {
        if (item.name === name) { item.status = "removed"; item.removed_at = Date.now() / 1000; }
      }
      this.saveIndex(idx);
      this.events.emit("worktree.remove.after", wt.task_id !== null ? { id: wt.task_id } : {}, { name, path: wt.path, status: "removed" });
      return `Removed worktree '${name}'`;
    } catch (e) {
      this.events.emit("worktree.remove.failed", wt.task_id !== null ? { id: wt.task_id } : {}, { name, path: wt.path }, String(e));
      throw e;
    }
  }

  keep(name: string): string {
    const wt = this.find(name);
    if (!wt) return `Error: Unknown worktree '${name}'`;
    const idx = this.loadIndex();
    let kept: WorktreeEntry | undefined;
    for (const item of idx.worktrees) {
      if (item.name === name) { item.status = "kept"; item.kept_at = Date.now() / 1000; kept = item; }
    }
    this.saveIndex(idx);
    this.events.emit("worktree.keep", wt.task_id !== null ? { id: wt.task_id } : {}, { name, path: wt.path, status: "kept" });
    return kept ? JSON.stringify(kept, null, 2) : `Error: Unknown worktree '${name}'`;
  }
}

const WORKTREES = new WorktreeManager(REPO_ROOT, TASKS, EVENTS);

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
    const limited = (limit && limit < lines.length) ? [...lines.slice(0, limit), `... (${lines.length - limit} more)`] : lines;
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
  bash:               (kw) => runBash(kw.command as string),
  read_file:          (kw) => runRead(kw.path as string, kw.limit as number | undefined),
  write_file:         (kw) => runWrite(kw.path as string, kw.content as string),
  edit_file:          (kw) => runEdit(kw.path as string, kw.old_text as string, kw.new_text as string),
  task_create:        (kw) => TASKS.create(kw.subject as string, kw.description as string | undefined),
  task_list:          () => TASKS.listAll(),
  task_get:           (kw) => TASKS.get(kw.task_id as number),
  task_update:        (kw) => TASKS.update(kw.task_id as number, kw.status as string | undefined, kw.owner as string | undefined),
  task_bind_worktree: (kw) => TASKS.bindWorktree(kw.task_id as number, kw.worktree as string, kw.owner as string | undefined),
  worktree_create:    (kw) => WORKTREES.create(kw.name as string, kw.task_id as number | undefined, kw.base_ref as string | undefined),
  worktree_list:      () => WORKTREES.listAll(),
  worktree_status:    (kw) => WORKTREES.status(kw.name as string),
  worktree_run:       (kw) => WORKTREES.run(kw.name as string, kw.command as string),
  worktree_keep:      (kw) => WORKTREES.keep(kw.name as string),
  worktree_remove:    (kw) => WORKTREES.remove(kw.name as string, kw.force as boolean | undefined, kw.complete_task as boolean | undefined),
  worktree_events:    (kw) => EVENTS.listRecent(kw.limit as number | undefined),
};

const TOOLS: Anthropic.Tool[] = [
  { name: "bash", description: "Run a shell command in the current workspace (blocking).", input_schema: { type: "object" as const, properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "read_file", description: "Read file contents.", input_schema: { type: "object" as const, properties: { path: { type: "string" }, limit: { type: "integer" } }, required: ["path"] } },
  { name: "write_file", description: "Write content to file.", input_schema: { type: "object" as const, properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "edit_file", description: "Replace exact text in file.", input_schema: { type: "object" as const, properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } },
  { name: "task_create", description: "Create a new task on the shared task board.", input_schema: { type: "object" as const, properties: { subject: { type: "string" }, description: { type: "string" } }, required: ["subject"] } },
  { name: "task_list", description: "List all tasks with status, owner, and worktree binding.", input_schema: { type: "object" as const, properties: {} } },
  { name: "task_get", description: "Get task details by ID.", input_schema: { type: "object" as const, properties: { task_id: { type: "integer" } }, required: ["task_id"] } },
  { name: "task_update", description: "Update task status or owner.", input_schema: { type: "object" as const, properties: { task_id: { type: "integer" }, status: { type: "string", enum: ["pending", "in_progress", "completed"] }, owner: { type: "string" } }, required: ["task_id"] } },
  { name: "task_bind_worktree", description: "Bind a task to a worktree name.", input_schema: { type: "object" as const, properties: { task_id: { type: "integer" }, worktree: { type: "string" }, owner: { type: "string" } }, required: ["task_id", "worktree"] } },
  { name: "worktree_create", description: "Create a git worktree and optionally bind it to a task.", input_schema: { type: "object" as const, properties: { name: { type: "string" }, task_id: { type: "integer" }, base_ref: { type: "string" } }, required: ["name"] } },
  { name: "worktree_list", description: "List worktrees tracked in .worktrees/index.json.", input_schema: { type: "object" as const, properties: {} } },
  { name: "worktree_status", description: "Show git status for one worktree.", input_schema: { type: "object" as const, properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "worktree_run", description: "Run a shell command in a named worktree directory.", input_schema: { type: "object" as const, properties: { name: { type: "string" }, command: { type: "string" } }, required: ["name", "command"] } },
  { name: "worktree_remove", description: "Remove a worktree and optionally mark its bound task completed.", input_schema: { type: "object" as const, properties: { name: { type: "string" }, force: { type: "boolean" }, complete_task: { type: "boolean" } }, required: ["name"] } },
  { name: "worktree_keep", description: "Mark a worktree as kept in lifecycle state without removing it.", input_schema: { type: "object" as const, properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "worktree_events", description: "List recent worktree/task lifecycle events from .worktrees/events.jsonl.", input_schema: { type: "object" as const, properties: { limit: { type: "integer" } } } },
];

async function agentLoop(messages: Anthropic.MessageParam[]): Promise<void> {
  while (true) {
    const response = await client.messages.create({ model: MODEL, system: SYSTEM, messages, tools: TOOLS, max_tokens: 8000 });
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") return;
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        const handler = TOOL_HANDLERS[block.name];
        let output: string;
        try { output = handler ? handler(block.input as ToolInput) : `Unknown tool: ${block.name}`; }
        catch (e) { output = `Error: ${e}`; }
        process.stdout.write(`> ${block.name}: ${String(output).slice(0, 200)}\n`);
        results.push({ type: "tool_result", tool_use_id: block.id, content: String(output) });
      }
    }
    messages.push({ role: "user", content: results });
  }
}

async function main() {
  process.stdout.write(`Repo root for s12: ${REPO_ROOT}\n`);
  if (!WORKTREES.gitAvailable) process.stdout.write("Note: Not in a git repo. worktree_* tools will return errors.\n");

  const history: Anthropic.MessageParam[] = [];
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = () => new Promise<string>((resolve) => rl.question("\x1b[36ms12 >> \x1b[0m", resolve));

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
