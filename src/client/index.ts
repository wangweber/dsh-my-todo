/**
 * dsh-my-todo browser half: observes durable session events for explicit
 * open instructions (a `/todo`/`/todo open` command or a `my_todo` tool call
 * with `action: "open"`), opens/closes the `conversation.view` tab
 * accordingly, and refreshes the view when the list changes through the
 * session (command/done, tool/result). Data changes never auto-open the tab.
 *
 * Observation rides the official `conversationEvents` registry, the same
 * mechanism ui-goal / ui-trajectory use; the view tab is the official
 * `conversation.view` slot (ui-trajectory's registration pattern).
 * @module dsh-my-todo/client
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { TodoView } from './TodoView.tsx'
import {
  bindClientContext,
  closeTodoView,
  openTodoView,
  requestRefresh,
  setTodoViewComponent,
} from './state.ts'

/** Services required by this plugin (official client runtime services). */
export const inject = ['slots', 'locale', 'conversationEvents']

/** Locale namespace and dictionary keys owned by this plugin. */
type MyTodoKey = 'view.todo'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The todo view tab label. */
    'my-todo': MyTodoKey
  }
}

const zh: Record<MyTodoKey, string> = {
  'view.todo': '待办',
}

const en: Record<MyTodoKey, string> = {
  'view.todo': 'To-dos',
}

/** Pending command/tool correlations (run→done, call→result), bounded. */
const pendingCommands = new Map<string, string>()
const pendingTools = new Map<string, 'open' | 'other'>()

export function apply(ctx: Context): void {
  bindClientContext(ctx)
  setTodoViewComponent(TodoView)

  ctx.locale.register('my-todo', { zh, en })

  // The todo view entry is registered lazily by openTodoView; this effect
  // only owns the event observer and its teardown.
  ctx.effect(() => {
    return ctx.conversationEvents.register({
      kind: 'my-todo-observer',
      match(event: SessionEvent) {
        if (event.type === 'command/run' && event.data.name === 'todo') {
          if (pendingCommands.size > 500) pendingCommands.clear()
          pendingCommands.set(String(event.data.commandId), event.data.args ?? '')
          return { id: `cmd:${event.seq}`, role: 'start' }
        }
        if (event.type === 'command/done') {
          if (!pendingCommands.has(String(event.data.commandId))) return null
          pendingCommands.delete(String(event.data.commandId))
          return { id: `cmd-done:${event.seq}`, role: 'start' }
        }
        if (event.type === 'tool/call' && event.data.name === 'my_todo') {
          if (pendingTools.size > 500) pendingTools.clear()
          pendingTools.set(event.data.callId, toolAction(event.data.arguments) === 'open' ? 'open' : 'other')
          return { id: `tool:${event.seq}`, role: 'start' }
        }
        if (event.type === 'tool/result') {
          const callId = event.data.message.content[0]?.toolCallId
          if (callId === undefined || !pendingTools.has(callId)) return null
          pendingTools.delete(callId)
          return { id: `tool-result:${event.seq}`, role: 'start' }
        }
        return null
      },
      update(context) {
        // Every match is a unique start; updates never run, but the engine
        // requires the member.
        return context.state
      },
      start(_context, match) {
        const event = match.event
        if (event.type === 'command/run') {
          const args = (event.data.args ?? '').trim()
          if (args === '' || args === 'open') openTodoView()
          else if (args === 'close') closeTodoView()
        } else if (event.type === 'tool/call') {
          if (toolAction(event.data.arguments) === 'open') openTodoView()
        } else if (event.type === 'command/done' || event.type === 'tool/result') {
          // A todo mutation settled in this session: refresh the open view.
          requestRefresh()
        }
        return {}
      },
    })
  }, 'my-todo: observer')
}

/** Extract `action` from a raw tool-call arguments JSON string. */
function toolAction(rawArguments: string): string | undefined {
  try {
    const parsed = JSON.parse(rawArguments) as { action?: unknown }
    return typeof parsed.action === 'string' ? parsed.action : undefined
  } catch {
    return undefined
  }
}
