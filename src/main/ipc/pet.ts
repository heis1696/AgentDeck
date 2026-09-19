// 桌宠 IPC 域：pet:get-state / pet:set-enabled / pet:set-pack / pet:window-event。
// ctx.pet 可选注入（照 sidecar 先例）：无桌宠 controller 的测试上下文返回 null。
import { ipcMain } from 'electron'
import { parseContent } from '../ipc-validation'
import type { IpcContext } from './context'
import type { PetWindowEvent } from '../../shared/pet'

export function registerPetIpc(ctx: IpcContext) {
  ipcMain.handle('pet:get-state', () => ctx.pet ? ctx.pet.getState() : null)
  ipcMain.handle('pet:set-enabled', (_e, value: unknown) => {
    if (!ctx.pet) return null
    return ctx.pet.setEnabled(value === true)
  })
  ipcMain.handle('pet:set-pack', (_e, packId: unknown) => {
    if (!ctx.pet) return null
    return ctx.pet.setPack(parseContent(packId, 'packId'))
  })
  ipcMain.on('pet:window-event', (_e, event: unknown) => {
    if (!ctx.pet) return
    const parsed = parsePetWindowEvent(event)
    if (parsed) ctx.pet.onWindowEvent(parsed)
  })
  ipcMain.handle('pet:get-pack-assets', (_e, packId: unknown) => {
    if (!ctx.pet) return null
    return ctx.pet.getPackAssets(parseContent(packId, 'packId'))
  })
  ipcMain.handle('pet:set-persona', (_e, text: unknown) => {
    if (!ctx.pet) return null
    return ctx.pet.setPersona(parseContent(text, 'persona'))
  })
  ipcMain.handle('pet:set-autonomy', (_e, sec: unknown) => {
    if (!ctx.pet) return null
    return ctx.pet.setAutonomy(typeof sec === 'number' && Number.isFinite(sec) ? sec : 90)
  })
  ipcMain.handle('pet:set-preset', (_e, presetId: unknown, model: unknown) => {
    if (!ctx.pet) return null
    return ctx.pet.setPreset(typeof presetId === 'string' ? presetId : '', typeof model === 'string' ? model : undefined)
  })
  ipcMain.handle('pet:send-chat', async (_e, text: unknown) => {
    if (!ctx.pet) return null
    return ctx.pet.sendChat(parseContent(text, '聊天内容'))
  })
}

/** 窗体事件弱校验：形状不对就丢弃（渲染层是唯一来源，不抛错打断渲染） */
export function parsePetWindowEvent(value: unknown): PetWindowEvent | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as { type?: unknown; x?: unknown; y?: unknown; offsetX?: unknown; offsetY?: unknown; open?: unknown }
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : null
  switch (raw.type) {
    case 'move': {
      const x = num(raw.x)
      const y = num(raw.y)
      return x !== null && y !== null ? { type: 'move', x, y } : null
    }
    case 'drag-start': {
      const offsetX = num(raw.offsetX)
      const offsetY = num(raw.offsetY)
      return offsetX !== null && offsetY !== null ? { type: 'drag-start', offsetX, offsetY } : null
    }
    case 'drag-end':
      return { type: 'drag-end' }
    case 'chat':
      return typeof raw.open === 'boolean' ? { type: 'chat', open: raw.open } : null
    default:
      return null
  }
}
