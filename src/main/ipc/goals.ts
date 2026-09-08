import { ipcMain } from 'electron'
import { parseGoalCheckpoint, parseGoalCreate, parseId } from '../ipc-validation'
import type { IpcContext } from './context'

export function registerGoalIpc(ctx: IpcContext) {
  ipcMain.handle('goals:list', () => ctx.goalController.list())
  ipcMain.handle('goals:get', (_e, id: unknown) => ctx.goalController.get(parseId(id, 'goalId')) ?? null)
  ipcMain.handle('goals:create', (_e, input: unknown) => ctx.goalController.create(parseGoalCreate(input)))
  ipcMain.handle('goals:runs', (_e, id: unknown) => ctx.goalController.runs(parseId(id, 'goalId')))
  ipcMain.handle('goals:checkpoints', (_e, id: unknown) => ctx.goalController.checkpoints(parseId(id, 'goalId')))
  ipcMain.handle('goals:start', (_e, id: unknown) => ctx.goalController.start(parseId(id, 'goalId')))
  ipcMain.handle('goals:pause', (_e, id: unknown) => ctx.goalController.pause(parseId(id, 'goalId')))
  ipcMain.handle('goals:resume', (_e, id: unknown) => ctx.goalController.resume(parseId(id, 'goalId')))
  ipcMain.handle('goals:continue', (_e, id: unknown) => ctx.goalController.continue(parseId(id, 'goalId')))
  ipcMain.handle('goals:cancel', (_e, id: unknown) => ctx.goalController.cancel(parseId(id, 'goalId')))
  ipcMain.handle('goals:checkpoint', (_e, id: unknown, input: unknown) => ctx.goalController.checkpoint(parseId(id, 'goalId'), parseGoalCheckpoint(input)))
}
