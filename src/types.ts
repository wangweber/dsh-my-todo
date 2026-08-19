/**
 * Shared domain types (client-safe: no Host-only symbols reach this file, so
 * the browser half can type-import them without pulling the Node runtime).
 * @module dsh-my-todo/types
 */

/** One global todo item. Persisted in `$DSH_HOME/todos.json`. */
export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export interface TodoItem {
  /** Stable identity minted by the Host store (uuid). */
  readonly id: string
  /** Human-readable task text (trimmed, non-empty, <= 500 chars). */
  readonly content: string
  /** Lifecycle state, reusing the official todo vocabulary. */
  readonly status: TodoStatus
  /** Unix epoch milliseconds at creation. */
  readonly createdAt: number
  /** Unix epoch milliseconds at last mutation. */
  readonly updatedAt: number
}

/** Per-list counts, the compact readout returned by tools and commands. */
export interface TodoCounts {
  readonly pending: number
  readonly inProgress: number
  readonly completed: number
}

/** Canonical tool/command result value. */
export interface TodoResult {
  readonly message: string
  readonly todos: readonly TodoItem[]
  readonly counts: TodoCounts
}

/** Compute per-status counts from a list. */
export function countTodos(todos: readonly TodoItem[]): TodoCounts {
  let pending = 0
  let inProgress = 0
  let completed = 0
  for (const todo of todos) {
    if (todo.status === 'pending') pending++
    else if (todo.status === 'in_progress') inProgress++
    else completed++
  }
  return { pending, inProgress, completed }
}

/** Compact one-line summary used in tool/command messages. */
export function summarize(todos: readonly TodoItem[], counts: TodoCounts): string {
  if (todos.length === 0) return '待办列表为空'
  const parts: string[] = []
  if (counts.pending > 0) parts.push(`${counts.pending} 待办`)
  if (counts.inProgress > 0) parts.push(`${counts.inProgress} 进行中`)
  if (counts.completed > 0) parts.push(`${counts.completed} 已完成`)
  return `共 ${todos.length} 条（${parts.join(' · ')}）`
}
