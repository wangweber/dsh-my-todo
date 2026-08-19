/**
 * dsh-my-todo host half: owns the global todo store, exposes the `my_todo`
 * tool and the `/todo` slash command, and serves the browser data route.
 *
 * Every registration is an effect owned by this plugin's fiber, so HMR and
 * unload tear everything down (official Cordis discipline).
 * @module dsh-my-todo
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { registerTodoCommand } from './command.ts'
import { registerTodoRoutes } from './routes.ts'
import { TodoStore } from './store.ts'
import { registerTodoTool } from './tool.ts'

export type { TodoItem, TodoResult } from './types.ts'
export { TodoError, TodoStore } from './store.ts'

/** Plugin configuration. */
export interface Config {
  /** Absolute path of the todo document; defaults to `$DSH_HOME/todos.json`. */
  file?: string
}

export const Config: Schema<Config> = Schema.object({
  file: Schema.string(),
})

export const name = 'my-todo'

/** The `tools` service is required; commands and webServer are optional. */
export const inject = ['tools']

export function apply(ctx: Context, config: Config): void {
  const store = new TodoStore(config.file ?? join(resolveDshHome(), 'todos.json'))
  ctx.provide('todoStore', store)
  ctx.effect(() => () => store.dispose(), 'my-todo: store teardown')

  registerTodoTool(ctx, store)

  // Optional-but-reactive services: mount the slash command and the browser
  // route only once their owning services are ready (official ctx.inject
  // pattern). In a headless profile neither service ever appears and these
  // child fibers simply stay pending without blocking anything.
  ctx.inject(['commands'], (childCtx) => {
    registerTodoCommand(childCtx.commands, store)
  })
  ctx.inject(['webServer'], (childCtx) => {
    registerTodoRoutes(childCtx.webServer, store)
  })
}
