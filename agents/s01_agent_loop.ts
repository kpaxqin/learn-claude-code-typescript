#!/usr/bin/env tsx
/**
 * s01_agent_loop.ts - The Agent Loop
 *
 * The entire secret of an AI coding agent in one pattern:
 *
 *     while stop_reason == "tool_use":
 *         response = LLM(messages, tools)
 *         execute tools
 *         append results
 *
 *     +----------+      +-------+      +---------+
 *     |   User   | ---> |  LLM  | ---> |  Tool   |
 *     |  prompt  |      |       |      | execute |
 *     +----------+      +---+---+      +----+----+
 *                           ^               |
 *                           |   tool_result |
 *                           +---------------+
 *                           (loop continues)
 *
 * This is the core loop: feed tool results back to the model
 * until the model decides to stop. Production agents layer
 * policy, hooks, and lifecycle controls on top.
 */

import Anthropic from "@anthropic-ai/sdk";
import * as dotenv from "dotenv";
import { spawnSync } from "child_process";
import * as readline from "readline";

dotenv.config({ override: true });

const client = new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL });
const MODEL = process.env.MODEL_ID!;
const WORKDIR = process.cwd();

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use bash to solve tasks. Act, don't explain.`;

const TOOLS: Anthropic.Tool[] = [
  {
    name: "bash",
    description: "Run a shell command.",
    input_schema: {
      type: "object" as const,
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
];

function runBash(command: string): string {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((d) => command.includes(d))) {
    return "Error: Dangerous command blocked";
  }
  const result = spawnSync("bash", ["-c", command], {
    cwd: WORKDIR,
    timeout: 120000,
    encoding: "utf-8",
  });
  if (result.error?.message?.includes("ETIMEDOUT")) {
    return "Error: Timeout (120s)";
  }
  const out = ((result.stdout || "") + (result.stderr || "")).trim();
  return (out || "(no output)").slice(0, 50000);
}

// -- The core pattern: a while loop that calls tools until the model stops --
async function agentLoop(messages: Anthropic.MessageParam[]): Promise<void> {
  while (true) {
    const response = await client.messages.create({
      model: MODEL,
      system: SYSTEM,
      messages,
      tools: TOOLS,
      max_tokens: 8000,
    });
    // Append assistant turn
    messages.push({ role: "assistant", content: response.content });
    // If the model didn't call a tool, we're done
    if (response.stop_reason !== "tool_use") return;
    // Execute each tool call, collect results
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        const input = block.input as { command: string };
        process.stdout.write(`\x1b[33m$ ${input.command}\x1b[0m\n`);
        const output = runBash(input.command);
        process.stdout.write(output.slice(0, 200) + "\n");
        results.push({ type: "tool_result", tool_use_id: block.id, content: output });
      }
    }
    messages.push({ role: "user", content: results });
  }
}

async function main() {
  const history: Anthropic.MessageParam[] = [];
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const ask = () =>
    new Promise<string>((resolve) => rl.question("\x1b[36ms01 >> \x1b[0m", resolve));

  while (true) {
    let query: string;
    try {
      query = await ask();
    } catch {
      break;
    }
    if (["q", "exit", ""].includes(query.trim().toLowerCase())) break;
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
