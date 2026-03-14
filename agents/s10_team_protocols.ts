#!/usr/bin/env tsx
/**
 * s10_team_protocols.ts - Team Protocols
 *
 * Shutdown protocol and plan approval protocol, both using the same
 * request_id correlation pattern. Builds on s09's team messaging.
 *
 *     Shutdown FSM: pending -> approved | rejected
 *
 *     Lead                              Teammate
 *     +---------------------+          +---------------------+
 *     | shutdown_request     |          |                     |
 *     | {                    | -------> | receives request    |
 *     |   request_id: abc    |          | decides: approve?   |
 *     | }                    |          |                     |
 *     +---------------------+          +---------------------+
 *                                              |
 *     +---------------------+          +-------v-------------+
 *     | shutdown_response    | <------- | shutdown_response   |
 *     | {                    |          | {                   |
 *     |   request_id: abc    |          |   request_id: abc   |
 *     |   approve: true      |          |   approve: true     |
 *     | }                    |          | }                   |
 *     +---------------------+          +---------------------+
 *             |
 *             v
 *     status -> "shutdown", thread stops
 *
 * Key insight: "Same request_id correlation pattern, two domains."
 */

import Anthropic from "@anthropic-ai/sdk";
import * as dotenv from "dotenv";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { Worker, isMainThread, parentPort, workerData } from "worker_threads";
import { randomUUID } from "crypto";

dotenv.config({ override: true });

const WORKDIR = process.cwd();
const TEAM_DIR = path.join(WORKDIR, ".team");
const INBOX_DIR = path.join(TEAM_DIR, "inbox");

const VALID_MSG_TYPES = new Set([
  "message", "broadcast", "shutdown_request", "shutdown_response", "plan_approval_response",
]);

// -- Request trackers --
const shutdownRequests: Map<string, { target: string; status: string }> = new Map();
const planRequests: Map<string, { from: string; plan: string; status: string }> = new Map();

class MessageBus {
  constructor(private inboxDir: string) {
    fs.mkdirSync(inboxDir, { recursive: true });
  }

  send(sender: string, to: string, content: string, msgType = "message", extra?: Record<string, unknown>): string {
    if (!VALID_MSG_TYPES.has(msgType)) {
      return `Error: Invalid type '${msgType}'. Valid: ${[...VALID_MSG_TYPES].join(", ")}`;
    }
    const msg: Record<string, unknown> = { type: msgType, from: sender, content, timestamp: Date.now() / 1000 };
    if (extra) Object.assign(msg, extra);
    fs.appendFileSync(path.join(this.inboxDir, `${to}.jsonl`), JSON.stringify(msg) + "\n", "utf-8");
    return `Sent ${msgType} to ${to}`;
  }

