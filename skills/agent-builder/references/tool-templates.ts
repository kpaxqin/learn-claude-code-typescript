/**
 * Tool Templates - Copy and customize these for your agent.
 *
 * Each tool needs:
 * 1. Definition (JSON schema for the model)
 * 2. Implementation (TypeScript function)
 */

import Anthropic from "@anthropic-ai/sdk";
import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";

const WORKDIR = process.cwd();

// =============================================================================
// TOOL DEFINITIONS (for TOOLS list)
// =============================================================================

export const BASH_TOOL: Anthropic.Tool = {
  name: "bash",
  description: "Run a shell command. Use for: ls, find, grep, git, npm, python, etc.",
  input_schema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The shell command to execute",
      },
    },
    required: ["command"],
  },
};

export const READ_FILE_TOOL: Anthropic.Tool = {
  name: "read_file",
  description: "Read file contents. Returns UTF-8 text.",
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Relative path to the file",
      },
      limit: {
        type: "integer",
        description: "Max lines to read (default: all)",
      },
    },
    required: ["path"],
  },
};

export const WRITE_FILE_TOOL: Anthropic.Tool = {
  name: "write_file",
  description: "Write content to a file. Creates parent directories if needed.",
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Relative path for the file",
      },
      content: {
        type: "string",
        description: "Content to write",
      },
    },
    required: ["path", "content"],
  },
};

export const EDIT_FILE_TOOL: Anthropic.Tool = {
  name: "edit_file",
  description: "Replace exact text in a file. Use for surgical edits.",
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Relative path to the file",
      },
      old_text: {
        type: "string",
        description: "Exact text to find (must match precisely)",
      },
      new_text: {
        type: "string",
        description: "Replacement text",
      },
    },
    required: ["path", "old_text", "new_text"],
  },
};

export const TODO_WRITE_TOOL: Anthropic.Tool = {
  name: "TodoWrite",
  description: "Update the task list. Use to plan and track progress.",
  input_schema: {
    type: "object",
    properties: {
      items: {
        type: "array",
        description: "Complete list of tasks",
        items: {
          type: "object",
          properties: {
            content: { type: "string", description: "Task description" },
            status: { type: "string", enum: ["pending", "in_progress", "completed"] },
            activeForm: { type: "string", description: "Present tense, e.g. 'Reading files'" },
          },
          required: ["content", "status", "activeForm"],
        },
      },
    },
    required: ["items"],
  },
};

// Generate TASK_TOOL dynamically with agent types - see subagent-pattern.ts
// const TASK_TOOL: Anthropic.Tool = {
//   name: "Task",
//   description: `Spawn a subagent for a focused subtask.\n\nAgent types:\n${getAgentDescriptions()}`,
//   input_schema: {
//     type: "object",
//     properties: {
//       description: { type: "string", description: "Short task name (3-5 words)" },
//       prompt: { type: "string", description: "Detailed instructions" },
//       agent_type: { type: "string", enum: Object.keys(AGENT_TYPES) },
//     },
//     required: ["description", "prompt", "agent_type"],
//   },
// };

// =============================================================================
// TOOL IMPLEMENTATIONS
// =============================================================================

export function safePath(p: string): string {
  /**
   * Security: Ensure path stays within workspace.
   * Prevents ../../../etc/passwd attacks.
   */
  const resolved = path.resolve(WORKDIR, p);
  if (!resolved.startsWith(WORKDIR)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolved;
}

export function runBash(command: string): string {
  /**
   * Execute shell command with safety checks.
   *
   * Safety features:
   * - Blocks obviously dangerous commands
   * - 60 second timeout
   * - Output truncated to 50KB
   */
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((d) => command.includes(d))) {
    return "Error: Dangerous command blocked";
  }

  const result = spawnSync("bash", ["-c", command], {
    cwd: WORKDIR,
    timeout: 60000,
    encoding: "utf-8",
  });

  if (result.error?.message?.includes("ETIMEDOUT")) {
    return "Error: Command timed out (60s)";
  }
  if (result.error) return `Error: ${result.error.message}`;

  const output = ((result.stdout ?? "") + (result.stderr ?? "")).trim();
  return (output || "(no output)").slice(0, 50000);
}

export function runReadFile(filePath: string, limit?: number): string {
  /**
   * Read file contents with optional line limit.
   *
   * Features:
   * - Safe path resolution
   * - Optional line limit for large files
   * - Output truncated to 50KB
   */
  try {
    const text = fs.readFileSync(safePath(filePath), "utf-8");
    const allLines = text.split("\n");

    if (limit !== undefined && limit < allLines.length) {
      const lines = allLines.slice(0, limit);
      lines.push(`... (${allLines.length - limit} more lines)`);
      return lines.join("\n").slice(0, 50000);
    }

    return text.slice(0, 50000);
  } catch (e) {
    return `Error: ${e}`;
  }
}

export function runWriteFile(filePath: string, content: string): string {
  /**
   * Write content to file, creating parent directories if needed.
   *
   * Features:
   * - Safe path resolution
   * - Auto-creates parent directories
   * - Returns byte count for confirmation
   */
  try {
    const fp = safePath(filePath);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content, "utf-8");
    return `Wrote ${content.length} bytes to ${filePath}`;
  } catch (e) {
    return `Error: ${e}`;
  }
}

export function runEditFile(filePath: string, oldText: string, newText: string): string {
  /**
   * Replace exact text in a file (surgical edit).
   *
   * Features:
   * - Exact string matching (not regex)
   * - Only replaces first occurrence (safety)
   * - Clear error if text not found
   */
  try {
    const fp = safePath(filePath);
    const content = fs.readFileSync(fp, "utf-8");

    if (!content.includes(oldText)) {
      return `Error: Text not found in ${filePath}`;
    }

    const newContent = content.replace(oldText, newText);
    fs.writeFileSync(fp, newContent, "utf-8");
    return `Edited ${filePath}`;
  } catch (e) {
    return `Error: ${e}`;
  }
}

// =============================================================================
// DISPATCHER PATTERN
// =============================================================================

type ToolInput = Record<string, unknown>;

export function executeTool(name: string, args: ToolInput): string {
  /**
   * Dispatch tool call to implementation.
   *
   * This pattern makes it easy to add new tools:
   * 1. Add definition to TOOLS list
   * 2. Add implementation function
   * 3. Add case to this dispatcher
   */
  if (name === "bash") return runBash(args.command as string);
  if (name === "read_file") return runReadFile(args.path as string, args.limit as number | undefined);
  if (name === "write_file") return runWriteFile(args.path as string, args.content as string);
  if (name === "edit_file")
    return runEditFile(args.path as string, args.old_text as string, args.new_text as string);
  // Add more tools here...
  return `Unknown tool: ${name}`;
}
