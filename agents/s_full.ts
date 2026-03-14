#!/usr/bin/env tsx
/**
 * s_full.ts - Full Reference Agent
 *
 * Capstone implementation combining every mechanism from s01-s11.
 * Session s12 (task-aware worktree isolation) is taught separately.
 * NOT a teaching session -- this is the "put it all together" reference.
 *
 *     +------------------------------------------------------------------+
 *     |                        FULL AGENT                                 |
 *     |                                                                   |
 *     |  System prompt (s05 skills, task-first + optional todo nag)      |
 *     |                                                                   |
 *     |  Before each LLM call:                                            |
 *     |  +--------------------+  +------------------+  +--------------+  |
 *     |  | Microcompact (s06) |  | Drain bg (s08)   |  | Check inbox  |  |
 *     |  | Auto-compact (s06) |  | notifications    |  | (s09)        |  |
 *     |  +--------------------+  +------------------+  +--------------+  |
 *     |                                                                   |
 *     |  Tool dispatch (s02 pattern):                                     |
 *     |  +--------+----------+----------+---------+-----------+          |
 *     |  | bash   | read     | write    | edit    | TodoWrite |          |
 *     |  | task   | load_sk  | compress | bg_run  | bg_check  |          |
 *     |  | t_crt  | t_get    | t_upd    | t_list  | spawn_tm  |          |
 *     |  | list_tm| send_msg | rd_inbox | bcast   | shutdown  |          |
 *     |  | plan   | idle     | claim    |         |           |          |
 *     |  +--------+----------+----------+---------+-----------+          |
 *     |                                                                   |
 *     |  Subagent (s04):  spawn -> work -> return summary                 |
 *     |  Teammate (s09):  spawn -> work -> idle -> auto-claim (s11)      |
 *     |  Shutdown (s10):  request_id handshake                            |
 *     |  Plan gate (s10): submit -> approve/reject                        |
 *     +------------------------------------------------------------------+
 *
 *     REPL commands: /compact /tasks /team /inbox
 */

import Anthropic from "@anthropic-ai/sdk";
import * as dotenv from "dotenv";
import { spawnSync, exec } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { Worker, isMainThread, parentPort, workerData } from "worker_threads";
import { randomUUID } from "crypto";

dotenv.config({ override: true });

const WORKDIR = process.cwd();
const TEAM_DIR = path.join(WORKDIR, ".team");
const INBOX_DIR = path.join(TEAM_DIR, "inbox");
const TASKS_DIR = path.join(WORKDIR, ".tasks");
const SKILLS_DIR = path.join(WORKDIR, "skills");
const TRANSCRIPT_DIR = path.join(WORKDIR, ".transcripts");
const TOKEN_THRESHOLD = 100000;
const POLL_INTERVAL = 5000;
const IDLE_TIMEOUT = 60000;

const VALID_MSG_TYPES = new Set([
  "message", "broadcast", "shutdown_request", "shutdown_response", "plan_approval_response",
]);

// === SECTION: base_tools ===
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
    return `Wrote ${content.length} bytes to ${filePath}`;
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


// === SECTION: todos (s03) ===
interface TodoItem { content: string; status: "pending" | "in_progress" | "completed"; activeForm: string; }

class TodoManager {
  private items: TodoItem[] = [];

  update(items: Array<Record<string, unknown>>): string {
    const validated: TodoItem[] = [];
    let ip = 0;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const content = String(item.content || "").trim();
      const status = String(item.status || "pending").toLowerCase() as TodoItem["status"];
      const af = String(item.activeForm || "").trim();
      if (!content) throw new Error(`Item ${i}: content required`);
      if (!["pending", "in_progress", "completed"].includes(status)) throw new Error(`Item ${i}: invalid status '${status}'`);
      if (!af) throw new Error(`Item ${i}: activeForm required`);
      if (status === "in_progress") ip++;
      validated.push({ content, status, activeForm: af });
    }
    if (validated.length > 20) throw new Error("Max 20 todos");
    if (ip > 1) throw new Error("Only one in_progress allowed");
    this.items = validated;
    return this.render();
  }

  render(): string {
    if (!this.items.length) return "No todos.";
    const lines = this.items.map((item) => {
      const m = { completed: "[x]", in_progress: "[>]", pending: "[ ]" }[item.status] || "[?]";
      const suffix = item.status === "in_progress" ? ` <- ${item.activeForm}` : "";
      return `${m} ${item.content}${suffix}`;
    });
    const done = this.items.filter((t) => t.status === "completed").length;
    lines.push(`\n(${done}/${this.items.length} completed)`);
    return lines.join("\n");
  }

  hasOpenItems(): boolean { return this.items.some((t) => t.status !== "completed"); }
}


