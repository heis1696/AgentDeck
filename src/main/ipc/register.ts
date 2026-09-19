import type { IpcContext } from './context'
import { registerCatalogIpc } from './catalog'
import { registerExtensionsIpc } from './extensions'
import { registerGoalIpc } from './goals'
import { registerMeetingIpc } from './meetings'
import { registerIssueIpc } from './issues'
import { registerPetIpc } from './pet'
import { registerSkillsIpc } from './skills'
import { registerSystemIpc } from './system'
import { registerTaskIpc } from './tasks'
import { registerUpdatesIpc } from './updates'

export type { CreateTaskInput } from './context'

export function registerIpcHandlers(ctx: IpcContext) {
  registerGoalIpc(ctx)
  registerMeetingIpc(ctx)
  registerTaskIpc(ctx)
  registerIssueIpc(ctx)
  registerCatalogIpc(ctx)
  registerSkillsIpc(ctx)
  registerExtensionsIpc(ctx)
  registerPetIpc(ctx)
  registerSystemIpc(ctx)
  registerUpdatesIpc(ctx)
}
