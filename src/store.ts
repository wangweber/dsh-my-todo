/**
 * Global todo store: single owner of the persisted list, serialized
 * read-modify-write mutations, atomic file persistence, and corruption
 * recovery. Mirrors the official persistence posture of
 * `dsh-session-persistence-jsonl` (atomic temp-file rename, loud recovery)
 * without depending on any session.
 * @module dsh-my-todo/store
 */

import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { TodoItem, TodoStatus } from './types.ts'

/** On-disk document shape; bump `version` on any breaking change. */
interface TodoDocument {
  readonly version: 1
  readonly todos: readonly TodoItem[]
}

/** Hard cap so the file cannot grow without bound. */
export const MAX_TODOS = 1000
export const MAX_CONTENT_LENGTH = 500

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The global cross-session todo list owned by dsh-my-todo. */
    todoStore: TodoStore
  }
}

/** Internal mutable row; persisted copies are exposed as readonly {@link TodoItem}. */
interface MutableTodo {
  id: string
  content: string
  status: TodoStatus
  createdAt: number
  updatedAt: number
}

/** A domain failure rendered verbatim to the model/user. */
export class TodoError extends Error {}

/**
 * Owns the list in memory and persists every mutation to one JSON file.
 * Mutations are serialized through a promise chain so concurrent writers
 * (UI route, model tool, slash command) never interleave read-modify-write.
 */
export class TodoStore {
  private todos: MutableTodo[] = []
  private chain: Promise<unknown> = Promise.resolve()
  private readonly listeners = new Set<() => void>()
  private readonly loaded: Promise<void>

  constructor(private readonly file: string) {
    this.loaded = this.load()
  }

  /** Stop accepting work and drop listeners (best-effort teardown). */
  dispose(): void {
    this.listeners.clear()
  }

  /** Subscribe to any committed change. Returns the disposer. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  /** Snapshot of the current list (copy; callers may not mutate the store). */
  async list(): Promise<TodoItem[]> {
    await this.loaded
    return this.todos.map(item => ({ ...item }))
  }

  /** Append one pending item. */
  async add(content: string): Promise<TodoItem> {
    const text = content.trim()
    if (text === '') throw new TodoError('待办内容不能为空')
    if (text.length > MAX_CONTENT_LENGTH) {
      throw new TodoError(`待办内容不能超过 ${MAX_CONTENT_LENGTH} 个字符`)
    }
    return this.mutate(async () => {
      if (this.todos.length >= MAX_TODOS) {
        throw new TodoError(`待办列表已满（最多 ${MAX_TODOS} 条）`)
      }
      const now = Date.now()
      const item: MutableTodo = {
        id: randomUUID(),
        content: text,
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      }
      this.todos.push(item)
      return { ...item }
    })
  }

  /** Patch one item's content and/or status. */
  async update(id: string, patch: { content?: string; status?: TodoStatus }): Promise<TodoItem> {
    return this.mutate(async () => {
      const item = this.todos.find(todo => todo.id === id)
      if (item === undefined) throw new TodoError(`找不到 id 为 ${id} 的待办`)
      if (patch.content !== undefined) {
        const text = patch.content.trim()
        if (text === '') throw new TodoError('待办内容不能为空')
        if (text.length > MAX_CONTENT_LENGTH) {
          throw new TodoError(`待办内容不能超过 ${MAX_CONTENT_LENGTH} 个字符`)
        }
        item.content = text
      }
      if (patch.status !== undefined) item.status = patch.status
      item.updatedAt = Date.now()
      return { ...item }
    })
  }

  /** Remove one item by id. */
  async remove(id: string): Promise<void> {
    return this.mutate(async () => {
      const index = this.todos.findIndex(todo => todo.id === id)
      if (index < 0) throw new TodoError(`找不到 id 为 ${id} 的待办`)
      this.todos.splice(index, 1)
    })
  }

  /** Remove every completed item; returns how many were removed. */
  async clearCompleted(): Promise<number> {
    return this.mutate(async () => {
      const before = this.todos.length
      this.todos = this.todos.filter(todo => todo.status !== 'completed')
      return before - this.todos.length
    })
  }

  /**
   * Resolve a model/user target: exact id first, then exact content, then a
   * unique substring match. Multiple matches come back for disambiguation.
   */
  async resolve(query: string): Promise<{ exact?: TodoItem; matches: TodoItem[] }> {
    await this.loaded
    const text = query.trim()
    if (text === '') return { matches: [] }
    const byId = this.todos.find(todo => todo.id === text)
    if (byId !== undefined) return { exact: { ...byId }, matches: [{ ...byId }] }
    const byContent = this.todos.filter(todo => todo.content === text)
    if (byContent.length > 0) {
      return {
        exact: { ...byContent[0]! },
        matches: byContent.map(item => ({ ...item })),
      }
    }
    const bySubstring = this.todos.filter(todo => todo.content.includes(text))
    return {
      exact: bySubstring.length === 1 ? { ...bySubstring[0]! } : undefined,
      matches: bySubstring.map(item => ({ ...item })),
    }
  }

  /** Serialized mutation: await the load, mutate, persist, notify. */
  private mutate<T>(op: () => T | Promise<T>): Promise<T> {
    const next = this.chain.then(async () => {
      await this.loaded
      const value = await op()
      await this.persist()
      this.notify()
      return value
    })
    this.chain = next.catch(() => undefined)
    return next
  }

  private notify(): void {
    for (const fn of this.listeners) fn()
  }

  private async load(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    try {
    const doc = JSON.parse(raw) as Partial<TodoDocument>
      if (doc.version !== 1 || !Array.isArray(doc.todos)) {
        throw new Error('unrecognized todo document shape')
      }
      this.todos = doc.todos.filter(isValidTodo).map(item => ({ ...item }))
    } catch (error: unknown) {
      // Corrupt file: back it up (never silently overwrite) and start empty.
      const backup = `${this.file}.corrupt-${Date.now()}`
      try {
        await rename(this.file, backup)
      } catch {
        /* best-effort backup */
      }
      console.warn(`[dsh-my-todo] 待办文件损坏，已备份到 ${backup}: ${String(error)}`)
      this.todos = []
    }
  }

  /** Atomic write: temp file + rename, owner-only permissions. */
  private async persist(): Promise<void> {
    const dir = dirname(this.file)
    await mkdir(dir, { recursive: true })
    const tmp = `${this.file}.tmp`
    const doc: TodoDocument = { version: 1, todos: this.todos }
    await writeFile(tmp, JSON.stringify(doc, null, 2), { mode: 0o600 })
    await chmod(tmp, 0o600)
    await rename(tmp, this.file)
  }
}

/** Structural validation of one persisted item (tolerant of unknown fields). */
function isValidTodo(value: unknown): value is MutableTodo {
  if (typeof value !== 'object' || value === null) return false
  const todo = value as Record<string, unknown>
  return typeof todo.id === 'string'
    && typeof todo.content === 'string'
    && (todo.status === 'pending' || todo.status === 'in_progress' || todo.status === 'completed')
    && typeof todo.createdAt === 'number'
    && typeof todo.updatedAt === 'number'
}