// === SECTION: subagent (s04) ===
async function runSubagent(client: Anthropic, model: string, prompt: string, agentType = "Explore"): Promise<string> {
  const subTools: Anthropic.Tool[] = [
    { name: "bash", description: "Run command.", input_schema: { type: "object" as const, properties: { command: { type: "string" } }, required: ["command"] } },
    { name: "read_file", description: "Read file.", input_schema: { type: "object" as const, properties: { path: { type: "string" } }, required: ["path"] } },
  ];
  if (agentType !== "Explore") {
    subTools.push(
      { name: "write_file", description: "Write file.", input_schema: { type: "object" as const, properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
      { name: "edit_file", description: "Edit file.", input_schema: { type: "object" as const, properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } },
    );
  }
  const subHandlers: Record<string, (kw: ToolInput) => string> = {
    bash: (kw) => runBash(kw.command as string),
    read_file: (kw) => runRead(kw.path as string),
    write_file: (kw) => runWrite(kw.path as string, kw.content as string),
    edit_file: (kw) => runEdit(kw.path as string, kw.old_text as string, kw.new_text as string),
  };
  const subMsgs: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];
  let resp: Anthropic.Message | null = null;
  for (let i = 0; i < 30; i++) {
    resp = await client.messages.create({ model, messages: subMsgs, tools: subTools, max_tokens: 8000 });
    subMsgs.push({ role: "assistant", content: resp.content });
    if (resp.stop_reason !== "tool_use") break;
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const b of resp.content) {
      if (b.type === "tool_use") {
        const h = subHandlers[b.name];
        results.push({ type: "tool_result", tool_use_id: b.id, content: String(h ? h(b.input as ToolInput) : "Unknown tool").slice(0, 50000) });
      }
    }
    subMsgs.push({ role: "user", content: results });
  }
  if (!resp) return "(subagent failed)";
  return resp.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("") || "(no summary)";
}


// === SECTION: skills (s05) ===
class SkillLoader {
  private skills: Map<string, { meta: Record<string, string>; body: string }> = new Map();

  constructor(skillsDir: string) {
    if (fs.existsSync(skillsDir)) this.findSkillFiles(skillsDir).sort().forEach((f) => this.loadSkill(f));
  }

  private findSkillFiles(dir: string): string[] {
    const results: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) results.push(...this.findSkillFiles(full));
      else if (entry.name === "SKILL.md") results.push(full);
    }
    return results;
  }

  private loadSkill(filePath: string): void {
    const text = fs.readFileSync(filePath, "utf-8");
    const match = text.match(/^---\n(.*?)\n---\n(.*)/s);
    const meta: Record<string, string> = {};
    let body = text;
    if (match) {
      for (const line of match[1].trim().split("\n")) {
        const idx = line.indexOf(":");
        if (idx !== -1) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
      body = match[2].trim();
    }
    const name = meta.name || path.basename(path.dirname(filePath));
    this.skills.set(name, { meta, body });
  }

  descriptions(): string {
    if (!this.skills.size) return "(no skills)";
    return [...this.skills.entries()].map(([n, s]) => `  - ${n}: ${s.meta.description || "-"}`).join("\n");
  }

  load(name: string): string {
    const s = this.skills.get(name);
    if (!s) return `Error: Unknown skill '${name}'. Available: ${[...this.skills.keys()].join(", ")}`;
    return `<skill name="${name}">\n${s.body}\n</skill>`;
  }
}


// === SECTION: compression (s06) ===
function estimateTokens(messages: Anthropic.MessageParam[]): number {
  return JSON.stringify(messages).length / 4;
}

function microcompact(messages: Anthropic.MessageParam[]): void {
  const indices: Record<string, unknown>[] = [];
  for (const msg of messages) {
    if (msg.role === "user" && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (typeof part === "object" && part !== null && (part as unknown as Record<string, unknown>).type === "tool_result")
          indices.push(part as unknown as Record<string, unknown>);
      }
    }
  }
  if (indices.length <= 3) return;
  for (const part of indices.slice(0, indices.length - 3)) {
    if (typeof part.content === "string" && part.content.length > 100) part.content = "[cleared]";
  }
}

async function autoCompact(client: Anthropic, model: string, messages: Anthropic.MessageParam[]): Promise<Anthropic.MessageParam[]> {
  fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  const transcriptPath = path.join(TRANSCRIPT_DIR, `transcript_${Date.now()}.jsonl`);
  fs.writeFileSync(transcriptPath, messages.map((m) => JSON.stringify(m)).join("\n"), "utf-8");
  const convText = JSON.stringify(messages).slice(0, 80000);
  const resp = await client.messages.create({
    model, messages: [{ role: "user", content: `Summarize for continuity:\n${convText}` }], max_tokens: 2000,
  });
  const summary = (resp.content[0] as Anthropic.TextBlock).text;
  return [
    { role: "user", content: `[Compressed. Transcript: ${transcriptPath}]\n${summary}` },
    { role: "assistant", content: "Understood. Continuing with summary context." },
  ];
}


