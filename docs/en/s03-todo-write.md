# s03: TodoWrite

`s01 > s02 > [ s03 ] s04 > s05 > s06 | s07 > s08 > s09 > s10 > s11 > s12`

> *"An agent without a plan drifts"* -- list the steps first, then execute.

## Problem

On multi-step tasks, the model loses track. It repeats work, skips steps, or wanders off. Long conversations make this worse -- the system prompt fades as tool results fill the context. A 10-step refactoring might complete steps 1-3, then the model starts improvising because it forgot steps 4-10.

## Solution

```
+--------+      +-------+      +---------+
|  User  | ---> |  LLM  | ---> | Tools   |
| prompt |      |       |      | + todo  |
+--------+      +---+---+      +----+----+
                    ^                |
                    |   tool_result  |
                    +----------------+
                          |
              +-----------+-----------+
              | TodoManager state     |
              | [ ] task A            |
              | [>] task B  <- doing  |
              | [x] task C            |
              +-----------------------+
                          |
              if rounds_since_todo >= 3:
                inject <reminder> into tool_result
```

## How It Works

1. TodoManager stores items with statuses. Only one item can be `in_progress` at a time.

```typescript
class TodoManager {
  update(items: TodoItem[]): string {
    const validated: TodoItem[] = [];
    let inProgressCount = 0;
    for (const item of items) {
      const status = item.status ?? "pending";
      if (status === "in_progress") inProgressCount++;
      validated.push({ id: item.id, text: item.text, status });
    }
    if (inProgressCount > 1) throw new Error("Only one task can be in_progress");
    this.items = validated;
    return this.render();
  }
}
```

2. The `todo` tool goes into the dispatch map like any other tool.

```typescript
const TOOL_HANDLERS: Record<string, (kw: ToolInput) => string> = {
  // ...base tools...
  todo: (kw) => TODO.update(kw.items as TodoItem[]),
};
```

3. A nag reminder injects a nudge if the model goes 3+ rounds without calling `todo`.

```typescript
if (roundsSinceTodo >= 3 && messages.length > 0) {
  const last = messages[messages.length - 1];
  if (last.role === "user" && Array.isArray(last.content)) {
    (last.content as any[]).unshift({
      type: "text",
      text: "<reminder>Update your todos.</reminder>",
    });
  }
}
```

The "one in_progress at a time" constraint forces sequential focus. The nag reminder creates accountability.

## What Changed From s02

| Component      | Before (s02)     | After (s03)                |
|----------------|------------------|----------------------------|
| Tools          | 4                | 5 (+todo)                  |
| Planning       | None             | TodoManager with statuses  |
| Nag injection  | None             | `<reminder>` after 3 rounds|
| Agent loop     | Simple dispatch  | + rounds_since_todo counter|

## Try It

```sh
cd learn-claude-code
npx tsx agents/s03_todo_write.ts
```

1. `Refactor the file hello.py: add type hints, docstrings, and a main guard`
2. `Create a TypeScript package with index.ts, utils.ts, and tests/utils.test.ts`
3. `Review all TypeScript files and fix any style issues`
