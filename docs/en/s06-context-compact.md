# s06: Context Compact

`s01 > s02 > s03 > s04 > s05 > [ s06 ] | s07 > s08 > s09 > s10 > s11 > s12`

> *"Context will fill up; you need a way to make room"* -- three-layer compression strategy for infinite sessions.

## Problem

The context window is finite. A single `read_file` on a 1000-line file costs ~4000 tokens. After reading 30 files and running 20 bash commands, you hit 100,000+ tokens. The agent cannot work on large codebases without compression.

## Solution

Three layers, increasing in aggressiveness:

```
Every turn:
+------------------+
| Tool call result |
+------------------+
        |
        v
[Layer 1: micro_compact]        (silent, every turn)
  Replace tool_result > 3 turns old
  with "[Previous: used {tool_name}]"
        |
        v
[Check: tokens > 50000?]
   |               |
   no              yes
   |               |
   v               v
continue    [Layer 2: auto_compact]
              Save transcript to .transcripts/
              LLM summarizes conversation.
              Replace all messages with [summary].
                    |
                    v
            [Layer 3: compact tool]
              Model calls compact explicitly.
              Same summarization as auto_compact.
```

## How It Works

1. **Layer 1 -- micro_compact**: Before each LLM call, replace old tool results with placeholders.

```typescript
function microCompact(messages: Anthropic.MessageParam[]): void {
  const toolResults: Array<[number, number, any]> = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "user" && Array.isArray(msg.content)) {
      for (let j = 0; j < (msg.content as any[]).length; j++) {
        const part = (msg.content as any[])[j];
        if (part?.type === "tool_result") toolResults.push([i, j, part]);
      }
    }
  }
  if (toolResults.length <= KEEP_RECENT) return;
  for (const [, , part] of toolResults.slice(0, -KEEP_RECENT)) {
    if (typeof part.content === "string" && part.content.length > 100)
      part.content = `[Previous: used tool]`;
  }
}
```

2. **Layer 2 -- auto_compact**: When tokens exceed threshold, save full transcript to disk, then ask the LLM to summarize.

```typescript
async function autoCompact(messages: Anthropic.MessageParam[]): Promise<Anthropic.MessageParam[]> {
  // Save transcript for recovery
  const transcriptPath = path.join(TRANSCRIPT_DIR, `transcript_${Date.now()}.jsonl`);
  fs.writeFileSync(transcriptPath, messages.map((m) => JSON.stringify(m)).join("\n"), "utf-8");
  // LLM summarizes
  const response = await client.messages.create({
    model: MODEL,
    messages: [{ role: "user", content:
      "Summarize this conversation for continuity..."
      + JSON.stringify(messages).slice(0, 80000) }],
    max_tokens: 2000,
  });
  const summary = (response.content[0] as Anthropic.TextBlock).text;
  return [
    { role: "user", content: `[Compressed]\n\n${summary}` },
    { role: "assistant", content: "Understood. Continuing." },
  ];
}
```

3. **Layer 3 -- manual compact**: The `compact` tool triggers the same summarization on demand.

4. The loop integrates all three:

```typescript
async function agentLoop(messages: Anthropic.MessageParam[]): Promise<void> {
  while (true) {
    microCompact(messages);                          // Layer 1
    if (estimateTokens(messages) > THRESHOLD)
      messages.splice(0, messages.length,
        ...(await autoCompact(messages)));           // Layer 2
    const response = await client.messages.create({ /* ... */ });
    // ... tool execution ...
    if (manualCompact)
      messages.splice(0, messages.length,
        ...(await autoCompact(messages)));           // Layer 3
  }
}
```

Transcripts preserve full history on disk. Nothing is truly lost -- just moved out of active context.

## What Changed From s05

| Component      | Before (s05)     | After (s06)                |
|----------------|------------------|----------------------------|
| Tools          | 5                | 5 (base + compact)         |
| Context mgmt   | None             | Three-layer compression    |
| Micro-compact  | None             | Old results -> placeholders|
| Auto-compact   | None             | Token threshold trigger    |
| Transcripts    | None             | Saved to .transcripts/     |

## Try It

```sh
cd learn-claude-code
npx tsx agents/s06_context_compact.ts
```

1. `Read every TypeScript file in the agents/ directory one by one` (watch micro-compact replace old results)
2. `Keep reading files until compression triggers automatically`
3. `Use the compact tool to manually compress the conversation`
