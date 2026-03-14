# s09: Agent Teams (智能体团队)

`s01 > s02 > s03 > s04 > s05 > s06 | s07 > s08 > [ s09 ] s10 > s11 > s12`

> *"任务太大一个人干不完, 要能分给队友"* -- 持久化队友 + JSONL 邮箱。

## 问题

子智能体 (s04) 是一次性的: 生成、干活、返回摘要、消亡。没有身份, 没有跨调用的记忆。后台任务 (s08) 能跑 shell 命令, 但做不了 LLM 引导的决策。

真正的团队协作需要三样东西: (1) 能跨多轮对话存活的持久智能体, (2) 身份和生命周期管理, (3) 智能体之间的通信通道。

## 解决方案

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

## 工作原理

1. TeammateManager 通过 config.json 维护团队名册。

```typescript
class TeammateManager {
  private dir: string;
  private configPath: string;
  private config: { members: Array<{ name: string; role: string; status: string }> };
  private workers: Map<string, Worker> = new Map();
```

2. `spawn()` 创建队友并在 Worker 线程中启动 agent loop。

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

3. MessageBus: append-only 的 JSONL 收件箱。`send()` 追加一行; `readInbox()` 读取全部并清空。

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

4. 每个队友在每次 LLM 调用前检查收件箱, 将消息注入上下文。

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

## 相对 s08 的变更

| 组件           | 之前 (s08)       | 之后 (s09)                         |
|----------------|------------------|------------------------------------|
| Tools          | 6                | 9 (+spawn/send/read_inbox)         |
| 智能体数量     | 单一             | 领导 + N 个队友                    |
| 持久化         | 无               | config.json + JSONL 收件箱         |
| 线程           | 后台命令         | 每 Worker 线程完整 agent loop      |
| 生命周期       | 一次性           | idle -> working -> idle            |
| 通信           | 无               | message + broadcast                |

## 试一试

```sh
cd learn-claude-code
npx tsx agents/s09_agent_teams.ts
```

试试这些 prompt (英文 prompt 对 LLM 效果更好, 也可以用中文):

1. `Spawn alice (coder) and bob (tester). Have alice send bob a message.`
2. `Broadcast "status update: phase 1 complete" to all teammates`
3. `Check the lead inbox for any messages`
4. 输入 `/team` 查看团队名册和状态
5. 输入 `/inbox` 手动检查领导的收件箱
