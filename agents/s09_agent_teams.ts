#!/usr/bin/env tsx
/**
 * s09_agent_teams.ts - Agent Teams
 *
 * Persistent named agents with file-based JSONL inboxes. Each teammate runs
 * its own agent loop in a separate Worker thread. Communication via append-only inboxes.
 *
 *     Subagent (s04):  spawn -> execute -> return summary -> destroyed
 *     Teammate (s09):  spawn -> work -> idle -> work -> ... -> shutdown
 *
 *     .team/config.json                   .team/inbox/
 *     +----------------------------+      +------------------+
 *     | {"team_name": "default",   |      | alice.jsonl      |
 *     |  "members": [              |      | bob.jsonl        |
 *     |    {"name":"alice",        |      | lead.jsonl       |
 *     |     "role":"coder",        |      +------------------+
 *     |     "status":"idle"}       |
 *     |  ]}                        |
 *     +----------------------------+
 *
 * Key insight: "Teammates that can talk to each other."
 */

import Anthropic from "@anthropic-ai/sdk";
import * as dotenv from "dotenv";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { Worker, isMainThread, parentPort, workerData } from "worker_threads";

dotenv.config({ override: true });

const WORKDIR = process.cwd();
const TEAM_DIR = path.join(WORKDIR, ".team");
const INBOX_DIR = path.join(TEAM_DIR, "inbox");

const VALID_MSG_TYPES = new Set([
  "message", "broadcast", "shutdown_request", "shutdown_response", "plan_approval_response",
]);

// -- MessageBus: JSONL inbox per teammate --
class MessageBus {
  constructor(private inboxDir: string) {
    fs.mkdirSync(inboxDir, { recursive: true });
  }

  send(sender: string, to: string, content: string, msgType = "message", extra?: Record<string, unknown>): string {
    if (!VALID_MSG_TYPES.has(msgType)) {
      return `Error: Invalid type '${msgType}'. Valid: ${[...VALID_MSG_TYPES].join(", ")}`;
    }
    const msg: Record<string, unknown> = {
      type: msgType, from: sender, content, timestamp: Date.now() / 1000,
    };
    if (extra) Object.assign(msg, extra);
    const inboxPath = path.join(this.inboxDir, `${to}.jsonl`);
    fs.appendFileSync(inboxPath, JSON.stringify(msg) + "\n", "utf-8");
    return `Sent ${msgType} to ${to}`;
  }

  readInbox(name: string): Record<string, unknown>[] {
    const inboxPath = path.join(this.inboxDir, `${name}.jsonl`);
    if (!fs.existsSync(inboxPath)) return [];
    const msgs = fs.readFileSync(inboxPath, "utf-8")
      .trim().split("\n").filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    fs.writeFileSync(inboxPath, "", "utf-8");
    return msgs;
  }

  broadcast(sender: string, content: string, teammates: string[]): string {
    let count = 0;
    for (const name of teammates) {
      if (name !== sender) { this.send(sender, name, content, "broadcast"); count++; }
    }
    return `Broadcast to ${count} teammates`;
  }
}

const BUS = new MessageBus(INBOX_DIR);

interface TeamMember {
  name: string;
  role: string;
  status: "working" | "idle" | "shutdown";
}

interface TeamConfig {
  team_name: string;
  members: TeamMember[];
}

// -- TeammateManager: persistent named agents with config.json --
class TeammateManager {
  private configPath: string;
  private config: TeamConfig;

  constructor(private teamDir: string) {
    fs.mkdirSync(teamDir, { recursive: true });
    this.configPath = path.join(teamDir, "config.json");
    this.config = this.loadConfig();
  }

  private loadConfig(): TeamConfig {
    if (fs.existsSync(this.configPath)) {
      return JSON.parse(fs.readFileSync(this.configPath, "utf-8")) as TeamConfig;
    }
    return { team_name: "default", members: [] };
  }

  private saveConfig(): void {
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), "utf-8");
  }

  private findMember(name: string): TeamMember | undefined {
    return this.config.members.find((m) => m.name === name);
  }

  spawn(name: string, role: string, prompt: string): string {
    let member = this.findMember(name);
    if (member) {
      if (!["idle", "shutdown"].includes(member.status)) {
        return `Error: '${name}' is currently ${member.status}`;
      }
      member.status = "working";
      member.role = role;
    } else {
      member = { name, role, status: "working" };
      this.config.members.push(member);
    }
    this.saveConfig();

    // Run teammate in worker thread
    const worker = new Worker(__filename, {
      workerData: { mode: "teammate", name, role, prompt, workdir: WORKDIR, teamDir: this.teamDir, inboxDir: INBOX_DIR },
    });
    worker.on("exit", () => {
      // Worker exited - update status if still working
      const m = this.findMember(name);
      if (m && m.status === "working") {
        m.status = "idle";
        this.saveConfig();
      }
    });
    return `Spawned '${name}' (role: ${role})`;
  }

  listAll(): string {
    if (!this.config.members.length) return "No teammates.";
    // Re-read config to get latest status
    this.config = this.loadConfig();
    const lines = [`Team: ${this.config.team_name}`];
    for (const m of this.config.members) {
      lines.push(`  ${m.name} (${m.role}): ${m.status}`);
    }
    return lines.join("\n");
  }

  memberNames(): string[] {
    return this.config.members.map((m) => m.name);
  }
}

