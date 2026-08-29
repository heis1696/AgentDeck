// Agent 身份层：Multica 式"agent 即队友"
// Agent = 名字 + 后端 + 可选模型/说明；任务可指定 agent；squad 可跨 agent 派工
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

export interface Agent {
  id: string
  name: string
  /** 后端 id: zcode | claude | codex | opencode */
  backend: string
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
    { id: 'ag_zcode', name: 'ZetCode', backend: 'zcode', color: '#4f8cff', note: 'GLM，常驻会话，全能主力' },
    { id: 'ag_claude', name: 'Claude', backend: 'claude', color: '#d97757', note: 'Claude Code' },
    { id: 'ag_codex', name: 'Codex', backend: 'codex', color: '#8b95a5', note: 'OpenAI Codex' },
    { id: 'ag_opencode', name: 'OpenCode', backend: 'opencode', color: '#c084fc', note: 'OpenCode' },
    { id: 'ag_dsh', name: 'DeepSeek', backend: 'dsh', color: '#4d6bfe', note: 'DeepSeek Harness，一次性无头' }
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
