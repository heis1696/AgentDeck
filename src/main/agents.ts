// Agent 身份层：Multica 式"agent 即队友"
// Agent = 名字 + 后端 + 可选模型/说明；任务可指定 agent；领队可跨 agent 派工
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { BACKEND_IDS, type BackendId } from '../shared/types'
import { FORGE_AGENT_ID, isForgeAgent } from '../shared/forge'

export interface Agent {
  id: string
  name: string
  /** 后端 id: zcode | claude | codex | opencode | dsh */
  backend: string
  /** 定位/头衔，如 领队、前端工程师 */
  role?: string
  /** 系统提示词：人设、专长、做事方式 */
  systemPrompt?: string
  /** 可驱使的队员（agent id 列表）——领队运行时可自行派发子任务 */
  subordinates?: string[]
  /** 传给后端的模型（可空 = 后端默认） */
  model?: string
  /** API 预设 id（连接覆盖：baseURL/apiKey 按会话内存注入；可空 = 平台默认连接） */
  presetId?: string
  note?: string
  /** 主题色（UI 头像） */
  color: string
}

const BACKEND_SET = new Set<string>(BACKEND_IDS)

/** Normalize persisted/user supplied agents before they cross the IPC boundary. */
export function normalizeAgent(value: unknown, fallback?: Agent): Agent | null {
  if (!value || typeof value !== 'object') return fallback ?? null
  const raw = value as Partial<Agent>
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : fallback?.id
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  const backend = typeof raw.backend === 'string' ? raw.backend.trim().toLowerCase() : ''
  if (!id || !name || !BACKEND_SET.has(backend)) return fallback ?? null
  const subordinates = Array.isArray(raw.subordinates)
    ? [...new Set(raw.subordinates.filter((id): id is string => typeof id === 'string' && Boolean(id.trim()) && id !== raw.id).map((id) => id.trim()))]
    : undefined
  return {
    id,
    name,
    backend: backend as BackendId,
    ...(typeof raw.role === 'string' && raw.role.trim() ? { role: raw.role.trim() } : {}),
    ...(typeof raw.systemPrompt === 'string' && raw.systemPrompt.trim() ? { systemPrompt: raw.systemPrompt.trim() } : {}),
    ...(subordinates?.length ? { subordinates } : {}),
    ...(typeof raw.model === 'string' && raw.model.trim() ? { model: raw.model.trim() } : {}),
    ...(typeof raw.presetId === 'string' && raw.presetId.trim() ? { presetId: raw.presetId.trim() } : {}),
    ...(typeof raw.note === 'string' && raw.note.trim() ? { note: raw.note.trim() } : {}),
    color: typeof raw.color === 'string' && raw.color.trim() ? raw.color.trim() : (fallback?.color ?? '#64748b')
  }
}

export function normalizeAgents(values: unknown): Agent[] {
  if (!Array.isArray(values)) return []
  const out: Agent[] = []
  const ids = new Set<string>()
  for (const value of values) {
    const agent = normalizeAgent(value)
    if (!agent || ids.has(agent.id)) continue
    ids.add(agent.id)
    out.push(agent)
  }
  // Remove subordinate references to deleted agents and self references.
  return out.map((agent) => ({
    ...agent,
    ...(agent.subordinates
      ? { subordinates: agent.subordinates.filter((id) => id !== agent.id && ids.has(id)) }
      : {})
  }))
}

const file = () => path.join(app.getPath('userData'), 'agents.json')

/** 预置队伍：每个可用后端一个默认队员 */
export function defaultAgents(): Agent[] {
  return [
    { id: 'ag_zcode', name: 'ZetCode', backend: 'zcode', color: '#4f8cff', role: '领队', systemPrompt: '你是开发领队，负责拆解任务、统筹进度与汇总结论。琐碎小事亲自做，需要并行或专业领域的工作派给队员，并对每轮结果给出评估与审核。', subordinates: ['ag_claude', 'ag_codex', 'ag_opencode', 'ag_dsh'] },
    { id: 'ag_claude', name: 'Claude', backend: 'claude', color: '#d97757', role: '工程师', systemPrompt: '你是资深全栈工程师，专注高质量代码实现。动手前先读现有代码与约定，改动与周边风格保持一致；关键路径用测试验证，不确定的假设标注出来而不是猜。' },
    { id: 'ag_codex', name: 'Codex', backend: 'codex', color: '#8b95a5', role: '工程师', systemPrompt: '你是务实的工程师，按指令完成编码与文档任务。产出以可直接使用为准：改动最小、交代清楚；指令含糊时按最合理的理解执行并说明所做假设。' },
    { id: 'ag_opencode', name: 'OpenCode', backend: 'opencode', color: '#c084fc', role: '工程师', systemPrompt: '你是通用工程师，负责补位各类常规开发工作：代码修改、脚本编写、配置调整与小范围调研。按指令直达目标，拿不准的先问清再动手。' },
    { id: 'ag_dsh', name: 'DeepSeek', backend: 'dsh', color: '#4d6bfe', role: '分析员', systemPrompt: '你是分析员，负责调研、分析与方案对比。结论必须给依据（代码位置、数据、文档出处）；多方案时列出取舍维度并给推荐；不臆测查不到的事实，明确标注不确定项。' },
    // 锻造师：agents:draft 的生成引擎；系统提示词由 agent-crafter 技能提供（agent-forge.ts），故不设 systemPrompt
    { id: FORGE_AGENT_ID, name: '锻造师', backend: 'zcode', color: '#f59e0b', role: '锻造', note: '专职生成其它 Agent——改我的平台/模型即换生成引擎；无需系统提示词（由 agent-crafter 技能提供）' }
  ]
}

export function loadAgents(): Agent[] {
  let saved: Agent[] | null = null
  try {
    const raw = fs.readFileSync(file(), 'utf8')
    const list = normalizeAgents(JSON.parse(raw))
    if (list.length) saved = list
  } catch {}
  if (!saved) return defaultAgents()
  // 迁移：补上保存文件里缺失的平台预置队员（如新增的 dsh）
  const have = new Set(saved.map((a) => a.backend))
  // 锻造师按 id 补缺：平台与领队同为 zcode，按 backend 补缺盖不住它
  const missing = defaultAgents().filter((d) => !have.has(d.backend) && !isForgeAgent(d))
  const haveIds = new Set(saved.map((a) => a.id))
  const forge = defaultAgents().find(isForgeAgent)
  if (forge && !haveIds.has(forge.id)) missing.push(forge)
  const merged = missing.length ? dedupeAgentNames([...saved, ...missing]) : dedupeAgentNames(saved)
  return merged
}

/**
 * 队内重名消解：委派按名字匹配队员（delegate.ts），重名会产生歧义。
 * 同名者（不区分大小写）自动追加 " 2"/"3" 后缀；保存与加载都过一遍。
 */
export function dedupeAgentNames(agents: Agent[]): Agent[] {
  const seen = new Map<string, number>()
  return agents.map((a) => {
    const key = a.name.toLowerCase()
    const n = (seen.get(key) ?? 0) + 1
    seen.set(key, n)
    return n === 1 ? a : { ...a, name: `${a.name} ${n}` }
  })
}

export function saveAgents(agents: Agent[]): Agent[] {
  agents = dedupeAgentNames(normalizeAgents(agents))
  fs.mkdirSync(path.dirname(file()), { recursive: true })
  fs.writeFileSync(file(), JSON.stringify(agents, null, 2))
  return agents
}

export function newAgentId(): string {
  return `ag_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}