  readInbox(name: string): Record<string, unknown>[] {
    const p = path.join(this.inboxDir, `${name}.jsonl`);
    if (!fs.existsSync(p)) return [];
    const msgs = fs.readFileSync(p, "utf-8").trim().split("\n").filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    fs.writeFileSync(p, "", "utf-8");
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

interface TeamMember { name: string; role: string; status: string; }
interface TeamConfig { team_name: string; members: TeamMember[]; }

class TeammateManager {
  private configPath: string;
  private config: TeamConfig;

  constructor(private teamDir: string) {
    fs.mkdirSync(teamDir, { recursive: true });
    this.configPath = path.join(teamDir, "config.json");
    this.config = this.loadConfig();
  }

  private loadConfig(): TeamConfig {
    if (fs.existsSync(this.configPath)) return JSON.parse(fs.readFileSync(this.configPath, "utf-8")) as TeamConfig;
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
      if (!["idle", "shutdown"].includes(member.status)) return `Error: '${name}' is currently ${member.status}`;
      member.status = "working"; member.role = role;
    } else {
      member = { name, role, status: "working" };
      this.config.members.push(member);
    }
    this.saveConfig();
    const worker = new Worker(__filename, {
      workerData: { mode: "teammate", name, role, prompt, workdir: WORKDIR, teamDir: this.teamDir, inboxDir: INBOX_DIR },
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

const TEAM = new TeammateManager(TEAM_DIR);

type ToolInput = Record<string, unknown>;

function runBash(command: string, cwd = WORKDIR): string {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot"];
  if (dangerous.some((d) => command.includes(d))) return "Error: Dangerous command blocked";
  const result = spawnSync("bash", ["-c", command], { cwd, timeout: 120000, encoding: "utf-8" });
  if (result.error?.message?.includes("ETIMEDOUT")) return "Error: Timeout (120s)";
  const out = ((result.stdout || "") + (result.stderr || "")).trim();
  return (out || "(no output)").slice(0, 50000);
}

function runRead(filePath: string, workdir = WORKDIR): string {
  try { return fs.readFileSync(path.resolve(workdir, filePath), "utf-8").slice(0, 50000); }
  catch (e) { return `Error: ${e}`; }
}

function runWrite(filePath: string, content: string, workdir = WORKDIR): string {
  try {
    const fp = path.resolve(workdir, filePath);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content, "utf-8");
    return `Wrote ${content.length} bytes`;
  } catch (e) { return `Error: ${e}`; }
}

function runEdit(filePath: string, oldText: string, newText: string, workdir = WORKDIR): string {
  try {
    const fp = path.resolve(workdir, filePath);
    const content = fs.readFileSync(fp, "utf-8");
    if (!content.includes(oldText)) return `Error: Text not found in ${filePath}`;
    fs.writeFileSync(fp, content.replace(oldText, newText), "utf-8");
    return `Edited ${filePath}`;
  } catch (e) { return `Error: ${e}`; }
}

// -- Lead-specific protocol handlers --
function handleShutdownRequest(teammate: string): string {
  const reqId = randomUUID().slice(0, 8);
  shutdownRequests.set(reqId, { target: teammate, status: "pending" });
  BUS.send("lead", teammate, "Please shut down gracefully.", "shutdown_request", { request_id: reqId });
  return `Shutdown request ${reqId} sent to '${teammate}' (status: pending)`;
}

function handlePlanReview(requestId: string, approve: boolean, feedback = ""): string {
  const req = planRequests.get(requestId);
  if (!req) return `Error: Unknown plan request_id '${requestId}'`;
  req.status = approve ? "approved" : "rejected";
  BUS.send("lead", req.from, feedback, "plan_approval_response", { request_id: requestId, approve, feedback });
  return `Plan ${req.status} for '${req.from}'`;
}

function checkShutdownStatus(requestId: string): string {
  const req = shutdownRequests.get(requestId);
  return JSON.stringify(req || { error: "not found" });
}

const TOOL_HANDLERS: Record<string, (kw: ToolInput) => string> = {
  bash:              (kw) => runBash(kw.command as string),
  read_file:         (kw) => runRead(kw.path as string),
  write_file:        (kw) => runWrite(kw.path as string, kw.content as string),
  edit_file:         (kw) => runEdit(kw.path as string, kw.old_text as string, kw.new_text as string),
  spawn_teammate:    (kw) => TEAM.spawn(kw.name as string, kw.role as string, kw.prompt as string),
  list_teammates:    () => TEAM.listAll(),
  send_message:      (kw) => BUS.send("lead", kw.to as string, kw.content as string, (kw.msg_type as string) || "message"),
  read_inbox:        () => JSON.stringify(BUS.readInbox("lead"), null, 2),
  broadcast:         (kw) => BUS.broadcast("lead", kw.content as string, TEAM.memberNames()),
  shutdown_request:  (kw) => handleShutdownRequest(kw.teammate as string),
  shutdown_response: (kw) => checkShutdownStatus(kw.request_id as string),
  plan_approval:     (kw) => handlePlanReview(kw.request_id as string, kw.approve as boolean, kw.feedback as string),
};

const TOOLS: Anthropic.Tool[] = [
  { name: "bash", description: "Run a shell command.", input_schema: { type: "object" as const, properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "read_file", description: "Read file contents.", input_schema: { type: "object" as const, properties: { path: { type: "string" }, limit: { type: "integer" } }, required: ["path"] } },
  { name: "write_file", description: "Write content to file.", input_schema: { type: "object" as const, properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "edit_file", description: "Replace exact text in file.", input_schema: { type: "object" as const, properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } },
  { name: "spawn_teammate", description: "Spawn a persistent teammate.", input_schema: { type: "object" as const, properties: { name: { type: "string" }, role: { type: "string" }, prompt: { type: "string" } }, required: ["name", "role", "prompt"] } },
  { name: "list_teammates", description: "List all teammates.", input_schema: { type: "object" as const, properties: {} } },
  { name: "send_message", description: "Send a message to a teammate.", input_schema: { type: "object" as const, properties: { to: { type: "string" }, content: { type: "string" }, msg_type: { type: "string", enum: [...VALID_MSG_TYPES] } }, required: ["to", "content"] } },
  { name: "read_inbox", description: "Read and drain the lead's inbox.", input_schema: { type: "object" as const, properties: {} } },
  { name: "broadcast", description: "Send a message to all teammates.", input_schema: { type: "object" as const, properties: { content: { type: "string" } }, required: ["content"] } },
  { name: "shutdown_request", description: "Request a teammate to shut down gracefully. Returns a request_id for tracking.", input_schema: { type: "object" as const, properties: { teammate: { type: "string" } }, required: ["teammate"] } },
  { name: "shutdown_response", description: "Check the status of a shutdown request by request_id.", input_schema: { type: "object" as const, properties: { request_id: { type: "string" } }, required: ["request_id"] } },
  { name: "plan_approval", description: "Approve or reject a teammate's plan. Provide request_id + approve + optional feedback.", input_schema: { type: "object" as const, properties: { request_id: { type: "string" }, approve: { type: "boolean" }, feedback: { type: "string" } }, required: ["request_id", "approve"] } },
];

// -- Worker thread: teammate with shutdown + plan approval --
if (!isMainThread) {
  const { mode, name, role, prompt, workdir, inboxDir } = workerData as {
    mode: string; name: string; role: string; prompt: string;
    workdir: string; teamDir: string; inboxDir: string;
  };

  if (mode === "teammate") {
    const client2 = new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL });
    const model2 = process.env.MODEL_ID!;
    const bus = new MessageBus(inboxDir);
    const localPlanRequests: Map<string, { from: string; plan: string; status: string }> = new Map();

    const sysPrompt = `You are '${name}', role: ${role}, at ${workdir}. Submit plans via plan_approval before major work. Respond to shutdown_request with shutdown_response.`;
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];
    const tools: Anthropic.Tool[] = [
      { name: "bash", description: "Run a shell command.", input_schema: { type: "object" as const, properties: { command: { type: "string" } }, required: ["command"] } },
      { name: "read_file", description: "Read file contents.", input_schema: { type: "object" as const, properties: { path: { type: "string" } }, required: ["path"] } },
      { name: "write_file", description: "Write content to file.", input_schema: { type: "object" as const, properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
      { name: "edit_file", description: "Replace exact text in file.", input_schema: { type: "object" as const, properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } },
      { name: "send_message", description: "Send message to a teammate.", input_schema: { type: "object" as const, properties: { to: { type: "string" }, content: { type: "string" }, msg_type: { type: "string", enum: [...VALID_MSG_TYPES] } }, required: ["to", "content"] } },
      { name: "read_inbox", description: "Read and drain your inbox.", input_schema: { type: "object" as const, properties: {} } },
      { name: "shutdown_response", description: "Respond to a shutdown request.", input_schema: { type: "object" as const, properties: { request_id: { type: "string" }, approve: { type: "boolean" }, reason: { type: "string" } }, required: ["request_id", "approve"] } },
      { name: "plan_approval", description: "Submit a plan for lead approval.", input_schema: { type: "object" as const, properties: { plan: { type: "string" } }, required: ["plan"] } },
    ];

    (async () => {
      let shouldExit = false;
      for (let i = 0; i < 50 && !shouldExit; i++) {
        const inbox = bus.readInbox(name);
        for (const msg of inbox) messages.push({ role: "user", content: JSON.stringify(msg) });
        let response: Anthropic.Message;
        try { response = await client2.messages.create({ model: model2, system: sysPrompt, messages, tools, max_tokens: 8000 }); }
        catch { break; }
        messages.push({ role: "assistant", content: response.content });
        if (response.stop_reason !== "tool_use") break;
        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const block of response.content) {
          if (block.type === "tool_use") {
            const inp = block.input as ToolInput;
            let output: string;
            if (block.name === "bash") output = runBash(inp.command as string, workdir);
            else if (block.name === "read_file") output = runRead(inp.path as string, workdir);
            else if (block.name === "write_file") output = runWrite(inp.path as string, inp.content as string, workdir);
            else if (block.name === "edit_file") output = runEdit(inp.path as string, inp.old_text as string, inp.new_text as string, workdir);
            else if (block.name === "send_message") output = bus.send(name, inp.to as string, inp.content as string, (inp.msg_type as string) || "message");
            else if (block.name === "read_inbox") output = JSON.stringify(bus.readInbox(name), null, 2);
            else if (block.name === "shutdown_response") {
              const reqId = inp.request_id as string;
              const approve = inp.approve as boolean;
              bus.send(name, "lead", (inp.reason as string) || "", "shutdown_response", { request_id: reqId, approve });
              output = `Shutdown ${approve ? "approved" : "rejected"}`;
              if (approve) shouldExit = true;
            } else if (block.name === "plan_approval") {
              const planText = (inp.plan as string) || "";
              const reqId = randomUUID().slice(0, 8);
              localPlanRequests.set(reqId, { from: name, plan: planText, status: "pending" });
              bus.send(name, "lead", planText, "plan_approval_response", { request_id: reqId, plan: planText });
              output = `Plan submitted (request_id=${reqId}). Waiting for lead approval.`;
            } else output = `Unknown tool: ${block.name}`;
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
const SYSTEM = `You are a team lead at ${WORKDIR}. Manage teammates with shutdown and plan approval protocols.`;

async function agentLoop(messages: Anthropic.MessageParam[]): Promise<void> {
  while (true) {
    const inbox = BUS.readInbox("lead");
    if (inbox.length) {
      messages.push({ role: "user", content: `<inbox>${JSON.stringify(inbox, null, 2)}</inbox>` });
      messages.push({ role: "assistant", content: "Noted inbox messages." });
    }
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
  if (!isMainThread) return;
  const history: Anthropic.MessageParam[] = [];
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = () => new Promise<string>((resolve) => rl.question("\x1b[36ms10 >> \x1b[0m", resolve));

  while (true) {
    let query: string;
    try { query = await ask(); } catch { break; }
    if (["q", "exit", ""].includes(query.trim().toLowerCase())) break;
    if (query.trim() === "/team") { process.stdout.write(TEAM.listAll() + "\n"); continue; }
    if (query.trim() === "/inbox") { process.stdout.write(JSON.stringify(BUS.readInbox("lead"), null, 2) + "\n"); continue; }
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
