#!/usr/bin/env tsx
/**
 * Agent Scaffold Script - Create a new agent project with best practices.
 *
 * Usage:
 *   npx tsx init_agent.ts <agent-name> [--level 0-4] [--path <output-dir>]
 *
 * Examples:
 *   npx tsx init_agent.ts my-agent                 # Level 1 (4 tools)
 *   npx tsx init_agent.ts my-agent --level 0      # Minimal (bash only)
 *   npx tsx init_agent.ts my-agent --level 2      # With TodoWrite
 *   npx tsx init_agent.ts my-agent --path ./bots  # Custom output directory
 */

import * as fs from "fs";
import * as path from "path";

// Agent templates for each level
const TEMPLATES: Record<number, (name: string) => string> = {
  0: (name: string) => `#!/usr/bin/env tsx
/**
 * Level 0 Agent - Bash is All You Need (~50 lines)
 *
 * Core insight: One tool (bash) can do everything.
 * Subagents via self-recursion: npx tsx ${name}.ts "subtask"
 */

import Anthropic from "@anthropic-ai/sdk";
import * as dotenv from "dotenv";
import { spawnSync } from "child_process";
import * as readline from "readline";

dotenv.config({ override: true });

const client = new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL });
const MODEL = process.env.MODEL_ID!;

const SYSTEM = \`You are a coding agent. Use bash for everything:
- Read: cat, grep, find, ls
- Write: echo 'content' > file
- Subagent: npx tsx ${name}.ts "subtask"
\`;

const TOOLS: Anthropic.Tool[] = [{
  name: "bash",
  description: "Execute shell command",
  input_schema: { type: "object" as const, properties: { command: { type: "string" } }, required: ["command"] },
}];

async function run(prompt: string, history: Anthropic.MessageParam[] = []): Promise<string> {
  history.push({ role: "user", content: prompt });
  while (true) {
    const r = await client.messages.create({ model: MODEL, system: SYSTEM, messages: history, tools: TOOLS, max_tokens: 8000 });
    history.push({ role: "assistant", content: r.content });
    if (r.stop_reason !== "tool_use") {
      return r.content.filter(b => b.type === "text").map(b => (b as Anthropic.TextBlock).text).join("");
    }
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const b of r.content) {
      if (b.type === "tool_use") {
        const cmd = (b.input as { command: string }).command;
        console.log(\`> \${cmd}\`);
        const out = spawnSync("bash", ["-c", cmd], { encoding: "utf-8", timeout: 60000 });
        const output = ((out.stdout || "") + (out.stderr || "")).trim() || "(empty)";
        results.push({ type: "tool_result", tool_use_id: b.id, content: output.slice(0, 50000) });
      }
    }
    history.push({ role: "user", content: results });
  }
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const h: Anthropic.MessageParam[] = [];
console.log(\`${name} - Level 0 Agent\nType 'q' to quit.\n\`);
function prompt() {
  rl.question(">> ", async (q) => {
    if (!q || q === "q" || q === "quit") { rl.close(); return; }
    console.log(await run(q, h), "\n");
    prompt();
  });
}
prompt();
`,

  1: (name: string) => `#!/usr/bin/env tsx
/**
 * Level 1 Agent - Model as Agent (~150 lines)
 *
 * Core insight: 4 tools cover 90% of coding tasks.
 * The model IS the agent. Code just runs the loop.
 */

import Anthropic from "@anthropic-ai/sdk";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import * as readline from "readline";

dotenv.config({ override: true });

const client = new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL });
const MODEL = process.env.MODEL_ID!;
const WORKDIR = process.cwd();

const SYSTEM = \`You are a coding agent at \${WORKDIR}.

Rules:
- Prefer tools over prose. Act, don't just explain.
- Never invent file paths. Use bash ls/find first if unsure.
- Make minimal changes. Don't over-engineer.
- After finishing, summarize what changed.\`;

type ToolInput = { command?: string; path?: string; content?: string; old_text?: string; new_text?: string };

const TOOLS: Anthropic.Tool[] = [
  { name: "bash", description: "Run shell command",
    input_schema: { type: "object" as const, properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "read_file", description: "Read file contents",
    input_schema: { type: "object" as const, properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "write_file", description: "Write content to file",
    input_schema: { type: "object" as const, properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "edit_file", description: "Replace exact text in file",
    input_schema: { type: "object" as const, properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } },
];

function safePath(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  if (!resolved.startsWith(WORKDIR)) throw new Error(\`Path escapes workspace: \${p}\`);
  return resolved;
}

function execute(name: string, args: ToolInput): string {
  try {
    if (name === "bash") {
      const dangerous = ["rm -rf /", "sudo", "shutdown", "> /dev/"];
      if (dangerous.some(d => (args.command || "").includes(d))) return "Error: Dangerous command blocked";
      const r = spawnSync("bash", ["-c", args.command!], { cwd: WORKDIR, timeout: 60000, encoding: "utf-8" });
      return (((r.stdout || "") + (r.stderr || "")).trim() || "(empty)").slice(0, 50000);
    }
    if (name === "read_file") {
      return fs.readFileSync(safePath(args.path!), "utf-8").slice(0, 50000);
    }
    if (name === "write_file") {
      const p = safePath(args.path!);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, args.content!);
      return \`Wrote \${args.content!.length} bytes to \${args.path}\`;
    }
    if (name === "edit_file") {
      const p = safePath(args.path!);
      const content = fs.readFileSync(p, "utf-8");
      if (!content.includes(args.old_text!)) return \`Error: Text not found in \${args.path}\`;
      fs.writeFileSync(p, content.replace(args.old_text!, args.new_text!));
      return \`Edited \${args.path}\`;
    }
    return \`Unknown tool: \${name}\`;
  } catch (e) {
    return \`Error: \${e}\`;
  }
}

async function agent(prompt: string, history: Anthropic.MessageParam[] = []): Promise<string> {
  history.push({ role: "user", content: prompt });
  while (true) {
    const response = await client.messages.create({ model: MODEL, system: SYSTEM, messages: history, tools: TOOLS, max_tokens: 8000 });
    history.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") {
      return response.content.filter(b => b.type === "text").map(b => (b as Anthropic.TextBlock).text).join("");
    }
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        console.log(\`> \${block.name}: \${JSON.stringify(block.input).slice(0, 100)}\`);
        const output = execute(block.name, block.input as ToolInput);
        console.log(\`  \${output.slice(0, 100)}...\`);
        results.push({ type: "tool_result", tool_use_id: block.id, content: output });
      }
    }
    history.push({ role: "user", content: results });
  }
}

console.log(\`${name} - Level 1 Agent at \${WORKDIR}\nType 'q' to quit.\n\`);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const h: Anthropic.MessageParam[] = [];
function prompt() {
  rl.question(">> ", async (query) => {
    if (!query || ["q", "quit", "exit"].includes(query)) { rl.close(); return; }
    console.log(await agent(query, h), "\n");
    prompt();
  });
}
prompt();
`,
};

