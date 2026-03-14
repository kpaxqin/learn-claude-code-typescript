#!/usr/bin/env npx tsx
/**
 * Minimal Agent Template - Copy and customize this.
 *
 * This is the simplest possible working agent (~80 lines).
 * It has everything you need: 3 tools + loop.
 *
 * Usage:
 *   1. Set ANTHROPIC_API_KEY environment variable
 *   2. npx tsx minimal-agent.ts
 *   3. Type commands, 'q' to quit
 */

import Anthropic from "@anthropic-ai/sdk";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { spawnSync } from "child_process";

dotenv.config({ override: true });

// Configuration
const client = new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL });
const MODEL = process.env.MODEL_ID ?? "claude-sonnet-4-20250514";
const WORKDIR = process.cwd();

// System prompt - keep it simple
const SYSTEM = `You are a coding agent at ${WORKDIR}.

Rules:
- Use tools to complete tasks
- Prefer action over explanation
- Summarize what you did when done`;

// Minimal tool set - add more as needed
const TOOLS: Anthropic.Tool[] = [
  {
    name: "bash",
    description: "Run shell command",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description: "Read file contents",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to file",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
];

type ToolInput = Record<string, unknown>;

function executeTool(name: string, args: ToolInput): string {
  if (name === "bash") {
    const result = spawnSync("bash", ["-c", args.command as string], {
      cwd: WORKDIR,
      timeout: 60000,
      encoding: "utf-8",
    });
    if (result.error?.message?.includes("ETIMEDOUT")) return "Error: Timeout";
    return ((result.stdout ?? "") + (result.stderr ?? "")).trim() || "(empty)";
  }

  if (name === "read_file") {
    try {
      return fs.readFileSync(path.resolve(WORKDIR, args.path as string), "utf-8").slice(0, 50000);
    } catch (e) {
      return `Error: ${e}`;
    }
  }

  if (name === "write_file") {
    try {
      const fp = path.resolve(WORKDIR, args.path as string);
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, args.content as string, "utf-8");
      return `Wrote ${(args.content as string).length} bytes to ${args.path}`;
    } catch (e) {
      return `Error: ${e}`;
    }
  }

  return `Unknown tool: ${name}`;
}

async function agent(prompt: string, history: Anthropic.MessageParam[]): Promise<string> {
  history.push({ role: "user", content: prompt });

  while (true) {
    const response = await client.messages.create({
      model: MODEL,
      system: SYSTEM,
      messages: history,
      tools: TOOLS,
      max_tokens: 8000,
    });

    // Build assistant message
    history.push({ role: "assistant", content: response.content });

    // If no tool calls, return text
    if (response.stop_reason !== "tool_use") {
      return response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
    }

    // Execute tools
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        console.log(`> ${block.name}: ${JSON.stringify(block.input)}`);
        const output = executeTool(block.name, block.input as ToolInput);
        console.log(`  ${output.slice(0, 100)}...`);
        results.push({ type: "tool_result", tool_use_id: block.id, content: output });
      }
    }

    history.push({ role: "user", content: results });
  }
}

async function main(): Promise<void> {
  console.log(`Minimal Agent - ${WORKDIR}`);
  console.log("Type 'q' to quit.\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));

  const history: Anthropic.MessageParam[] = [];
  while (true) {
    let query: string;
    try {
      query = (await ask(">> ")).trim();
    } catch {
      break;
    }
    if (["q", "quit", "exit", ""].includes(query)) break;
    console.log(await agent(query, history));
    console.log();
  }

  rl.close();
}

main().catch(console.error);
