import type { IpcContext } from './context'
import { registerCatalogIpc } from './catalog'
import { registerGoalIpc } from './goals'
import { registerIssueIpc } from './issues'
import { registerSystemIpc } from './system'
import { registerTaskIpc } from './tasks'

export type { CreateTaskInput } from './context'

export function registerIpcHandlers(ctx: IpcContext) {
  registerGoalIpc(ctx)
  registerTaskIpc(ctx)
  registerIssueIpc(ctx)
  registerCatalogIpc(ctx)
  registerSystemIpc(ctx)
}
