/**
 * Host HTTP route for the browser half: one exact `/todo/api` POST route with
 * JSON `{ method, payload }` bodies, protected by the same browser trust
 * fence the official `/api` gateway applies.
 *
 * The fence logic is a faithful port of the official implementation in
 * `@deepseek-ai/dsh-client-connection` (`src/api-request-trust.ts` +
 * `src/loopback-hostname.ts`): Host-header parsing (DNS-rebinding defense),
 * loopback/trusted-host classification, a `sec-fetch-site: cross-site`
 * refusal, and an Origin equality check when a browser attaches one.
 * @module dsh-my-todo/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import type { TodoCounts, TodoItem } from './types.ts'
import { countTodos } from './types.ts'
import { TodoError, type TodoStore } from './store.ts'

const MAX_BODY_BYTES = 64 * 1024

interface ApiRequest {
  method?: string
  payload?: Record<string, unknown>
}

interface ApiResponse {
  ok: boolean
  value?: unknown
  error?: { code: string; message: string }
}

/** Register the browser data route on the official web server service. */
export function registerTodoRoutes(webServer: WebServer, store: TodoStore): void {
  webServer.register({
    kind: 'exact',
    path: '/todo/api',
    handler: async (req, res) => {
      try {
        if (req.method !== 'POST') {
          writeJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'POST required' } })
          return
        }
        if (!isTrustedApiRequest(req)) {
          writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
          return
        }
        const body = await readJson(req)
        const method = body.method
        const payload = body.payload ?? {}
        await dispatch(store, method, payload, res)
      } catch (error: unknown) {
        const message = error instanceof TodoError ? error.message : 'internal error'
        writeJson(res, error instanceof TodoError ? 400 : 500, {
          ok: false,
          error: { code: 'todo-error', message },
        })
      }
    },
  })
}

async function dispatch(
  store: TodoStore,
  method: string | undefined,
  payload: Record<string, unknown>,
  res: ServerResponse,
): Promise<void> {
  const todos = (): Promise<TodoItem[]> => store.list()
  const counts = (list: readonly TodoItem[]): TodoCounts => countTodos(list)
  switch (method) {
    case 'list': {
      const list = await todos()
      writeJson(res, 200, { ok: true, value: { todos: list, counts: counts(list) } })
      return
    }
    case 'add': {
      const item = await store.add(String(payload.content ?? ''))
      const list = await todos()
      writeJson(res, 200, { ok: true, value: { item, todos: list, counts: counts(list) } })
      return
    }
    case 'update': {
      const item = await store.update(String(payload.id ?? ''), {
        ...payload.content === undefined ? {} : { content: String(payload.content) },
        ...payload.status === undefined ? {} : { status: String(payload.status) as TodoItem['status'] },
      })
      const list = await todos()
      writeJson(res, 200, { ok: true, value: { item, todos: list, counts: counts(list) } })
      return
    }
    case 'delete': {
      await store.remove(String(payload.id ?? ''))
      const list = await todos()
      writeJson(res, 200, { ok: true, value: { todos: list, counts: counts(list) } })
      return
    }
    case 'clearDone': {
      const removed = await store.clearCompleted()
      const list = await todos()
      writeJson(res, 200, { ok: true, value: { removed, todos: list, counts: counts(list) } })
      return
    }
    default:
      writeJson(res, 400, {
        ok: false,
        error: { code: 'unknown-method', message: `unknown method: ${String(method)}` },
      })
  }
}

/** Parse the Host header into a WHATWG-style URL authority. */
function parseAuthority(host: string): URL | undefined {
  try {
    return new URL(`http://${host}`)
  } catch {
    return undefined
  }
}

/** Loopback classification: localhost, [::1], or any 127/8 address. */
function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/**
 * Browser trust fence (official logic, reduced to the loopback posture the
 * shipped Web profile uses by default; trusted-host authorities are not
 * configured by this plugin).
 */
function isTrustedApiRequest(req: IncomingMessage): boolean {
  const host = req.headers.host
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

async function readJson(req: IncomingMessage): Promise<ApiRequest> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > MAX_BODY_BYTES) throw new TodoError('请求体过大')
    chunks.push(buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw.trim() === '') return {}
  const parsed = JSON.parse(raw) as Partial<ApiRequest>
  if (typeof parsed !== 'object' || parsed === null) throw new TodoError('请求体必须是 JSON 对象')
  return parsed
}

function writeJson(res: ServerResponse, status: number, body: ApiResponse): void {
  const raw = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(raw),
  })
  res.end(raw)
}
