# s08: Background Tasks

`s01 > s02 > s03 > s04 > s05 > s06 | s07 > [ s08 ] s09 > s10 > s11 > s12`

> *"Run slow operations in the background; the agent keeps thinking"* -- daemon threads run commands, inject notifications on completion.

## Problem

Some commands take minutes: `npm install`, `pytest`, `docker build`. With a blocking loop, the model sits idle waiting. If the user asks "install dependencies and while that runs, create the config file," the agent does them sequentially, not in parallel.

## Solution

```
Main thread                Background thread
+-----------------+        +-----------------+
| agent loop      |        | subprocess runs |
| ...             |        | ...             |
| [LLM call] <---+------- | enqueue(result) |
|  ^drain queue   |        +-----------------+
+-----------------+

Timeline:
Agent --[spawn A]--[spawn B]--[other work]----
             |          |
             v          v
          [A runs]   [B runs]      (parallel)
             |          |
             +-- results injected before next LLM call --+
```

## How It Works

1. BackgroundManager tracks tasks with a thread-safe notification queue.

```typescript
class BackgroundManager {
  private tasks: Record<string, { status: string; command: string }> = {};
  private notificationQueue: Array<{ task_id: string; result: string }> = [];
```

2. `run()` starts a background process and returns immediately.

```typescript
run(command: string): string {
  const taskId = crypto.randomUUID().slice(0, 8);
  this.tasks[taskId] = { status: "running", command };
  exec(command, { cwd: WORKDIR, timeout: 300000 }, (error, stdout, stderr) => {
    const output = ((stdout ?? "") + (stderr ?? "")).trim().slice(0, 50000)
      || (error ? "Error: Timeout (300s)" : "(no output)");
    this.notificationQueue.push({ task_id: taskId, result: output.slice(0, 500) });
  });
  return `Background task ${taskId} started`;
}
```

3. When the subprocess finishes, its result goes into the notification queue.

4. The agent loop drains notifications before each LLM call.

```typescript
async function agentLoop(messages: Anthropic.MessageParam[]): Promise<void> {
  while (true) {
    const notifs = BG.drainNotifications();
    if (notifs.length > 0) {
      const notifText = notifs.map((n) => `[bg:${n.task_id}] ${n.result}`).join("\n");
      messages.push({ role: "user",
        content: `<background-results>\n${notifText}\n</background-results>` });
      messages.push({ role: "assistant", content: "Noted background results." });
    }
    const response = await client.messages.create({ /* ... */ });
```

The loop stays single-threaded. Only subprocess I/O is parallelized.

## What Changed From s07

| Component      | Before (s07)     | After (s08)                |
|----------------|------------------|----------------------------|
| Tools          | 8                | 6 (base + background_run + check)|
| Execution      | Blocking only    | Blocking + background threads|
| Notification   | None             | Queue drained per loop     |
| Concurrency    | None             | Daemon threads             |

## Try It

```sh
cd learn-claude-code
npx tsx agents/s08_background_tasks.ts
```

1. `Run "sleep 5 && echo done" in the background, then create a file while it runs`
2. `Start 3 background tasks: "sleep 2", "sleep 4", "sleep 6". Check their status.`
3. `Run your test suite in the background and keep working on other things`
