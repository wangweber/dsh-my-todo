/**
 * Human-facing `/todo` slash command (official `ctx.commands` registry).
 * `/todo` or `/todo open` opens the todo view tab (the client observes the
 * durable `command/run` record); subcommands mutate the list without opening
 * anything. Command results never enter the model history.
 * @module dsh-my-todo/command
 */

import type { CommandDefinition, CommandResult } from '@deepseek-ai/dsh-commands'
import type { TodoItem } from './types.ts'
import { countTodos, summarize } from './types.ts'
import { TodoError, type TodoStore } from './store.ts'

const USAGE = '/todo open | close | add <内容> | list | done <id|内容> | rm <id|内容> | clear-done'

/** Minimal structural face of the commands service we consume. */
export interface CommandRegistry {
  register(definition: CommandDefinition): () => void
}

/**
 * Register the `/todo` command. The registry is passed in (resolved via
 * `ctx.get('commands')` by the entry) because Cordis property access requires
 * an `inject` declaration, and the command service is optional in headless.
 */
export function registerTodoCommand(commands: CommandRegistry, store: TodoStore): void {
  commands.register({
    name: 'todo',
    description: '管理跨会话共享的全局待办列表',
    input: { hint: USAGE },
    handler: async ({ agent, rawInput }): Promise<CommandResult> => {
      const line = rawInput.trim()
      if (line === '' || line === 'open') {
        // The client opens the tab on the recorded command/run event.
        // A blank session hides the conversation header (and therefore the
        // tab ring) until its first turn, so tell the user what to expect.
        const blank = !agent.session.events.some(event => event.type === 'turn/start')
        return {
          kind: 'success',
          text: blank
            ? '待办页签已注册；当前会话尚未开始，发送第一条消息后页签栏会出现待办页签'
            : '待办页签已打开',
        }
      }
      const space = line.search(/\s/)
      const cmd = space < 0 ? line : line.slice(0, space)
      const rest = space < 0 ? '' : line.slice(space).trim()
      try {
        switch (cmd) {
          case 'add': {
            if (rest === '') return fail(`用法: /todo add <内容>`)
            const item = await store.add(rest)
            return success(`已添加待办「${item.content}」`)
          }
          case 'list': {
            const todos = await store.list()
            return success(formatList(todos))
          }
          case 'close': {
            // The client closes the tab on the recorded command/run event.
            return success('待办页签已关闭')
          }
          case 'done': {
            const target = await resolveTarget(store, rest)
            await store.update(target.id, { status: 'completed' })
            return success(`已完成「${target.content}」`)
          }
          case 'rm': {
            const target = await resolveTarget(store, rest)
            await store.remove(target.id)
            return success(`已删除「${target.content}」`)
          }
          case 'clear-done': {
            const removed = await store.clearCompleted()
            return success(`已清除 ${removed} 条已完成待办`)
          }
          default:
            return fail(`未知子命令「${cmd}」。用法: ${USAGE}`)
        }
      } catch (error: unknown) {
        if (error instanceof TodoError) return fail(error.message)
        throw error
      }
    },
  })
}

async function resolveTarget(store: TodoStore, query: string): Promise<TodoItem> {
  const { exact, matches } = await store.resolve(query)
  if (exact !== undefined) return exact
  if (matches.length > 1) {
    const candidates = matches.map(todo => `「${todo.content}」(${todo.id})`).join('，')
    throw new TodoError(`有 ${matches.length} 条待办匹配「${query}」：${candidates}。请用 id 指定`)
  }
  throw new TodoError(`没有待办匹配「${query}」`)
}

function formatList(todos: readonly TodoItem[]): string {
  const counts = countTodos(todos)
  if (todos.length === 0) return summarize(todos, counts)
  const lines = todos.map(todo => `- [${mark(todo.status)}] ${todo.content}`).join('\n')
  return `${summarize(todos, counts)}\n${lines}`
}

function mark(status: TodoItem['status']): string {
  if (status === 'completed') return 'x'
  if (status === 'in_progress') return '~'
  return ' '
}

function success(text: string): CommandResult {
  return { kind: 'success', text }
}

function fail(text: string): CommandResult {
  return { kind: 'error', text }
}