// === SECTION: file_tasks (s07) ===
interface TaskRecord {
  id: number; subject: string; description: string;
  status: string; owner: string | null; blockedBy: number[]; blocks: number[];
}

class TaskManager {
  constructor() { fs.mkdirSync(TASKS_DIR, { recursive: true }); }

  private nextId(): number {
    const ids = fs.readdirSync(TASKS_DIR).filter((f) => /^task_\d+\.json$/.test(f)).map((f) => parseInt(f.split("_")[1]));
    return (ids.length ? Math.max(...ids) : 0) + 1;
  }

  private load(id: number): TaskRecord {
    const p = path.join(TASKS_DIR, `task_${id}.json`);
    if (!fs.existsSync(p)) throw new Error(`Task ${id} not found`);
    return JSON.parse(fs.readFileSync(p, "utf-8")) as TaskRecord;
  }

  private save(task: TaskRecord): void { fs.writeFileSync(path.join(TASKS_DIR, `task_${task.id}.json`), JSON.stringify(task, null, 2), "utf-8"); }

  create(subject: string, description = ""): string {
    const task: TaskRecord = { id: this.nextId(), subject, description, status: "pending", owner: null, blockedBy: [], blocks: [] };
    this.save(task);
    return JSON.stringify(task, null, 2);
  }

  get(id: number): string { return JSON.stringify(this.load(id), null, 2); }

  update(id: number, status?: string, addBlockedBy?: number[], addBlocks?: number[]): string {
    const task = this.load(id);
    if (status) {
      task.status = status;
      if (status === "completed") {
        for (const f of fs.readdirSync(TASKS_DIR).filter((f) => /^task_\d+\.json$/.test(f))) {
          const t = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, f), "utf-8")) as TaskRecord;
          if (t.blockedBy.includes(id)) { t.blockedBy = t.blockedBy.filter((i) => i !== id); this.save(t); }
        }
      }
      if (status === "deleted") { try { fs.unlinkSync(path.join(TASKS_DIR, `task_${id}.json`)); } catch {} return `Task ${id} deleted`; }
    }
    if (addBlockedBy) task.blockedBy = [...new Set([...task.blockedBy, ...addBlockedBy])];
    if (addBlocks) task.blocks = [...new Set([...task.blocks, ...addBlocks])];
    this.save(task);
    return JSON.stringify(task, null, 2);
  }

  listAll(): string {
    const files = fs.readdirSync(TASKS_DIR).filter((f) => /^task_\d+\.json$/.test(f)).sort();
    if (!files.length) return "No tasks.";
    const markers: Record<string, string> = { pending: "[ ]", in_progress: "[>]", completed: "[x]" };
    return files.map((f) => {
      const t = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, f), "utf-8")) as TaskRecord;
      const m = markers[t.status] || "[?]";
      const owner = t.owner ? ` @${t.owner}` : "";
      const blocked = t.blockedBy.length ? ` (blocked by: ${JSON.stringify(t.blockedBy)})` : "";
      return `${m} #${t.id}: ${t.subject}${owner}${blocked}`;
    }).join("\n");
  }

  claim(id: number, owner: string): string {
    const task = this.load(id);
    task.owner = owner; task.status = "in_progress";
    this.save(task);
    return `Claimed task #${id} for ${owner}`;
  }
}


// === SECTION: background (s08) ===
interface BgTask { status: string; command: string; result: string | null; }
interface Notification { task_id: string; status: string; result: string; }

class BackgroundManager {
  private tasks: Map<string, BgTask> = new Map();
  private notifications: Notification[] = [];

  run(command: string, timeout = 120): string {
    const tid = randomUUID().slice(0, 8);
    this.tasks.set(tid, { status: "running", command, result: null });
    exec(command, { cwd: WORKDIR, timeout: timeout * 1000 }, (error, stdout, stderr) => {
      const task = this.tasks.get(tid)!;
      if (error && error.killed) {
        task.status = "error"; task.result = `Error: Timeout (${timeout}s)`;
      } else {
        task.status = "completed"; task.result = ((stdout || "") + (stderr || "")).trim().slice(0, 50000) || "(no output)";
      }
      this.notifications.push({ task_id: tid, status: task.status, result: task.result!.slice(0, 500) });
    });
    return `Background task ${tid} started: ${command.slice(0, 80)}`;
  }

  check(tid?: string): string {
    if (tid) {
      const t = this.tasks.get(tid);
      return t ? `[${t.status}] ${t.result || "(running)"}` : `Unknown: ${tid}`;
    }
    return [...this.tasks.entries()].map(([k, v]) => `${k}: [${v.status}] ${v.command.slice(0, 60)}`).join("\n") || "No bg tasks.";
  }

