import { ipcMain } from 'electron'
import { listZcodeModels } from '../backends/zcode-config'
import { newAgentId, saveAgents } from '../agents'
import { fetchPresetModels, newPresetId, savePresets } from '../presets'
import { parseAgents, parseAutomationCreate, parseAutomationUpdate, parseBackendId, parseId, parsePresets } from '../ipc-validation'
import type { IpcContext } from './context'

export function registerCatalogIpc(ctx: IpcContext) {
  ipcMain.handle('automations:list', () => ctx.automationStore.list())
  ipcMain.handle('automations:create', (_e, input: unknown) => ctx.automationStore.create(parseAutomationCreate(input)))
  ipcMain.handle('automations:update', (_e, id: unknown, patch: unknown) => ctx.automationStore.update(parseId(id, 'automationId'), parseAutomationUpdate(patch)))
  ipcMain.handle('automations:delete', (_e, id: unknown) => ({ ok: ctx.automationStore.remove(parseId(id, 'automationId')) }))
  ipcMain.handle('automations:run-now', (_e, id: unknown) => {
    const task = ctx.runAutomation(parseId(id, 'automationId'))
    return task ? { ok: true, task } : { ok: false, error: 'Automation is disabled or incomplete' }
  })

  ipcMain.handle('agents:list', () => ctx.agents)
  ipcMain.handle('agents:save', (_e, list: unknown) => {
    ctx.agents = saveAgents(parseAgents(list).filter((agent) => ctx.backends.has(agent.backend)))
    return ctx.agents
  })
  ipcMain.handle('agents:new-id', () => newAgentId())
  ipcMain.handle('agents:models', (_e, backendId: unknown) => {
    const id = parseBackendId(backendId)
    if (id === 'zcode') {
      const catalog = listZcodeModels()
      if (catalog.models.length) return { backend: id, source: 'catalog', default: catalog.defaultModel, models: catalog.models }
    }
    const common: Record<string, string[]> = { claude: ['sonnet', 'opus', 'haiku'], codex: ['gpt-5.5', 'gpt-5.2-codex'], opencode: [], dsh: [] }
    return { backend: id, source: 'freeform', models: common[id] ?? [] }
  })

  ipcMain.handle('presets:list', () => ctx.presets)
  ipcMain.handle('presets:save', (_e, list: unknown) => { ctx.presets = savePresets(parsePresets(list)); return ctx.presets })
  ipcMain.handle('presets:new-id', () => newPresetId())
  ipcMain.handle('presets:models', async (_e, id: unknown) => {
    const preset = ctx.presets.find((item) => item.id === parseId(id, 'presetId'))
    if (!preset) throw new Error('预设不存在')
    return { backend: preset.backend, source: 'catalog', models: await fetchPresetModels(preset) } as const
  })
}