const PACKAGE_TEMPLATE = (name: string) => JSON.stringify({
  name,
  version: "0.1.0",
  private: true,
  scripts: { start: `npx tsx ${name}.ts` },
  dependencies: {
    "@anthropic-ai/sdk": "^0.39.0",
    dotenv: "^16.4.7",
  },
  devDependencies: {
    tsx: "^4.19.2",
    typescript: "^5.7.3",
    "@types/node": "^22.10.7",
  },
}, null, 2);

const ENV_TEMPLATE = `# API Configuration
ANTHROPIC_API_KEY=sk-xxx
ANTHROPIC_BASE_URL=https://api.anthropic.com
MODEL_ID=claude-sonnet-4-20250514
`;

function createAgent(name: string, level: number, outputDir: string): void {
  if (!(level in TEMPLATES) && level > 1) {
    console.error(`Error: Level ${level} not yet implemented in scaffold.`);
    console.error("Available levels: 0 (minimal), 1 (4 tools)");
    console.error("For levels 2-4, copy from learn-claude-code repository.");
    process.exit(1);
  }

  // Create output directory
  const agentDir = path.join(outputDir, name);
  fs.mkdirSync(agentDir, { recursive: true });

  // Write agent file
  const template = TEMPLATES[level] ?? TEMPLATES[1];
  const agentFile = path.join(agentDir, `${name}.ts`);
  fs.writeFileSync(agentFile, template(name));
  console.log(`Created: ${agentFile}`);

  // Write package.json
  const pkgFile = path.join(agentDir, "package.json");
  fs.writeFileSync(pkgFile, PACKAGE_TEMPLATE(name));
  console.log(`Created: ${pkgFile}`);

  // Write .env.example
  const envFile = path.join(agentDir, ".env.example");
  fs.writeFileSync(envFile, ENV_TEMPLATE);
  console.log(`Created: ${envFile}`);

  // Write .gitignore
  const gitignore = path.join(agentDir, ".gitignore");
  fs.writeFileSync(gitignore, ".env\nnode_modules/\n");
  console.log(`Created: ${gitignore}`);

  console.log(`\nAgent '${name}' created at ${agentDir}`);
  console.log(`\nNext steps:`);
  console.log(`  1. cd ${agentDir}`);
  console.log(`  2. cp .env.example .env`);
  console.log(`  3. Edit .env with your API key`);
  console.log(`  4. npm install`);
  console.log(`  5. npx tsx ${name}.ts`);
}

// Parse CLI args
const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: npx tsx init_agent.ts <agent-name> [--level 0-1] [--path <output-dir>]");
  console.error("\nLevels:");
  console.error("  0  Minimal (~50 lines)  - Single bash tool, self-recursion for subagents");
  console.error("  1  Basic (~150 lines)   - 4 core tools: bash, read, write, edit");
  process.exit(1);
}

const name = args[0];
let level = 1;
let outputPath = process.cwd();

for (let i = 1; i < args.length; i++) {
  if (args[i] === "--level" && args[i + 1]) {
    level = parseInt(args[++i], 10);
  } else if (args[i] === "--path" && args[i + 1]) {
    outputPath = args[++i];
  }
}

createAgent(name, level, outputPath);