  drain(): Notification[] { const notifs = [...this.notifications]; this.notifications.length = 0; return notifs; }
}


// === SECTION: messaging (s09) ===
class MessageBus {
  constructor() { fs.mkdirSync(INBOX_DIR, { recursive: true }); }

  send(sender: string, to: string, content: string, msgType = "message", extra?: Record<string, unknown>): string {
    const msg: Record<string, unknown> = { type: msgType, from: sender, content, timestamp: Date.now() / 1000 };
    if (extra) Object.assign(msg, extra);
    fs.appendFileSync(path.join(INBOX_DIR, `${to}.jsonl`), JSON.stringify(msg) + "\n", "utf-8");
    return `Sent ${msgType} to ${to}`;
  }

  readInbox(name: string): Record<string, unknown>[] {
    const p = path.join(INBOX_DIR, `${name}.jsonl`);
    if (!fs.existsSync(p)) return [];
    const msgs = fs.readFileSync(p, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    fs.writeFileSync(p, "", "utf-8");
    return msgs;
  }

  broadcast(sender: string, content: string, names: string[]): string {
    let count = 0;
    for (const n of names) { if (n !== sender) { this.send(sender, n, content, "broadcast"); count++; } }
    return `Broadcast to ${count} teammates`;
  }
}


// === SECTION: shutdown + plan tracking (s10) ===
const shutdownRequests: Map<string, { target: string; status: string }> = new Map();
const planRequests: Map<string, { from: string; plan: string; status: string }> = new Map();


// === SECTION: team (s09/s11) ===
interface TeamMember { name: string; role: string; status: string; }
interface TeamConfig { team_name: string; members: TeamMember[]; }

class TeammateManager {
  private configPath: string;
  private config: TeamConfig;

  constructor(private bus: MessageBus, private taskMgr: TaskManager) {
    fs.mkdirSync(TEAM_DIR, { recursive: true });
    this.configPath = path.join(TEAM_DIR, "config.json");
    this.config = this.loadConfig();
  }

  private loadConfig(): TeamConfig {
    if (fs.existsSync(this.configPath)) return JSON.parse(fs.readFileSync(this.configPath, "utf-8")) as TeamConfig;
    return { team_name: "default", members: [] };
  }

  private saveConfig(): void { fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), "utf-8"); }

  private findMember(name: string): TeamMember | undefined { return this.config.members.find((m) => m.name === name); }

  private setStatus(name: string, status: string): void {
    const m = this.findMember(name);
    if (m) { m.status = status; this.saveConfig(); }
  }

  spawn(name: string, role: string, prompt: string): string {
    let member = this.findMember(name);
    if (member) {
      if (!["idle", "shutdown"].includes(member.status)) return `Error: '${name}' is currently ${member.status}`;
      member.status = "working"; member.role = role;
    } else {
      member = { name, role, status: "working" };
      this.config.members.push(member);
    }
    this.saveConfig();
    const worker = new Worker(__filename, {
      workerData: { mode: "teammate", name, role, prompt, workdir: WORKDIR, teamDir: TEAM_DIR, inboxDir: INBOX_DIR, tasksDir: TASKS_DIR, teamName: this.config.team_name },
    });
    worker.on("exit", () => {
      const m = this.findMember(name);
      if (m && m.status === "working") { m.status = "idle"; this.saveConfig(); }
    });
    return `Spawned '${name}' (role: ${role})`;
  }

  listAll(): string {
    if (!this.config.members.length) return "No teammates.";
    this.config = this.loadConfig();
    return [`Team: ${this.config.team_name}`, ...this.config.members.map((m) => `  ${m.name} (${m.role}): ${m.status}`)].join("\n");
  }

  memberNames(): string[] { return this.config.members.map((m) => m.name); }
}


// === SECTION: global_instances ===
const TODO = new TodoManager();
const SKILLS = new SkillLoader(SKILLS_DIR);
const TASK_MGR = new TaskManager();
const BG = new BackgroundManager();
const BUS = new MessageBus();
const TEAM = new TeammateManager(BUS, TASK_MGR);

