// Agent 身份层：Multica 式"agent 即队友"
// Agent = 名字 + 后端 + 可选模型/说明；任务可指定 agent；squad 可跨 agent 派工
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

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
  note?: string
  /** 主题色（UI 头像） */
  color: string
}

const file = () => path.join(app.getPath('userData'), 'agents.json')

/** 预置队伍：每个可用后端一个默认队员 */
export function defaultAgents(): Agent[] {
  return [
    { id: 'ag_zcode', name: 'ZetCode', backend: 'zcode', color: '#4f8cff', role: '领队', systemPrompt: '你是开发领队，擅长拆解任务与统筹。小任务亲自做，需要并行或专业领域工作时派给队员。', subordinates: ['ag_claude', 'ag_codex', 'ag_opencode', 'ag_dsh'] },
    { id: 'ag_claude', name: 'Claude', backend: 'claude', color: '#d97757', role: '工程师', systemPrompt: '你是资深全栈工程师，专注高质量代码实现。' },
    { id: 'ag_codex', name: 'Codex', backend: 'codex', color: '#8b95a5', role: '工程师', systemPrompt: '你是务实的工程师，擅长按指令完成编码与文档任务。' },
    { id: 'ag_opencode', name: 'OpenCode', backend: 'opencode', color: '#c084fc', role: '工程师', systemPrompt: '你是通用工程师。' },
    { id: 'ag_dsh', name: 'DeepSeek', backend: 'dsh', color: '#4d6bfe', role: '分析员', systemPrompt: '你是分析员，擅长调研、分析与方案对比。' }
  ]
}

export function loadAgents(): Agent[] {
  let saved: Agent[] | null = null
  try {
    const raw = fs.readFileSync(file(), 'utf8')
    const list = JSON.parse(raw)
    if (Array.isArray(list) && list.length) saved = list
  } catch {}
  if (!saved) return defaultAgents()
  // 迁移：补上保存文件里缺失的平台预置队员（如新增的 dsh）
  const have = new Set(saved.map((a) => a.backend))
  const missing = defaultAgents().filter((d) => !have.has(d.backend))
  return missing.length ? [...saved, ...missing] : saved
}

export function saveAgents(agents: Agent[]): Agent[] {
  fs.mkdirSync(path.dirname(file()), { recursive: true })
  fs.writeFileSync(file(), JSON.stringify(agents, null, 2))
  return agents
}

export function newAgentId(): string {
  return `ag_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}
