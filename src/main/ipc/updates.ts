// 热更 IPC（设计 §5.2，只增不改）：updates 命名空间四 handler + updates:state 事件。
import { ipcMain } from 'electron'
import type { UpdateChannel } from '../../shared/contracts'
import type { IpcContext } from './context'

function parseChannel(value: unknown): UpdateChannel {
  if (value === 'renderer' || value === 'payload' || value === 'shell') return value
  throw new Error(`updates: 未知通道 ${JSON.stringify(value)}（合法值 renderer|payload|shell）`)
}

export function registerUpdatesIpc(ctx: IpcContext) {
  ipcMain.handle('updates:get-state', () => ctx.updates.getState())
  ipcMain.handle('updates:check', () => ctx.updates.check())
  ipcMain.handle('updates:apply', (_e, channel: unknown) => ctx.updates.apply(parseChannel(channel)))
  ipcMain.handle('updates:apply-all', () => ctx.updates.applyAll())
  ipcMain.handle('updates:rollback', (_e, channel: unknown) => ctx.updates.rollback(parseChannel(channel)))
}
