import { ipcMain } from 'electron'
import { listZcodeModels } from '../backends/zcode-config'
import { newAgentId, saveAgents } from '../agents'
import { draftAgent, improveAgent } from '../agent-forge'
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
  // 锻造师·生成：一句描述 → 草稿或澄清问题（answers 提供即强制出稿；失败走 {ok:false,error}，不抛异常）
  ipcMain.handle('agents:draft', (_e, description: unknown, answers: unknown) => {
    if (typeof description !== 'string' || !description.trim()) return { ok: false, error: '描述不能为空' }
    const text = description.trim()
    if (text.length > 2000) return { ok: false, error: '描述过长（最多 2000 字符）' }
    let parsedAnswers: string[] | undefined
    if (answers !== null && answers !== undefined) {
      if (!Array.isArray(answers) || answers.length > 5 || answers.some((a) => typeof a !== 'string' || a.length > 1000)) {
        return { ok: false, error: '澄清回答格式非法（最多 5 条，每条 ≤1000 字符）' }
      }
      parsedAnswers = (answers as string[]).map((a) => a.trim())
    }
    return draftAgent(ctx, text, parsedAnswers)
  })
  // 锻造师·改进：既有 agent + 反馈 → 最小改动修订（字段级 diff 由渲染层确认）
  ipcMain.handle('agents:improve', (_e, agentId: unknown, feedback: unknown) => {
    if (typeof agentId !== 'string' || !agentId.trim()) return { ok: false, error: 'agentId 非法' }
    if (typeof feedback !== 'string' || !feedback.trim()) return { ok: false, error: '反馈不能为空' }
    const text = feedback.trim()
    if (text.length > 2000) return { ok: false, error: '反馈过长（最多 2000 字符）' }
    return improveAgent(ctx, agentId.trim(), text)
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
