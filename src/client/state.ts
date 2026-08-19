/**
 * Client-side view state and data access for the todo tab. All data flows
 * through the Host `/todo/api` route (official `ctx.webServer` carrier); the
 * browser half never touches the file directly.
 * @module dsh-my-todo/client/state
 */

import type { Context } from '@deepseek-ai/cordis'
import type { TodoCounts, TodoItem } from '../types.ts'

export interface TodoListResponse {
  readonly todos: readonly TodoItem[]
  readonly counts: TodoCounts
}

interface ApiEnvelope {
  ok: boolean
  value?: unknown
  error?: { code?: string; message?: string }
}

/** POST one method to the Host todo route. */
export async function api(method: string, payload: Record<string, unknown> = {}): Promise<unknown> {
  const res = await fetch('/todo/api', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, payload }),
  })
  const data = (await res.json()) as ApiEnvelope
  if (!data.ok || data.value === undefined) {
    throw new Error(data.error?.message ?? `todo api ${method} failed`)
  }
  return data.value
}

/** Fetch the whole list + counts. */
export function fetchList(): Promise<TodoListResponse> {
  return api('list') as Promise<TodoListResponse>
}

// ── open/close/refresh state (module-level, one view per app) ───────────────

interface ViewState {
  /** Whether the todo view tab entry is currently registered. */
  readonly open: boolean
  /** Monotonic refresh signal bumped whenever the list may have changed. */
  readonly refresh: number
}

const listeners = new Set<() => void>()
let state: ViewState = { open: false, refresh: 0 }
let closeTab: (() => void) | undefined
let clientCtx: Context | undefined

function setState(patch: Partial<ViewState>): void {
  state = { ...state, ...patch }
  for (const fn of listeners) fn()
}

/** Bind the client context once (called by the plugin apply). */
export function bindClientContext(ctx: Context): void {
  clientCtx = ctx
}

/** React external-store subscription for the current view state. */
export function subscribeView(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

export function getViewState(): ViewState {
  return state
}

/** Open the todo view tab (idempotent): registers the `conversation.view` entry. */
export function openTodoView(): void {
  const ctx = clientCtx
  if (ctx === undefined || closeTab !== undefined) return
  closeTab = ctx.effect(() => {
    const dispose = ctx.slots.register({
      name: 'conversation.view',
      id: 'todo',
      order: 20,
      label: () => '待办',
      inject: () => ({}),
    }, TodoViewComponent as never)
    return () => {
      closeTab = undefined
      dispose()
    }
  }, 'my-todo: todo view tab')
  setState({ open: true })
}

/** Close the todo view tab: unregisters the entry; the view falls back to chat. */
export function closeTodoView(): void {
  const dispose = closeTab
  closeTab = undefined
  dispose?.()
  setState({ open: false })
}

/** Ask the open view to refetch (driven by observed session events). */
export function requestRefresh(): void {
  setState({ refresh: state.refresh + 1 })
}

// Avoid a circular import with TodoView.tsx: the component is attached lazily.
let TodoViewComponent: unknown
export function setTodoViewComponent(component: unknown): void {
  TodoViewComponent = component
}
