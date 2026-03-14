# s11: Autonomous Agents

`s01 > s02 > s03 > s04 > s05 > s06 | s07 > s08 > s09 > s10 > [ s11 ] s12`

> *"Teammates scan the board and claim tasks themselves"* -- no need for the lead to assign each one.

## Problem

In s09-s10, teammates only work when explicitly told to. The lead must spawn each one with a specific prompt. 10 unclaimed tasks on the board? The lead assigns each one manually. Doesn't scale.

True autonomy: teammates scan the task board themselves, claim unclaimed tasks, work on them, then look for more.

One subtlety: after context compression (s06), the agent might forget who it is. Identity re-injection fixes this.

## Solution

```
Teammate lifecycle with idle cycle:

+-------+
| spawn |
+---+---+
    |
    v
+-------+   tool_use     +-------+
| WORK  | <------------- |  LLM  |
+---+---+                +-------+
    |
    | stop_reason != tool_use (or idle tool called)
    v
+--------+
|  IDLE  |  poll every 5s for up to 60s
+---+----+
    |
    +---> check inbox --> message? ----------> WORK
    |
    +---> scan .tasks/ --> unclaimed? -------> claim -> WORK
    |
    +---> 60s timeout ----------------------> SHUTDOWN

Identity re-injection after compression:
  if len(messages) <= 3:
    messages.insert(0, identity_block)
```

## How It Works

1. The teammate loop has two phases: WORK and IDLE. When the LLM stops calling tools (or calls `idle`), the teammate enters IDLE.

```typescript
async function teammateLoop(name: string, role: string, prompt: string): Promise<void> {
  while (true) {
    // -- WORK PHASE --
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];
    for (let i = 0; i < 50; i++) {
      const response = await client.messages.create({ /* ... */ });
      if (response.stop_reason !== "tool_use") break;
      // execute tools...
      if (idleRequested) break;
    }

    // -- IDLE PHASE --
    setStatus(name, "idle");
    const resume = await idlePoll(name, messages);
    if (!resume) { setStatus(name, "shutdown"); return; }
    setStatus(name, "working");
  }
}
```

2. The idle phase polls inbox and task board in a loop.

```typescript
async function idlePoll(name: string, messages: Anthropic.MessageParam[]): Promise<boolean> {
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  for (let i = 0; i < IDLE_TIMEOUT / POLL_INTERVAL; i++) {  // 60s / 5s = 12
    await sleep(POLL_INTERVAL);
    const inbox = BUS.readInbox(name);
    if (inbox !== "[]") {
      messages.push({ role: "user", content: `<inbox>${inbox}</inbox>` });
      return true;
    }
    const unclaimed = scanUnclaimedTasks();
    if (unclaimed.length > 0) {
      claimTask(unclaimed[0].id, name);
      messages.push({ role: "user",
        content: `<auto-claimed>Task #${unclaimed[0].id}: ${unclaimed[0].subject}</auto-claimed>` });
      return true;
    }
  }
  return false;  // timeout -> shutdown
}
```

3. Task board scanning: find pending, unowned, unblocked tasks.

```typescript
function scanUnclaimedTasks(): Array<{ id: number; subject: string }> {
  return fs.readdirSync(TASKS_DIR)
    .filter((f) => f.startsWith("task_"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(TASKS_DIR, f), "utf-8")))
    .filter((t) => t.status === "pending" && !t.owner && !t.blockedBy?.length)
    .sort((a, b) => a.id - b.id);
}
```

4. Identity re-injection: when context is too short (compression happened), insert an identity block.

```typescript
if (messages.length <= 3) {
  messages.unshift(
    { role: "assistant", content: `I am ${name}. Continuing.` },
    { role: "user", content: `<identity>You are '${name}', role: ${role}, team: ${teamName}. Continue your work.</identity>` }
  );
}
```

## What Changed From s10

| Component      | Before (s10)     | After (s11)                |
|----------------|------------------|----------------------------|
| Tools          | 12               | 14 (+idle, +claim_task)    |
| Autonomy       | Lead-directed    | Self-organizing            |
| Idle phase     | None             | Poll inbox + task board    |
| Task claiming  | Manual only      | Auto-claim unclaimed tasks |
| Identity       | System prompt    | + re-injection after compress|
| Timeout        | None             | 60s idle -> auto shutdown  |

## Try It

```sh
cd learn-claude-code
npx tsx agents/s11_autonomous_agents.ts
```

1. `Create 3 tasks on the board, then spawn alice and bob. Watch them auto-claim.`
2. `Spawn a coder teammate and let it find work from the task board itself`
3. `Create tasks with dependencies. Watch teammates respect the blocked order.`
4. Type `/tasks` to see the task board with owners
5. Type `/team` to monitor who is working vs idle