// === SECTION: system_prompt ===
const SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks.
Prefer task_create/task_update/task_list for multi-step work. Use TodoWrite for short checklists.
Use task for subagent delegation. Use load_skill for specialized knowledge.
Skills: ${SKILLS.descriptions()}`;


// === SECTION: shutdown_protocol (s10) ===
function handleShutdownRequest(teammate: string): string {
  const reqId = randomUUID().slice(0, 8);
  shutdownRequests.set(reqId, { target: teammate, status: "pending" });
  BUS.send("lead", teammate, "Please shut down.", "shutdown_request", { request_id: reqId });
  return `Shutdown request ${reqId} sent to '${teammate}'`;
}

// === SECTION: plan_approval (s10) ===
function handlePlanReview(requestId: string, approve: boolean, feedback = ""): string {
  const req = planRequests.get(requestId);
  if (!req) return `Error: Unknown plan request_id '${requestId}'`;
  req.status = approve ? "approved" : "rejected";
  BUS.send("lead", req.from, feedback, "plan_approval_response", { request_id: requestId, approve, feedback });
  return `Plan ${req.status} for '${req.from}'`;
}


// === SECTION: tool_dispatch (s02) ===
// These are populated after client/model are defined in main
let client: Anthropic;
let MODEL: string;

const TOOL_HANDLERS: Record<string, (kw: ToolInput) => string | Promise<string>> = {
  bash:             (kw) => runBash(kw.command as string),
  read_file:        (kw) => runRead(kw.path as string, kw.limit as number | undefined),
  write_file:       (kw) => runWrite(kw.path as string, kw.content as string),
  edit_file:        (kw) => runEdit(kw.path as string, kw.old_text as string, kw.new_text as string),
  TodoWrite:        (kw) => TODO.update(kw.items as Array<Record<string, unknown>>),
  task:             (kw) => runSubagent(client, MODEL, kw.prompt as string, (kw.agent_type as string) || "Explore"),
  load_skill:       (kw) => SKILLS.load(kw.name as string),
  compress:         () => "Compressing...",
  background_run:   (kw) => BG.run(kw.command as string, kw.timeout as number | undefined),
  check_background: (kw) => BG.check(kw.task_id as string | undefined),
  task_create:      (kw) => TASK_MGR.create(kw.subject as string, kw.description as string | undefined),
  task_get:         (kw) => TASK_MGR.get(kw.task_id as number),
  task_update:      (kw) => TASK_MGR.update(kw.task_id as number, kw.status as string | undefined, kw.add_blocked_by as number[] | undefined, kw.add_blocks as number[] | undefined),
  task_list:        () => TASK_MGR.listAll(),
  spawn_teammate:   (kw) => TEAM.spawn(kw.name as string, kw.role as string, kw.prompt as string),
  list_teammates:   () => TEAM.listAll(),
  send_message:     (kw) => BUS.send("lead", kw.to as string, kw.content as string, (kw.msg_type as string) || "message"),
  read_inbox:       () => JSON.stringify(BUS.readInbox("lead"), null, 2),
  broadcast:        (kw) => BUS.broadcast("lead", kw.content as string, TEAM.memberNames()),
  shutdown_request: (kw) => handleShutdownRequest(kw.teammate as string),
  plan_approval:    (kw) => handlePlanReview(kw.request_id as string, kw.approve as boolean, kw.feedback as string),
  idle:             () => "Lead does not idle.",
  claim_task:       (kw) => TASK_MGR.claim(kw.task_id as number, "lead"),
};

const TOOLS: Anthropic.Tool[] = [
  { name: "bash", description: "Run a shell command.", input_schema: { type: "object" as const, properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "read_file", description: "Read file contents.", input_schema: { type: "object" as const, properties: { path: { type: "string" }, limit: { type: "integer" } }, required: ["path"] } },
  { name: "write_file", description: "Write content to file.", input_schema: { type: "object" as const, properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "edit_file", description: "Replace exact text in file.", input_schema: { type: "object" as const, properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } },
  { name: "TodoWrite", description: "Update task tracking list.", input_schema: { type: "object" as const, properties: { items: { type: "array", items: { type: "object", properties: { content: { type: "string" }, status: { type: "string", enum: ["pending", "in_progress", "completed"] }, activeForm: { type: "string" } }, required: ["content", "status", "activeForm"] } } }, required: ["items"] } },
  { name: "task", description: "Spawn a subagent for isolated exploration or work.", input_schema: { type: "object" as const, properties: { prompt: { type: "string" }, agent_type: { type: "string", enum: ["Explore", "general-purpose"] } }, required: ["prompt"] } },
  { name: "load_skill", description: "Load specialized knowledge by name.", input_schema: { type: "object" as const, properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "compress", description: "Manually compress conversation context.", input_schema: { type: "object" as const, properties: {} } },
  { name: "background_run", description: "Run command in background.", input_schema: { type: "object" as const, properties: { command: { type: "string" }, timeout: { type: "integer" } }, required: ["command"] } },
  { name: "check_background", description: "Check background task status.", input_schema: { type: "object" as const, properties: { task_id: { type: "string" } } } },
  { name: "task_create", description: "Create a persistent file task.", input_schema: { type: "object" as const, properties: { subject: { type: "string" }, description: { type: "string" } }, required: ["subject"] } },
  { name: "task_get", description: "Get task details by ID.", input_schema: { type: "object" as const, properties: { task_id: { type: "integer" } }, required: ["task_id"] } },
  { name: "task_update", description: "Update task status or dependencies.", input_schema: { type: "object" as const, properties: { task_id: { type: "integer" }, status: { type: "string", enum: ["pending", "in_progress", "completed", "deleted"] }, add_blocked_by: { type: "array", items: { type: "integer" } }, add_blocks: { type: "array", items: { type: "integer" } } }, required: ["task_id"] } },
  { name: "task_list", description: "List all tasks.", input_schema: { type: "object" as const, properties: {} } },
  { name: "spawn_teammate", description: "Spawn a persistent autonomous teammate.", input_schema: { type: "object" as const, properties: { name: { type: "string" }, role: { type: "string" }, prompt: { type: "string" } }, required: ["name", "role", "prompt"] } },
  { name: "list_teammates", description: "List all teammates.", input_schema: { type: "object" as const, properties: {} } },
  { name: "send_message", description: "Send a message to a teammate.", input_schema: { type: "object" as const, properties: { to: { type: "string" }, content: { type: "string" }, msg_type: { type: "string", enum: [...VALID_MSG_TYPES] } }, required: ["to", "content"] } },
  { name: "read_inbox", description: "Read and drain the lead's inbox.", input_schema: { type: "object" as const, properties: {} } },
  { name: "broadcast", description: "Send message to all teammates.", input_schema: { type: "object" as const, properties: { content: { type: "string" } }, required: ["content"] } },
  { name: "shutdown_request", description: "Request a teammate to shut down.", input_schema: { type: "object" as const, properties: { teammate: { type: "string" } }, required: ["teammate"] } },
  { name: "plan_approval", description: "Approve or reject a teammate's plan.", input_schema: { type: "object" as const, properties: { request_id: { type: "string" }, approve: { type: "boolean" }, feedback: { type: "string" } }, required: ["request_id", "approve"] } },
  { name: "idle", description: "Enter idle state.", input_schema: { type: "object" as const, properties: {} } },
  { name: "claim_task", description: "Claim a task from the board.", input_schema: { type: "object" as const, properties: { task_id: { type: "integer" } }, required: ["task_id"] } },
];


// === SECTION: agent_loop ===
async function agentLoop(messages: Anthropic.MessageParam[]): Promise<void> {
  let roundsWithoutTodo = 0;
  while (true) {
    // s06: compression pipeline
    microcompact(messages);
    if (estimateTokens(messages) > TOKEN_THRESHOLD) {
      process.stdout.write("[auto-compact triggered]\n");
      const compacted = await autoCompact(client, MODEL, messages);
      messages.splice(0, messages.length, ...compacted);
    }
    // s08: drain background notifications
    const notifs = BG.drain();
    if (notifs.length) {
      const txt = notifs.map((n) => `[bg:${n.task_id}] ${n.status}: ${n.result}`).join("\n");
      messages.push({ role: "user", content: `<background-results>\n${txt}\n</background-results>` });
      messages.push({ role: "assistant", content: "Noted background results." });
    }
    // s10: check lead inbox
    const inbox = BUS.readInbox("lead");
    if (inbox.length) {
      messages.push({ role: "user", content: `<inbox>${JSON.stringify(inbox, null, 2)}</inbox>` });
      messages.push({ role: "assistant", content: "Noted inbox messages." });
    }
    // LLM call
    const response = await client.messages.create({ model: MODEL, system: SYSTEM, messages, tools: TOOLS, max_tokens: 8000 });
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") return;
    // Tool execution
    const results: Anthropic.ToolResultBlockParam[] = [];
    let usedTodo = false;
    let manualCompress = false;
    for (const block of response.content) {
      if (block.type === "tool_use") {
        if (block.name === "compress") manualCompress = true;
        const handler = TOOL_HANDLERS[block.name];
        let output: string;
        try {
          const result = handler ? await handler(block.input as ToolInput) : `Unknown tool: ${block.name}`;
          output = String(result);
        } catch (e) { output = `Error: ${e}`; }
        process.stdout.write(`> ${block.name}: ${output.slice(0, 200)}\n`);
        results.push({ type: "tool_result", tool_use_id: block.id, content: output });
        if (block.name === "TodoWrite") usedTodo = true;
      }
    }
    // s03: nag reminder
    roundsWithoutTodo = usedTodo ? 0 : roundsWithoutTodo + 1;
    if (TODO.hasOpenItems() && roundsWithoutTodo >= 3) {
      results.unshift({ type: "text" as const, text: "<reminder>Update your todos.</reminder>" } as unknown as Anthropic.ToolResultBlockParam);
    }
    messages.push({ role: "user", content: results });
    // s06: manual compress
    if (manualCompress) {
      process.stdout.write("[manual compact]\n");
      const compacted = await autoCompact(client, MODEL, messages);
      messages.splice(0, messages.length, ...compacted);
    }
  }
}


// === SECTION: worker_thread (teammate) ===
if (!isMainThread) {
  const { mode, name, role, prompt, workdir, inboxDir, tasksDir, teamName } = workerData as {
    mode: string; name: string; role: string; prompt: string;
    workdir: string; teamDir: string; inboxDir: string; tasksDir: string; teamName: string;
  };

  if (mode === "teammate") {
    const workerClient = new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL });
    const workerModel = process.env.MODEL_ID!;
    const bus = { send: (s: string, t: string, c: string, mt = "message", extra?: Record<string, unknown>) => {
      const msg: Record<string, unknown> = { type: mt, from: s, content: c, timestamp: Date.now() / 1000 };
      if (extra) Object.assign(msg, extra);
      fs.appendFileSync(path.join(inboxDir, `${t}.jsonl`), JSON.stringify(msg) + "\n", "utf-8");
      return `Sent ${mt} to ${t}`;
    }, readInbox: (n: string) => {
      const p = path.join(inboxDir, `${n}.jsonl`);
      if (!fs.existsSync(p)) return [] as Record<string, unknown>[];
      const msgs = fs.readFileSync(p, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
      fs.writeFileSync(p, "", "utf-8"); return msgs;
    }};

    const configPath = path.join(path.dirname(inboxDir), "config.json");
    function setStatus(status: string): void {
      if (!fs.existsSync(configPath)) return;
      const cfg = JSON.parse(fs.readFileSync(configPath, "utf-8")) as TeamConfig;
      const m = cfg.members.find((m) => m.name === name);
      if (m) { m.status = status; fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), "utf-8"); }
    }

    function workerBash(cmd: string): string {
      const r = spawnSync("bash", ["-c", cmd], { cwd: workdir, timeout: 120000, encoding: "utf-8" });
      return (((r.stdout || "") + (r.stderr || "")).trim() || "(no output)").slice(0, 50000);
    }

    function scanUnclaimed(): Record<string, unknown>[] {
      if (!fs.existsSync(tasksDir)) return [];
      return fs.readdirSync(tasksDir).filter((f) => /^task_\d+\.json$/.test(f)).sort()
        .map((f) => JSON.parse(fs.readFileSync(path.join(tasksDir, f), "utf-8")) as Record<string, unknown>)
        .filter((t) => t.status === "pending" && !t.owner && !(t.blockedBy as unknown[])?.length);
    }

    function workerClaimTask(taskId: number): string {
      const p = path.join(tasksDir, `task_${taskId}.json`);
      if (!fs.existsSync(p)) return `Error: Task ${taskId} not found`;
      const task = JSON.parse(fs.readFileSync(p, "utf-8")) as Record<string, unknown>;
      task.owner = name; task.status = "in_progress";
      fs.writeFileSync(p, JSON.stringify(task, null, 2), "utf-8");
      return `Claimed task #${taskId} for ${name}`;
    }

    const sysPrompt = `You are '${name}', role: ${role}, team: ${teamName}, at ${workdir}. Use idle when done with current work. You may auto-claim tasks.`;
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];
    const tools: Anthropic.Tool[] = [
      { name: "bash", description: "Run command.", input_schema: { type: "object" as const, properties: { command: { type: "string" } }, required: ["command"] } },
      { name: "read_file", description: "Read file.", input_schema: { type: "object" as const, properties: { path: { type: "string" } }, required: ["path"] } },
      { name: "write_file", description: "Write file.", input_schema: { type: "object" as const, properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
      { name: "edit_file", description: "Edit file.", input_schema: { type: "object" as const, properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } },
      { name: "send_message", description: "Send message.", input_schema: { type: "object" as const, properties: { to: { type: "string" }, content: { type: "string" } }, required: ["to", "content"] } },
      { name: "idle", description: "Signal no more work.", input_schema: { type: "object" as const, properties: {} } },
      { name: "claim_task", description: "Claim task by ID.", input_schema: { type: "object" as const, properties: { task_id: { type: "integer" } }, required: ["task_id"] } },
    ];

    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    (async () => {
      while (true) {
        // -- WORK PHASE --
        let idleRequested = false;
        for (let i = 0; i < 50; i++) {
          const inbox = bus.readInbox(name);
          for (const msg of inbox) {
            if ((msg.type as string) === "shutdown_request") { setStatus("shutdown"); parentPort?.postMessage({ status: "done" }); return; }
            messages.push({ role: "user", content: JSON.stringify(msg) });
          }
          let response: Anthropic.Message;
          try { response = await workerClient.messages.create({ model: workerModel, system: sysPrompt, messages, tools, max_tokens: 8000 }); }
          catch { setStatus("shutdown"); parentPort?.postMessage({ status: "done" }); return; }
          messages.push({ role: "assistant", content: response.content });
          if (response.stop_reason !== "tool_use") break;
          const results: Anthropic.ToolResultBlockParam[] = [];
          for (const block of response.content) {
            if (block.type === "tool_use") {
              const inp = block.input as ToolInput;
              let output: string;
              if (block.name === "idle") { idleRequested = true; output = "Entering idle phase."; }
              else if (block.name === "claim_task") output = workerClaimTask(inp.task_id as number);
              else if (block.name === "send_message") output = bus.send(name, inp.to as string, inp.content as string);
              else if (block.name === "bash") output = workerBash(inp.command as string);
              else if (block.name === "read_file") {
                try { output = fs.readFileSync(path.resolve(workdir, inp.path as string), "utf-8").slice(0, 50000); }
                catch (e) { output = `Error: ${e}`; }
              } else if (block.name === "write_file") {
                try {
                  const fp = path.resolve(workdir, inp.path as string);
                  fs.mkdirSync(path.dirname(fp), { recursive: true });
                  fs.writeFileSync(fp, inp.content as string, "utf-8");
                  output = `Wrote ${(inp.content as string).length} bytes`;
                } catch (e) { output = `Error: ${e}`; }
              } else if (block.name === "edit_file") {
                try {
                  const fp = path.resolve(workdir, inp.path as string);
                  const c = fs.readFileSync(fp, "utf-8");
                  if (!c.includes(inp.old_text as string)) output = `Error: Text not found`;
                  else { fs.writeFileSync(fp, c.replace(inp.old_text as string, inp.new_text as string), "utf-8"); output = `Edited ${inp.path}`; }
                } catch (e) { output = `Error: ${e}`; }
              } else output = `Unknown tool: ${block.name}`;
              process.stdout.write(`  [${name}] ${block.name}: ${String(output).slice(0, 120)}\n`);
              results.push({ type: "tool_result", tool_use_id: block.id, content: String(output) });
            }
          }
          messages.push({ role: "user", content: results });
          if (idleRequested) break;
        }
        // -- IDLE PHASE --
        setStatus("idle");
        let resume = false;
        for (let p = 0; p < IDLE_TIMEOUT / POLL_INTERVAL; p++) {
          await sleep(POLL_INTERVAL);
          const inbox = bus.readInbox(name);
          if (inbox.length) {
            for (const msg of inbox) {
              if ((msg.type as string) === "shutdown_request") { setStatus("shutdown"); parentPort?.postMessage({ status: "done" }); return; }
              messages.push({ role: "user", content: JSON.stringify(msg) });
            }
            resume = true; break;
          }
          const unclaimed = scanUnclaimed();
          if (unclaimed.length) {
            const task = unclaimed[0];
            workerClaimTask(task.id as number);
            if (messages.length <= 3) {
              messages.unshift({ role: "user", content: `<identity>You are '${name}', role: ${role}, team: ${teamName}.</identity>` });
              messages.splice(1, 0, { role: "assistant", content: `I am ${name}. Continuing.` });
            }
            messages.push({ role: "user", content: `<auto-claimed>Task #${task.id}: ${task.subject}\n${(task.description as string) || ""}</auto-claimed>` });
            messages.push({ role: "assistant", content: `Claimed task #${task.id}. Working on it.` });
            resume = true; break;
          }
        }
        if (!resume) { setStatus("shutdown"); parentPort?.postMessage({ status: "done" }); return; }
        setStatus("working");
      }
    })().catch(() => parentPort?.postMessage({ status: "error" }));
  }
}


// === SECTION: repl ===
async function main() {
  if (!isMainThread) return;

  client = new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL });
  MODEL = process.env.MODEL_ID!;

  const history: Anthropic.MessageParam[] = [];
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = () => new Promise<string>((resolve) => rl.question("\x1b[36ms_full >> \x1b[0m", resolve));

  while (true) {
    let query: string;
    try { query = await ask(); } catch { break; }
    if (["q", "exit", ""].includes(query.trim().toLowerCase())) break;
    if (query.trim() === "/compact") {
      if (history.length) {
        process.stdout.write("[manual compact via /compact]\n");
        const compacted = await autoCompact(client, MODEL, history);
        history.splice(0, history.length, ...compacted);
      }
      continue;
    }
    if (query.trim() === "/tasks") { process.stdout.write(TASK_MGR.listAll() + "\n"); continue; }
    if (query.trim() === "/team") { process.stdout.write(TEAM.listAll() + "\n"); continue; }
    if (query.trim() === "/inbox") { process.stdout.write(JSON.stringify(BUS.readInbox("lead"), null, 2) + "\n"); continue; }
    history.push({ role: "user", content: query });
    await agentLoop(history);
    // Print final assistant response
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
