import { ipcMain } from 'electron'
import { parseGoalCheckpoint, parseGoalCreate, parseGoalEvolve, parseId } from '../ipc-validation'
import type { IpcContext } from './context'

export function registerGoalIpc(ctx: IpcContext) {
  ipcMain.handle('goals:list', () => ctx.goalController.list())
  ipcMain.handle('goals:get', (_e, id: unknown) => ctx.goalController.get(parseId(id, 'goalId')) ?? null)
  ipcMain.handle('goals:create', (_e, input: unknown) => ctx.goalController.create(parseGoalCreate(input)))
  ipcMain.handle('goals:runs', (_e, id: unknown) => ctx.goalController.runs(parseId(id, 'goalId')))
  ipcMain.handle('goals:checkpoints', (_e, id: unknown) => ctx.goalController.checkpoints(parseId(id, 'goalId')))
  ipcMain.handle('goals:snapshots', (_e, id: unknown) => ctx.goalController.snapshots(parseId(id, 'goalId')))
  ipcMain.handle('goals:evolve', (_e, id: unknown, input: unknown) => ctx.goalController.evolve(parseId(id, 'goalId'), parseGoalEvolve(input)))
  ipcMain.handle('goals:rollback', (_e, id: unknown, generation: unknown) => ctx.goalController.rollback(parseId(id, 'goalId'), generation as number))
  ipcMain.handle('goals:start', (_e, id: unknown) => ctx.goalController.start(parseId(id, 'goalId')))
  ipcMain.handle('goals:pause', (_e, id: unknown) => ctx.goalController.pause(parseId(id, 'goalId')))
  ipcMain.handle('goals:resume', (_e, id: unknown) => ctx.goalController.resume(parseId(id, 'goalId')))
  ipcMain.handle('goals:continue', (_e, id: unknown) => ctx.goalController.continue(parseId(id, 'goalId')))
  ipcMain.handle('goals:cancel', (_e, id: unknown) => ctx.goalController.cancel(parseId(id, 'goalId')))
  ipcMain.handle('goals:delete', (_e, id: unknown) => {
    const goalId = parseId(id, 'goalId')
    const result = ctx.goalController.remove(goalId)
    // 广播删除：看板角标 / 详情面板即时摘掉该目标（渲染层无法从 update 事件得知删除）
    if (result.ok) ctx.getWindow()?.webContents.send('goals:deleted', goalId)
    return result
  })
  ipcMain.handle('goals:checkpoint', (_e, id: unknown, input: unknown) => ctx.goalController.checkpoint(parseId(id, 'goalId'), parseGoalCheckpoint(input)))
}