const TEAM = new TeammateManager(TEAM_DIR);

type ToolInput = Record<string, unknown>;

function safePath(p: string, workdir = WORKDIR): string {
  const resolved = path.resolve(workdir, p);
  if (!resolved.startsWith(workdir)) throw new Error(`Path escapes workspace: ${p}`);
  return resolved;
}

function runBash(command: string, cwd = WORKDIR): string {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot"];
  if (dangerous.some((d) => command.includes(d))) return "Error: Dangerous command blocked";
  const result = spawnSync("bash", ["-c", command], { cwd, timeout: 120000, encoding: "utf-8" });
  if (result.error?.message?.includes("ETIMEDOUT")) return "Error: Timeout (120s)";
  const out = ((result.stdout || "") + (result.stderr || "")).trim();
  return (out || "(no output)").slice(0, 50000);
}

function runRead(filePath: string, workdir = WORKDIR): string {
  try {
    return fs.readFileSync(safePath(filePath, workdir), "utf-8").slice(0, 50000);
  } catch (e) { return `Error: ${e}`; }
}

function runWrite(filePath: string, content: string, workdir = WORKDIR): string {
  try {
    const fp = safePath(filePath, workdir);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content, "utf-8");
    return `Wrote ${content.length} bytes`;
  } catch (e) { return `Error: ${e}`; }
}

function runEdit(filePath: string, oldText: string, newText: string, workdir = WORKDIR): string {
  try {
    const fp = safePath(filePath, workdir);
    const content = fs.readFileSync(fp, "utf-8");
    if (!content.includes(oldText)) return `Error: Text not found in ${filePath}`;
    fs.writeFileSync(fp, content.replace(oldText, newText), "utf-8");
    return `Edited ${filePath}`;
  } catch (e) { return `Error: ${e}`; }
}

// -- Lead tool dispatch --
const TOOL_HANDLERS: Record<string, (kw: ToolInput) => string> = {
  bash:           (kw) => runBash(kw.command as string),
  read_file:      (kw) => runRead(kw.path as string),
  write_file:     (kw) => runWrite(kw.path as string, kw.content as string),
  edit_file:      (kw) => runEdit(kw.path as string, kw.old_text as string, kw.new_text as string),
  spawn_teammate: (kw) => TEAM.spawn(kw.name as string, kw.role as string, kw.prompt as string),
  list_teammates: () => TEAM.listAll(),
  send_message:   (kw) => BUS.send("lead", kw.to as string, kw.content as string, (kw.msg_type as string) || "message"),
  read_inbox:     () => JSON.stringify(BUS.readInbox("lead"), null, 2),
  broadcast:      (kw) => BUS.broadcast("lead", kw.content as string, TEAM.memberNames()),
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
  { name: "spawn_teammate", description: "Spawn a persistent teammate that runs in its own thread.",
    input_schema: { type: "object" as const, properties: { name: { type: "string" }, role: { type: "string" }, prompt: { type: "string" } }, required: ["name", "role", "prompt"] } },
  { name: "list_teammates", description: "List all teammates with name, role, status.",
    input_schema: { type: "object" as const, properties: {} } },
  { name: "send_message", description: "Send a message to a teammate's inbox.",
    input_schema: { type: "object" as const, properties: { to: { type: "string" }, content: { type: "string" }, msg_type: { type: "string", enum: [...VALID_MSG_TYPES] } }, required: ["to", "content"] } },
  { name: "read_inbox", description: "Read and drain the lead's inbox.",
    input_schema: { type: "object" as const, properties: {} } },
  { name: "broadcast", description: "Send a message to all teammates.",
    input_schema: { type: "object" as const, properties: { content: { type: "string" } }, required: ["content"] } },
];

