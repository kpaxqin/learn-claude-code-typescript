# s02: Tool Use

`s01 > [ s02 ] s03 > s04 > s05 > s06 | s07 > s08 > s09 > s10 > s11 > s12`

> *"Adding a tool means adding one handler"* -- the loop stays the same; new tools register into the dispatch map.

## Problem

With only `bash`, the agent shells out for everything. `cat` truncates unpredictably, `sed` fails on special characters, and every bash call is an unconstrained security surface. Dedicated tools like `read_file` and `write_file` let you enforce path sandboxing at the tool level.

The key insight: adding tools does not require changing the loop.

## Solution

```
+--------+      +-------+      +------------------+
|  User  | ---> |  LLM  | ---> | Tool Dispatch    |
| prompt |      |       |      | {                |
+--------+      +---+---+      |   bash: run_bash |
                    ^           |   read: run_read |
                    |           |   write: run_wr  |
                    +-----------+   edit: run_edit |
                    tool_result | }                |
                                +------------------+

The dispatch map is a dict: {tool_name: handler_function}.
One lookup replaces any if/elif chain.
```

## How It Works

1. Each tool gets a handler function. Path sandboxing prevents workspace escape.

```typescript
function safePath(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  if (!resolved.startsWith(WORKDIR)) throw new Error(`Path escapes workspace: ${p}`);
  return resolved;
}

function runRead(filePath: string, limit?: number): string {
  const text = fs.readFileSync(safePath(filePath), "utf-8");
  const lines = text.split("\n");
  if (limit && limit < lines.length) lines.splice(limit);
  return lines.join("\n").slice(0, 50000);
}
```

2. The dispatch map links tool names to handlers.

```typescript
const TOOL_HANDLERS: Record<string, (kw: ToolInput) => string> = {
  bash:       (kw) => runBash(kw.command as string),
  read_file:  (kw) => runRead(kw.path as string, kw.limit as number | undefined),
  write_file: (kw) => runWrite(kw.path as string, kw.content as string),
  edit_file:  (kw) => runEdit(kw.path as string, kw.old_text as string, kw.new_text as string),
};
```

3. In the loop, look up the handler by name. The loop body itself is unchanged from s01.

```typescript
for (const block of response.content) {
  if (block.type === "tool_use") {
    const handler = TOOL_HANDLERS[block.name];
    const output = handler
      ? handler(block.input as ToolInput)
      : `Unknown tool: ${block.name}`;
    results.push({ type: "tool_result", tool_use_id: block.id, content: output });
  }
}
```

Add a tool = add a handler + add a schema entry. The loop never changes.

## What Changed From s01

| Component      | Before (s01)       | After (s02)                |
|----------------|--------------------|----------------------------|
| Tools          | 1 (bash only)      | 4 (bash, read, write, edit)|
| Dispatch       | Hardcoded bash call | `TOOL_HANDLERS` dict       |
| Path safety    | None               | `safe_path()` sandbox      |
| Agent loop     | Unchanged          | Unchanged                  |

## Try It

```sh
cd learn-claude-code
npx tsx agents/s02_tool_use.ts
```

1. `Read the file package.json`
2. `Create a file called greet.py with a greet(name) function`
3. `Edit greet.py to add a docstring to the function`
4. `Read greet.py to verify the edit worked`
