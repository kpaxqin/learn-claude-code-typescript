#!/usr/bin/env tsx
/**
 * s06_context_compact.ts - Compact
 *
 * Three-layer compression pipeline so the agent can work forever:
 *
 *     Every turn:
 *     +------------------+
 *     | Tool call result |
 *     +------------------+
 *             |
 *             v
 *     [Layer 1: microCompact]        (silent, every turn)
 *       Replace tool_result content older than last 3
 *       with "[Previous: used {tool_name}]"
 *             |
 *             v
 *     [Check: tokens > 50000?]
 *        |               |
 *        no              yes
 *        |               |
 *        v               v
 *     continue    [Layer 2: autoCompact]
 *                   Save full transcript to .transcripts/
 *                   Ask LLM to summarize conversation.
 *                   Replace all messages with [summary].
 *                         |
 *                         v
 *                 [Layer 3: compact tool]
 *                   Model calls compact -> immediate summarization.
 *                   Same as auto, triggered manually.
 *
 * Key insight: "The agent can forget strategically and keep working forever."
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

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks.`;

const THRESHOLD = 50000;
const TRANSCRIPT_DIR = path.join(WORKDIR, ".transcripts");
const KEEP_RECENT = 3;

function estimateTokens(messages: Anthropic.MessageParam[]): number {
  return JSON.stringify(messages).length / 4;
}

// -- Layer 1: microCompact - replace old tool results with placeholders --
function microCompact(messages: Anthropic.MessageParam[]): void {
  const toolResults: Array<{ msg: Anthropic.MessageParam; part: Record<string, unknown> }> = [];

  for (const msg of messages) {
    if (msg.role === "user" && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (typeof part === "object" && part !== null && (part as unknown as Record<string, unknown>).type === "tool_result") {
          toolResults.push({ msg, part: part as unknown as Record<string, unknown> });
        }
      }
    }
  }

  if (toolResults.length <= KEEP_RECENT) return;

  // Build tool name map from assistant messages
  const toolNameMap: Map<string, string> = new Map();
  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (typeof block === "object" && block !== null && block.type === "tool_use") {
          const b = block as Anthropic.ToolUseBlock;
          toolNameMap.set(b.id, b.name);
        }
      }
    }
  }

  const toClean = toolResults.slice(0, toolResults.length - KEEP_RECENT);
  for (const { part } of toClean) {
    if (typeof part.content === "string" && part.content.length > 100) {
      const toolId = String(part.tool_use_id || "");
      const toolName = toolNameMap.get(toolId) || "unknown";
      part.content = `[Previous: used ${toolName}]`;
    }
  }
}

// -- Layer 2: autoCompact - save transcript, summarize, replace messages --
async function autoCompact(messages: Anthropic.MessageParam[]): Promise<Anthropic.MessageParam[]> {
  fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  const transcriptPath = path.join(TRANSCRIPT_DIR, `transcript_${Date.now()}.jsonl`);
  const lines = messages.map((m) => JSON.stringify(m)).join("\n");
  fs.writeFileSync(transcriptPath, lines, "utf-8");
  process.stdout.write(`[transcript saved: ${transcriptPath}]\n`);

  const conversationText = JSON.stringify(messages).slice(0, 80000);
  const response = await client.messages.create({
    model: MODEL,
    messages: [{ role: "user", content:
      "Summarize this conversation for continuity. Include: " +
      "1) What was accomplished, 2) Current state, 3) Key decisions made. " +
      "Be concise but preserve critical details.\n\n" + conversationText }],
    max_tokens: 2000,
  });
  const summary = (response.content[0] as Anthropic.TextBlock).text;
  return [
    { role: "user", content: `[Conversation compressed. Transcript: ${transcriptPath}]\n\n${summary}` },
    { role: "assistant", content: "Understood. I have the context from the summary. Continuing." },
  ];
}

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
  bash:      (kw) => runBash(kw.command as string),
  read_file: (kw) => runRead(kw.path as string, kw.limit as number | undefined),
  write_file:(kw) => runWrite(kw.path as string, kw.content as string),
  edit_file: (kw) => runEdit(kw.path as string, kw.old_text as string, kw.new_text as string),
  compact:   () => "Manual compression requested.",
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
  { name: "compact", description: "Trigger manual conversation compression.",
    input_schema: { type: "object" as const, properties: { focus: { type: "string", description: "What to preserve in the summary" } } } },
];

async function agentLoop(messages: Anthropic.MessageParam[]): Promise<void> {
  while (true) {
    // Layer 1: microCompact before each LLM call
    microCompact(messages);
    // Layer 2: autoCompact if token estimate exceeds threshold
    if (estimateTokens(messages) > THRESHOLD) {
      process.stdout.write("[auto_compact triggered]\n");
      const compacted = await autoCompact(messages);
      messages.splice(0, messages.length, ...compacted);
    }
    const response = await client.messages.create({
      model: MODEL, system: SYSTEM, messages, tools: TOOLS, max_tokens: 8000,
    });
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") return;
    const results: Anthropic.ToolResultBlockParam[] = [];
    let manualCompact = false;
    for (const block of response.content) {
      if (block.type === "tool_use") {
        if (block.name === "compact") {
          manualCompact = true;
        }
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
    // Layer 3: manual compact triggered by the compact tool
    if (manualCompact) {
      process.stdout.write("[manual compact]\n");
      const compacted = await autoCompact(messages);
      messages.splice(0, messages.length, ...compacted);
    }
  }
}

async function main() {
  const history: Anthropic.MessageParam[] = [];
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = () => new Promise<string>((resolve) => rl.question("\x1b[36ms06 >> \x1b[0m", resolve));

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
