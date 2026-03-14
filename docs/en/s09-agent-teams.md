# s09: Agent Teams

`s01 > s02 > s03 > s04 > s05 > s06 | s07 > s08 > [ s09 ] s10 > s11 > s12`

> *"When the task is too big for one, delegate to teammates"* -- persistent teammates + async mailboxes.

## Problem

Subagents (s04) are disposable: spawn, work, return summary, die. No identity, no memory between invocations. Background tasks (s08) run shell commands but can't make LLM-guided decisions.

Real teamwork needs: (1) persistent agents that outlive a single prompt, (2) identity and lifecycle management, (3) a communication channel between agents.

## Solution

```
Teammate lifecycle:
  spawn -> WORKING -> IDLE -> WORKING -> ... -> SHUTDOWN

Communication:
  .team/
    config.json           <- team roster + statuses
    inbox/
      alice.jsonl         <- append-only, drain-on-read
      bob.jsonl
      lead.jsonl

              +--------+    send("alice","bob","...")    +--------+
              | alice  | -----------------------------> |  bob   |
              | loop   |    bob.jsonl << {json_line}    |  loop  |
              +--------+                                +--------+
                   ^                                         |
                   |        BUS.read_inbox("alice")          |
                   +---- alice.jsonl -> read + drain ---------+
```

## How It Works

1. TeammateManager maintains config.json with the team roster.

```typescript
class TeammateManager {
  private dir: string;
  private configPath: string;
  private config: { members: Array<{ name: string; role: string; status: string }> };
  private workers: Map<string, Worker> = new Map();
```

2. `spawn()` creates a teammate and starts its agent loop in a worker thread.

```typescript
spawn(name: string, role: string, prompt: string): string {
  const member = { name, role, status: "working" };
  this.config.members.push(member);
  this.saveConfig();
  const worker = new Worker(__filename, {
    workerData: { name, role, prompt, workdir: WORKDIR, inboxDir: INBOX_DIR, teamDir: TEAM_DIR }
  });
  this.workers.set(name, worker);
  return `Spawned teammate '${name}' (role: ${role})`;
}
```

3. MessageBus: append-only JSONL inboxes. `send()` appends a JSON line; `read_inbox()` reads all and drains.

```typescript
class MessageBus {
  send(sender: string, to: string, content: string, msgType = "message", extra: Record<string, unknown> = {}): void {
    const msg = { type: msgType, from: sender, content, timestamp: Date.now(), ...extra };
    fs.appendFileSync(path.join(this.dir, `${to}.jsonl`), JSON.stringify(msg) + "\n", "utf-8");
  }

  readInbox(name: string): string {
    const filePath = path.join(this.dir, `${name}.jsonl`);
    if (!fs.existsSync(filePath)) return "[]";
    const msgs = fs.readFileSync(filePath, "utf-8").trim().split("\n")
      .filter(Boolean).map((l) => JSON.parse(l));
    fs.writeFileSync(filePath, "", "utf-8");  // drain
    return JSON.stringify(msgs, null, 2);
  }
}
```

4. Each teammate checks its inbox before every LLM call, injecting received messages into context.

```typescript
// In worker thread:
async function teammateLoop(name: string, role: string, prompt: string): Promise<void> {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];
  for (let i = 0; i < 50; i++) {
    const inbox = BUS.readInbox(name);
    if (inbox !== "[]") {
      messages.push({ role: "user", content: `<inbox>${inbox}</inbox>` });
      messages.push({ role: "assistant", content: "Noted inbox messages." });
    }
    const response = await client.messages.create({ /* ... */ });
    if (response.stop_reason !== "tool_use") break;
    // execute tools, append results...
  }
  TEAM.setStatus(name, "idle");
}
```

## What Changed From s08

| Component      | Before (s08)     | After (s09)                |
|----------------|------------------|----------------------------|
| Tools          | 6                | 9 (+spawn/send/read_inbox) |
| Agents         | Single           | Lead + N teammates         |
| Persistence    | None             | config.json + JSONL inboxes|
| Threads        | Background cmds  | Full agent loops per thread|
| Lifecycle      | Fire-and-forget  | idle -> working -> idle    |
| Communication  | None             | message + broadcast        |

## Try It

```sh
cd learn-claude-code
npx tsx agents/s09_agent_teams.ts
```

1. `Spawn alice (coder) and bob (tester). Have alice send bob a message.`
2. `Broadcast "status update: phase 1 complete" to all teammates`
3. `Check the lead inbox for any messages`
4. Type `/team` to see the team roster with statuses
5. Type `/inbox` to manually check the lead's inbox
