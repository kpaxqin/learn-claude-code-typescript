# s08: Background Tasks (后台任务)

`s01 > s02 > s03 > s04 > s05 > s06 | s07 > [ s08 ] s09 > s10 > s11 > s12`

> *"慢操作丢后台, agent 继续想下一步"* -- 后台线程跑命令, 完成后注入通知。

## 问题

有些命令要跑好几分钟: `npm install`、`pytest`、`docker build`。阻塞式循环下模型只能干等。用户说 "装依赖, 顺便建个配置文件", 智能体却只能一个一个来。

## 解决方案

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

## 工作原理

1. BackgroundManager 用通知队列追踪任务。

```typescript
class BackgroundManager {
  private tasks: Record<string, { status: string; command: string }> = {};
  private notificationQueue: Array<{ task_id: string; result: string }> = [];
```

2. `run()` 用 `exec()` 异步执行命令, 立即返回。

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

3. 命令完成后, 结果进入通知队列。

4. 每次 LLM 调用前排空通知队列。

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

循环保持单线程。只有子进程 I/O 被并行化。

## 相对 s07 的变更

| 组件           | 之前 (s07)       | 之后 (s08)                         |
|----------------|------------------|------------------------------------|
| Tools          | 8                | 6 (基础 + background_run + check)  |
| 执行方式       | 仅阻塞           | 阻塞 + 异步后台执行                |
| 通知机制       | 无               | 每轮排空的队列                     |
| 并发           | 无               | exec() 异步执行                    |

## 试一试

```sh
cd learn-claude-code
npx tsx agents/s08_background_tasks.ts
```

试试这些 prompt (英文 prompt 对 LLM 效果更好, 也可以用中文):

1. `Run "sleep 5 && echo done" in the background, then create a file while it runs`
2. `Start 3 background tasks: "sleep 2", "sleep 4", "sleep 6". Check their status.`
3. `Run your test suite in the background and keep working on other things`
