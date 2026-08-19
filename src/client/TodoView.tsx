/**
 * The todo view tab body: a three-column board by status (待启动 / 进行中 /
 * 已完成), a status-cycle control in front of every row (click cycles
 * pending → in_progress → completed), add input, delete per row,
 * clear-completed, and an icon close button right after the page title.
 * Refetches on mount, on the refresh signal, and after its own mutations.
 * @module dsh-my-todo/client/TodoView
 */

import { createElement, useEffect, useSyncExternalStore, useState } from 'react'
import type { ReactNode } from 'react'
import type { TodoCounts, TodoItem, TodoStatus } from '../types.ts'
import {
  api,
  closeTodoView,
  fetchList,
  getViewState,
  requestRefresh,
  subscribeView,
  type TodoListResponse,
} from './state.ts'

/** Column order and display labels (keys match the shared status vocabulary). */
const COLUMNS: readonly { key: TodoStatus; label: string }[] = [
  { key: 'pending', label: '待启动' },
  { key: 'in_progress', label: '进行中' },
  { key: 'completed', label: '已完成' },
]

/** Cycle order for the row control. */
const STATUS_ORDER: readonly TodoStatus[] = ['pending', 'in_progress', 'completed']

const ROOT: Record<string, string | number> = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  boxSizing: 'border-box',
  padding: '12px 14px',
  gap: '8px',
  overflow: 'hidden',
  fontFamily: 'ui-sans-serif, system-ui, sans-serif',
  color: 'var(--dsw-alias-label-primary)',
}

const TITLE: Record<string, string | number> = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  fontWeight: 600,
  fontSize: '14px',
}

const BOARD: Record<string, string | number> = {
  flex: 1,
  display: 'flex',
  flexDirection: 'row',
  gap: '8px',
  overflow: 'hidden',
  minHeight: 0,
}

const COLUMN: Record<string, string | number> = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: '4px',
  overflow: 'hidden',
  background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent)',
  border: '1px solid var(--dsw-alias-border-l1)',
  borderRadius: '8px',
  padding: '6px',
}

const COLUMN_HEADER: Record<string, string | number> = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  fontSize: '12px',
  fontWeight: 600,
  color: 'var(--dsw-alias-label-secondary)',
  padding: '0 2px',
}

const COLUMN_BODY: Record<string, string | number> = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: '4px',
}

const ROW: Record<string, string | number> = {
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  padding: '4px 6px',
  borderRadius: '6px',
  fontSize: '13px',
  background: 'var(--dsw-alias-bg-layer-2)',
  border: '1px solid var(--dsw-alias-border-l1)',
}

/** The todo view component (rendered inside the official conversation view). */
export function TodoView(): ReactNode {
  const refresh = useViewRefresh()
  const [list, setList] = useState<TodoListResponse>({ todos: [], counts: emptyCounts() })
  const [input, setInput] = useState('')
  const [error, setError] = useState<string | undefined>()
  const [hoverId, setHoverId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchList().then(
      (value) => { if (!cancelled) setList(value) },
      (err: unknown) => { if (!cancelled) setError(message(err)) },
    )
    return () => { cancelled = true }
  }, [refresh])

  const mutate = (promise: Promise<unknown>): void => {
    setError(undefined)
    promise.then(
      () => { requestRefresh() },
      (err: unknown) => { setError(message(err)) },
    )
  }

  const submit = (): void => {
    const content = input.trim()
    if (content === '') return
    setInput('')
    mutate(api('add', { content }))
  }

  const cycle = (item: TodoItem): void => {
    mutate(api('update', { id: item.id, status: nextStatus(item.status) }))
  }

  const remove = (item: TodoItem): void => {
    mutate(api('delete', { id: item.id }))
  }

  const clearDone = (): void => {
    mutate(api('clearDone'))
  }

  return createElement('div', { style: ROOT },
    createElement('div', { style: TITLE },
      createElement('span', null, '待办'),
      createElement('button', {
        type: 'button',
        onClick: closeTodoView,
        title: '关闭页签',
        'aria-label': '关闭页签',
        style: closeButtonStyle(),
      }, closeIcon(), createElement('span', { style: { fontSize: '12px', lineHeight: 1 } }, '关闭')),
    ),
    createElement('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
      createElement('input', {
        value: input,
        onChange: (event: { target: { value: string } }) => { setInput(event.target.value) },
        onKeyDown: (event: { key: string }) => { if (event.key === 'Enter') submit() },
        placeholder: '输入新待办，回车添加',
        style: inputStyle(),
      }),
      createElement('button', { type: 'button', onClick: submit, style: primaryButtonStyle() }, '添加'),
    ),
    error === undefined
      ? null
      : createElement('div', {
        style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px' },
      }, error),
    createElement('div', { style: BOARD },
      COLUMNS.map(column => createElement('div', { key: column.key, style: COLUMN },
        createElement('div', { style: COLUMN_HEADER },
          createElement('span', null, column.label),
          createElement('span', { style: { opacity: 0.8 } }, countFor(list, column.key)),
        ),
        createElement('div', { style: COLUMN_BODY },
          list.todos
            .filter(item => item.status === column.key)
            .map(item => createElement('div', {
              key: item.id,
              style: ROW,
              onMouseEnter: () => { setHoverId(item.id) },
              onMouseLeave: () => { setHoverId(current => current === item.id ? null : current) },
              onFocus: () => { setHoverId(item.id) },
              onBlur: () => { setHoverId(current => current === item.id ? null : current) },
            },
              createElement('button', {
                type: 'button',
                onClick: () => { cycle(item) },
                title: `点击切换到：${labelOf(nextStatus(item.status))}`,
                'aria-label': `状态：${labelOf(item.status)}，点击切换到：${labelOf(nextStatus(item.status))}`,
                style: cycleStyle(item.status),
              }, cycleGlyph(item.status)),
              createElement('span', {
                style: {
                  flex: 1,
                  textDecoration: item.status === 'completed' ? 'line-through' : 'none',
                  opacity: item.status === 'completed' ? 0.55 : 1,
                  overflowWrap: 'anywhere',
                },
              }, item.content),
              createElement('button', {
                type: 'button',
                onClick: () => { remove(item) },
                title: '删除',
                'aria-label': '删除',
                style: rowActionStyle(hoverId === item.id),
              }, closeIcon()),
            )),
          list.todos.every(item => item.status !== column.key)
            ? createElement('div', {
              style: {
                fontSize: '12px',
                color: 'var(--dsw-alias-label-secondary)',
                opacity: 0.7,
                padding: '2px',
              },
            }, '—')
            : null,
        ),
      )),
    ),
    list.counts.completed > 0
      ? createElement('div', { style: { display: 'flex', justifyContent: 'flex-end' } },
        createElement('button', { type: 'button', onClick: clearDone, style: ghostButtonStyle() }, '清除已完成'),
      )
      : null,
  )
}

