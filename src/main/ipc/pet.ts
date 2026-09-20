// 桌宠 IPC 域：pet:get-state / pet:set-enabled / pet:set-pack / pet:window-event / pet:gen-*。
// ctx.pet 可选注入（照 sidecar 先例）：无桌宠 controller 的测试上下文返回 null。
import { ipcMain } from 'electron'
import { parseContent } from '../ipc-validation'
import type { IpcContext } from './context'
import { PET_STATE_IDS, type PetGenStartInput, type PetWindowEvent } from '../../shared/pet'

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
  ipcMain.handle('pet:set-zoom', (_e, zoom: unknown) => {
    if (!ctx.pet) return null
    return ctx.pet.setZoom(typeof zoom === 'number' && Number.isFinite(zoom) ? zoom : 1)
  })
  ipcMain.handle('pet:feed', (_e, foodId: unknown) => {
    if (!ctx.pet) return null
    return ctx.pet.feed(typeof foodId === 'string' ? foodId.slice(0, 40) : '')
  })
  ipcMain.handle('pet:send-chat', async (_e, text: unknown) => {
    if (!ctx.pet) return null
    return ctx.pet.sendChat(parseContent(text, '聊天内容'))
  })
  ipcMain.handle('pet:open-settings-window', () => {
    ctx.pet?.openSettingsWindow()
  })
  ipcMain.handle('pet:gen-start', (_e, input: unknown) => {
    if (!ctx.pet) return { ok: false, error: '小助理未初始化' }
    const parsed = parsePetGenStartInput(input)
    if (!parsed.ok) return parsed
    return ctx.pet.gen.start(parsed.input)
  })
  ipcMain.handle('pet:gen-cancel', () => {
    if (!ctx.pet) return { ok: false }
    ctx.pet.gen.cancel()
    return { ok: true }
  })
}

/** 窗体事件弱校验：形状不对就丢弃（渲染层是唯一来源，不抛错打断渲染） */
export function parsePetWindowEvent(value: unknown): PetWindowEvent | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as { type?: unknown; x?: unknown; y?: unknown; offsetX?: unknown; offsetY?: unknown; open?: unknown; inside?: unknown; kind?: unknown }
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : null
  switch (raw.type) {
    case 'move': {
      const x = num(raw.x)
      const y = num(raw.y)
      return x !== null && y !== null ? { type: 'move', x, y } : null
    }
    case 'drag-start':
      // offsetX/Y 是增量定位前的遗留字段：主进程已改用光标差分，缺省容忍（热更错峰期旧新互发不炸）
      return { type: 'drag-start', offsetX: num(raw.offsetX) ?? 0, offsetY: num(raw.offsetY) ?? 0 }
    case 'drag-end':
      return { type: 'drag-end' }
    case 'chat':
      return typeof raw.open === 'boolean' ? { type: 'chat', open: raw.open } : null
    case 'menu':
      return typeof raw.open === 'boolean' ? { type: 'menu', open: raw.open } : null
    case 'hover':
      return typeof raw.inside === 'boolean' ? { type: 'hover', inside: raw.inside } : null
    case 'interact':
      return raw.kind === 'click' || raw.kind === 'throw' ? { type: 'interact', kind: raw.kind } : null
    case 'open-settings':
      return { type: 'open-settings' }
    default:
      return null
  }
}

/** 生成入参校验：packId/presetId/states 白名单逐项查；错误信息不携带任何敏感值 */
export function parsePetGenStartInput(value: unknown): { ok: true; input: PetGenStartInput } | { ok: false; error: string } {
  if (!value || typeof value !== 'object') return { ok: false, error: '生成入参缺失' }
  const raw = value as Record<string, unknown>
  const packId = typeof raw.packId === 'string' ? raw.packId.trim() : ''
  if (!/^[\w-]+$/.test(packId)) return { ok: false, error: '包 id 非法（只允许字母数字下划线连字符）' }
  if (packId === 'default') return { ok: false, error: '包 id 不能为内置包保留名' }
  const presetId = typeof raw.presetId === 'string' ? raw.presetId : ''
  if (!presetId) return { ok: false, error: '请先选择模型预设' }
  const model = typeof raw.model === 'string' ? raw.model.trim() : ''
  const paramsRaw = (raw.params ?? {}) as Record<string, unknown>
  const size = typeof paramsRaw.size === 'string' && /^\d+x\d+$/.test(paramsRaw.size) ? paramsRaw.size : '1024x1024'
  const quality = typeof paramsRaw.quality === 'string' ? paramsRaw.quality : ''
  const n = typeof paramsRaw.n === 'number' && Number.isInteger(paramsRaw.n) && paramsRaw.n >= 1 && paramsRaw.n <= 4 ? paramsRaw.n : 1
  const background = paramsRaw.background === 'opaque' ? 'opaque' : 'transparent'
  const stylePrompt = typeof raw.stylePrompt === 'string' ? raw.stylePrompt.trim().slice(0, 2000) : ''
  if (!stylePrompt) return { ok: false, error: '风格提示词不能为空' }
  const states: Record<string, number> = {}
  let total = 0
  if (!raw.states || typeof raw.states !== 'object') return { ok: false, error: '帧数表缺失' }
  for (const [key, count] of Object.entries(raw.states as Record<string, unknown>)) {
    if (!(PET_STATE_IDS as readonly string[]).includes(key)) return { ok: false, error: `帧数表含白名单外的状态名：${key}` }
    if (!Number.isInteger(count) || (count as number) < 1 || (count as number) > 32) return { ok: false, error: `状态 ${key} 的帧数必须是 1–32 的整数` }
    states[key] = count as number
    total += count as number
  }
  if (total === 0) return { ok: false, error: '至少要生成一个状态' }
  if (total > 64) return { ok: false, error: '总帧数超过上限 64' }
  const mode = raw.mode === 'sheet' ? 'sheet' : 'per-frame'
  let sheet: { cols: number; rows: number } | undefined
  if (mode === 'sheet') {
    const sheetRaw = (raw.sheet ?? {}) as Record<string, unknown>
    const cols = typeof sheetRaw.cols === 'number' && Number.isInteger(sheetRaw.cols) && sheetRaw.cols >= 1 && sheetRaw.cols <= 8 ? sheetRaw.cols : 0
    const rows = typeof sheetRaw.rows === 'number' && Number.isInteger(sheetRaw.rows) && sheetRaw.rows >= 1 && sheetRaw.rows <= 8 ? sheetRaw.rows : 0
    if (!cols || !rows) return { ok: false, error: 'sheet 模式需要 1–8 的列数与行数' }
    if (cols * rows < total) return { ok: false, error: `网格 ${cols}×${rows} 放不下 ${total} 帧` }
    sheet = { cols, rows }
  }
  return { ok: true, input: { packId, presetId, model, params: { size, quality, n, background }, stylePrompt, states, mode, sheet } }
}
