/**
 * Model-facing `my_todo` tool: one tool with an action discriminator, so the
 * schema stays small and the model can address single items by id or by
 * natural-language content (ambiguous targets come back for disambiguation).
 * Registered through the official `ctx.tools` service with `defineTool`.
 * @module dsh-my-todo/tool
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import type { TodoResult, TodoStatus } from './types.ts'
import { countTodos, summarize } from './types.ts'
import { TodoError, type TodoStore } from './store.ts'

/** Supported actions; `open` is an explicit UI instruction, never data. */
export type TodoAction = 'add' | 'update' | 'delete' | 'list' | 'open' | 'clear_done'

interface ToolArgs {
  action: TodoAction
  content?: string
  id?: string
  status?: TodoStatus
}

/** Register the `my_todo` tool on the given context. */
export function registerTodoTool(ctx: Context, store: TodoStore): void {
  ctx.tools.register(defineTool({
    name: 'my_todo',
    description:
      '管理跨会话共享的全局待办列表（所有会话、所有工作区共用同一份，持久保存在 $DSH_HOME/todos.json）。'
      + '支持添加、更新、删除、列出、清除已完成，以及打开 Web 界面的待办页签。'
      + 'update/delete 用 id 精确定位；不知道 id 时用 content 模糊定位，多条匹配会返回候选。'
      + 'action=open 只在用户明确要求"打开待办"时调用，不要在数据变更时自动打开。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['add', 'update', 'delete', 'list', 'open', 'clear_done'],
        description: '要执行的操作：add 添加；update 更新内容或状态；delete 删除；list 列出全部；open 打开待办页签；clear_done 清除已完成的。',
      },
      content: {
        type: 'string',
        description: 'add 时是新待办内容；update/delete 时是目标内容（与 id 二选一，模糊匹配）。',
      },
      id: {
        type: 'string',
        description: '目标待办的稳定 id（update/delete 时优先使用；不知道时可省略改用 content）。',
      },
      status: {
        type: 'string',
        enum: ['pending', 'in_progress', 'completed'],
        description: 'update 时可选的新状态。',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{
        type: 'text',
        text: (value as unknown as TodoResult).message,
      }],
    },
    async execute(args) {
      try {
        return await dispatch(store, args) as unknown as JsonValue
      } catch (error: unknown) {
        if (error instanceof TodoError) throw new Error(error.message)
        throw error
      }
    },
  }))
}

async function dispatch(store: TodoStore, args: ToolArgs): Promise<TodoResult> {
  switch (args.action) {
    case 'add': {
      const content = args.content ?? ''
      if (content.trim() === '') throw new TodoError('add 需要提供 content')
      const item = await store.add(content)
      const todos = await store.list()
      const counts = countTodos(todos)
      return {
        message: `已添加待办「${item.content}」，${summarize(todos, counts)}`,
        todos,
        counts,
      }
    }
    case 'update': {
      const target = await resolveTarget(store, args)
      // `id` + `content` means rename; `content` alone is the locator.
      const patch: { content?: string; status?: TodoStatus } = {
        ...args.id !== undefined && args.content !== undefined ? { content: args.content } : {},
        ...args.status !== undefined ? { status: args.status } : {},
      }
      if (patch.content === undefined && patch.status === undefined) {
        throw new TodoError('update 需要提供 content 或 status 至少一项')
      }
      const item = await store.update(target.id, patch)
      const todos = await store.list()
      const counts = countTodos(todos)
      const bits: string[] = []
      if (patch.content !== undefined) bits.push(`内容改为「${item.content}」`)
      if (patch.status !== undefined) bits.push(`状态改为 ${item.status}`)
      return {
        message: `已更新待办「${item.content}」（${bits.join('，')}），${summarize(todos, counts)}`,
        todos,
        counts,
      }
    }
    case 'delete': {
      const target = await resolveTarget(store, args)
      await store.remove(target.id)
      const todos = await store.list()
      const counts = countTodos(todos)
      return {
        message: `已删除待办「${target.content}」，${summarize(todos, counts)}`,
        todos,
        counts,
      }
    }
    case 'clear_done': {
      const removed = await store.clearCompleted()
      const todos = await store.list()
      const counts = countTodos(todos)
      return {
        message: `已清除 ${removed} 条已完成待办，${summarize(todos, counts)}`,
        todos,
        counts,
      }
    }
    case 'open': {
      const todos = await store.list()
      const counts = countTodos(todos)
      return {
        message: `已打开待办页签，${summarize(todos, counts)}`,
        todos,
        counts,
      }
    }
    case 'list': {
      const todos = await store.list()
      const counts = countTodos(todos)
      const lines = todos.map(todo => `- [${statusMark(todo.status)}] ${todo.content} (${todo.id})`).join('\n')
      return {
        message: lines.length > 0 ? `${summarize(todos, counts)}\n${lines}` : summarize(todos, counts),
        todos,
        counts,
      }
    }
  }
}

/** Resolve an id-or-content target, failing with candidates on ambiguity. */
async function resolveTarget(store: TodoStore, args: ToolArgs): Promise<{ id: string; content: string }> {
  if (args.id !== undefined) {
    const { exact } = await store.resolve(args.id)
    if (exact === undefined) throw new TodoError(`找不到 id 为 ${args.id} 的待办`)
    return { id: exact.id, content: exact.content }
  }
  const query = args.content ?? ''
  if (query.trim() === '') throw new TodoError('请提供待办内容或 id')
  const { exact, matches } = await store.resolve(query)
  if (exact !== undefined) return { id: exact.id, content: exact.content }
  if (matches.length > 1) {
    const candidates = matches.map(todo => `「${todo.content}」(${todo.id})`).join('，')
    throw new TodoError(`有 ${matches.length} 条待办匹配「${query}」：${candidates}。请用 id 指定，或让用户确认是哪一条`)
  }
  throw new TodoError(`没有待办匹配「${query}」`)
}

function statusMark(status: TodoStatus): string {
  if (status === 'completed') return 'x'
  if (status === 'in_progress') return '~'
  return ' '
}
