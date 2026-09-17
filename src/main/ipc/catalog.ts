import { ipcMain, dialog } from 'electron'
import fs from 'node:fs'
import { listZcodeModels } from '../backends/zcode-config'
import { newAgentId, saveAgents } from '../agents'
import { draftAgent, improveAgent, evaluateDraft } from '../agent-forge'
import { parseAgentMarkdown, serializeAgentMarkdown } from '../agent-exchange'
import { isForgeAgent, type AgentDraft } from '../../shared/forge'
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
  // 锻造师·评测：草稿 → should/should-not 触发命中体检（passRate 应用侧复算，不信任自报）
  ipcMain.handle('agents:evaluate', (_e, draft: unknown) => {
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return { ok: false, error: 'draft 非法' }
    const raw = draft as Record<string, unknown>
    if (typeof raw.name !== 'string' || !raw.name.trim() || typeof raw.systemPrompt !== 'string' || !raw.systemPrompt.trim()) {
      return { ok: false, error: 'draft 缺少 name/systemPrompt' }
    }
    const clean: AgentDraft = {
      name: raw.name.trim().slice(0, 32),
      systemPrompt: raw.systemPrompt.trim().slice(0, 4000),
      color: typeof raw.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw.color) ? raw.color : '#4f8cff',
      ...(typeof raw.role === 'string' && raw.role.trim() ? { role: raw.role.trim().slice(0, 40) } : {}),
      ...(typeof raw.note === 'string' && raw.note.trim() ? { note: raw.note.trim().slice(0, 200) } : {}),
      ...(typeof raw.model === 'string' && raw.model.trim() ? { model: raw.model.trim().slice(0, 64) } : {})
    }
    return evaluateDraft(ctx, clean)
  })
  // subagent Markdown 导入：系统选文件 → 草稿（渲染层复用生成确认视图；用户取消也走 {ok:false}）
  ipcMain.handle('agents:import-md', async () => {
    const picked = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'Markdown / Claude subagent', extensions: ['md'] }] })
    const file = picked.filePaths?.[0]
    if (!file) return { ok: false, error: '已取消导入' }
    try {
      return parseAgentMarkdown(fs.readFileSync(file, 'utf8'))
    } catch (err) {
      return { ok: false, error: `读取失败：${err instanceof Error ? err.message : String(err)}` }
    }
  })
  // subagent Markdown 导出：另存对话框 → 写盘（锻造师无人设，不参与导出）
  ipcMain.handle('agents:export-md', async (_e, agentId: unknown) => {
    const id = typeof agentId === 'string' ? agentId.trim() : ''
    const agent = ctx.agents.find((a) => a.id === id)
    if (!agent) return { ok: false, error: '目标 Agent 不存在' }
    if (isForgeAgent(agent)) return { ok: false, error: '锻造师无人设，无可导出' }
    const safeName = agent.name.replace(/[\\/:*?"<>|]/g, '_')
    const picked = await dialog.showSaveDialog({ defaultPath: `${safeName}.md`, filters: [{ name: 'Markdown', extensions: ['md'] }] })
    if (picked.canceled || !picked.filePath) return { ok: false, error: '已取消导出' }
    try {
      fs.writeFileSync(picked.filePath, serializeAgentMarkdown(agent), 'utf8')
      return { ok: true, path: picked.filePath }
    } catch (err) {
      return { ok: false, error: `写入失败：${err instanceof Error ? err.message : String(err)}` }
    }
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