/** React external-store hook for the refresh signal. */
function useViewRefresh(): number {
  return useSyncExternalStore(subscribeView, () => getViewState().refresh)
}

function countFor(list: TodoListResponse, status: TodoStatus): number {
  return list.todos.filter(item => item.status === status).length
}

function emptyCounts(): TodoCounts {
  return { pending: 0, inProgress: 0, completed: 0 }
}

function nextStatus(status: TodoStatus): TodoStatus {
  const index = STATUS_ORDER.indexOf(status)
  return STATUS_ORDER[(index + 1) % STATUS_ORDER.length] ?? 'pending'
}

function labelOf(status: TodoStatus): string {
  return COLUMNS.find(column => column.key === status)?.label ?? status
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The status-cycle control: hollow (pending), dot (in_progress), check (completed). */
function cycleStyle(status: TodoStatus): Record<string, string | number> {
  return {
    width: 18,
    height: 18,
    flexShrink: 0,
    borderRadius: 5,
    border: '1.5px solid ' + (status === 'completed'
      ? 'var(--dsw-alias-brand-primary)'
      : 'var(--dsw-alias-border-l2)'),
    background: 'transparent',
    color: 'var(--dsw-alias-brand-primary)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    padding: 0,
  }
}

function cycleGlyph(status: TodoStatus): ReactNode {
  if (status === 'completed') {
    return createElement('svg', { width: 11, height: 11, viewBox: '0 0 12 12' },
      createElement('path', {
        d: 'M2 6.5 4.8 9 10 3.5',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }),
    )
  }
  if (status === 'in_progress') {
    return createElement('span', {
      style: { width: 5, height: 5, borderRadius: '50%', background: 'var(--dsw-alias-state-warn-primary)' },
    })
  }
  return null
}

/** A compact X icon used by the close and delete buttons. */
function closeIcon(): ReactNode {
  return createElement('svg', { width: 13, height: 13, viewBox: '0 0 14 14' },
    createElement('path', {
      d: 'M3 3l8 8M11 3l-8 8',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.6,
      strokeLinecap: 'round',
    }),
  )
}

function closeButtonStyle(): Record<string, string | number> {
  return {
    border: '1px solid var(--dsw-alias-border-l2)',
    background: 'var(--dsw-alias-bg-layer-2)',
    color: 'var(--dsw-alias-label-secondary)',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    padding: '2px 8px',
    borderRadius: 6,
  }
}

function rowActionStyle(visible: boolean): Record<string, string | number> {
  return {
    border: 'none',
    background: 'transparent',
    color: 'var(--dsw-alias-label-secondary)',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 20,
    height: 20,
    borderRadius: 5,
    padding: 0,
    flexShrink: 0,
    opacity: visible ? 1 : 0,
    pointerEvents: visible ? 'auto' : 'none',
  }
}

function inputStyle(): Record<string, string | number> {
  return {
    width: 190,
    height: 30,
    boxSizing: 'border-box',
    padding: '5px 8px',
    borderRadius: '6px',
    border: '1px solid var(--dsw-alias-border-l2)',
    background: 'transparent',
    color: 'inherit',
    fontSize: '13px',
  }
}

function primaryButtonStyle(): Record<string, string | number> {
  return {
    height: 30,
    boxSizing: 'border-box',
    padding: '5px 10px',
    borderRadius: '6px',
    border: '1px solid var(--dsw-alias-border-l2)',
    background: 'var(--dsw-alias-bg-layer-2)',
    color: 'var(--dsw-alias-label-primary)',
    cursor: 'pointer',
    fontSize: '13px',
  }
}

function ghostButtonStyle(): Record<string, string | number> {
  return {
    padding: '3px 8px',
    borderRadius: '6px',
    border: '1px solid var(--dsw-alias-border-l2)',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    fontSize: '12px',
  }
}
