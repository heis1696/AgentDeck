import type { IpcContext } from './context'
import { registerCatalogIpc } from './catalog'
import { registerGoalIpc } from './goals'
import { registerIssueIpc } from './issues'
import { registerSkillsIpc } from './skills'
import { registerSystemIpc } from './system'
import { registerTaskIpc } from './tasks'

export type { CreateTaskInput } from './context'

export function registerIpcHandlers(ctx: IpcContext) {
  registerGoalIpc(ctx)
  registerTaskIpc(ctx)
  registerIssueIpc(ctx)
  registerCatalogIpc(ctx)
  registerSkillsIpc(ctx)
  registerSystemIpc(ctx)
}