async function agentLoop(messages: Anthropic.MessageParam[], system: string, tools: Anthropic.Tool[]): Promise<void> {
  while (true) {
    const inbox = BUS.readInbox("lead");
    if (inbox.length) {
      messages.push({ role: "user", content: `<inbox>${JSON.stringify(inbox, null, 2)}</inbox>` });
      messages.push({ role: "assistant", content: "Noted inbox messages." });
    }
    const response = await client.messages.create({
      model: MODEL, system, messages, tools, max_tokens: 8000,
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

// -- Worker thread: teammate loop --
if (!isMainThread) {
  const { mode, name, role, prompt, workdir, inboxDir } = workerData as {
    mode: string; name: string; role: string; prompt: string;
    workdir: string; teamDir: string; inboxDir: string;
  };

  if (mode === "teammate") {
    const client2 = new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL });
    const model2 = process.env.MODEL_ID!;
    const bus = new MessageBus(inboxDir);

    const sysPrompt = `You are '${name}', role: ${role}, at ${workdir}. Use send_message to communicate. Complete your task.`;
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];
    const tools: Anthropic.Tool[] = [
      { name: "bash", description: "Run a shell command.",
        input_schema: { type: "object" as const, properties: { command: { type: "string" } }, required: ["command"] } },
      { name: "read_file", description: "Read file contents.",
        input_schema: { type: "object" as const, properties: { path: { type: "string" } }, required: ["path"] } },
      { name: "write_file", description: "Write content to file.",
        input_schema: { type: "object" as const, properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
      { name: "edit_file", description: "Replace exact text in file.",
        input_schema: { type: "object" as const, properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } },
      { name: "send_message", description: "Send message to a teammate.",
        input_schema: { type: "object" as const, properties: { to: { type: "string" }, content: { type: "string" }, msg_type: { type: "string", enum: [...VALID_MSG_TYPES] } }, required: ["to", "content"] } },
      { name: "read_inbox", description: "Read and drain your inbox.",
        input_schema: { type: "object" as const, properties: {} } },
    ];

    (async () => {
      for (let i = 0; i < 50; i++) {
        const inbox = bus.readInbox(name);
        for (const msg of inbox) {
          messages.push({ role: "user", content: JSON.stringify(msg) });
        }
        let response: Anthropic.Message;
        try {
          response = await client2.messages.create({
            model: model2, system: sysPrompt, messages, tools, max_tokens: 8000,
          });
        } catch { break; }
        messages.push({ role: "assistant", content: response.content });
        if (response.stop_reason !== "tool_use") break;
        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const block of response.content) {
          if (block.type === "tool_use") {
            let output: string;
            if (block.name === "bash") output = runBash((block.input as ToolInput).command as string, workdir);
            else if (block.name === "read_file") output = runRead((block.input as ToolInput).path as string, workdir);
            else if (block.name === "write_file") output = runWrite((block.input as ToolInput).path as string, (block.input as ToolInput).content as string, workdir);
            else if (block.name === "edit_file") output = runEdit((block.input as ToolInput).path as string, (block.input as ToolInput).old_text as string, (block.input as ToolInput).new_text as string, workdir);
            else if (block.name === "send_message") output = bus.send(name, (block.input as ToolInput).to as string, (block.input as ToolInput).content as string, ((block.input as ToolInput).msg_type as string) || "message");
            else if (block.name === "read_inbox") output = JSON.stringify(bus.readInbox(name), null, 2);
            else output = `Unknown tool: ${block.name}`;
            process.stdout.write(`  [${name}] ${block.name}: ${String(output).slice(0, 120)}\n`);
            results.push({ type: "tool_result", tool_use_id: block.id, content: String(output) });
          }
        }
        messages.push({ role: "user", content: results });
      }
      parentPort?.postMessage({ status: "done" });
    })().catch(() => parentPort?.postMessage({ status: "error" }));
  }
}

// -- Main thread --
const client = new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL });
const MODEL = process.env.MODEL_ID!;
const SYSTEM = `You are a team lead at ${WORKDIR}. Spawn teammates and communicate via inboxes.`;

async function main() {
  if (!isMainThread) return;
  const history: Anthropic.MessageParam[] = [];
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = () => new Promise<string>((resolve) => rl.question("\x1b[36ms09 >> \x1b[0m", resolve));

  while (true) {
    let query: string;
    try { query = await ask(); } catch { break; }
    if (["q", "exit", ""].includes(query.trim().toLowerCase())) break;
    if (query.trim() === "/team") { process.stdout.write(TEAM.listAll() + "\n"); continue; }
    if (query.trim() === "/inbox") { process.stdout.write(JSON.stringify(BUS.readInbox("lead"), null, 2) + "\n"); continue; }
    history.push({ role: "user", content: query });
    await agentLoop(history, SYSTEM, TOOLS);
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
