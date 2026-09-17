// 锻造师（agent 生成器）共享契约：主进程 agents:draft / agents:improve 与渲染层共用的常量与类型
export const FORGE_AGENT_ID = 'ag_forge'
export const FORGE_SKILL_NAME = 'agent-crafter'
/** 技能内容版本：内置正文升级时 +1；共享目录里用户编辑过的旧版不强制覆盖 */
export const FORGE_SKILL_VERSION = 2

/** 草稿/改进产物字段（白名单；backend/presetId/subordinates 永不生成） */
export interface AgentDraft {
  name: string
  role?: string
  systemPrompt: string
  note?: string
  color: string
  model?: string
}

/** 生成结果三形态：草稿 / 澄清追问（最多 3 问，UI 收集回答后带 answers 重试）/ 失败 */
export type DraftResult =
  | { ok: true; kind: 'draft'; draft: AgentDraft }
  | { ok: true; kind: 'clarify'; questions: string[] }
  | { ok: false; error: string }

/** 改进结果：draft 为全套六字段（未涉及字段原样保留）；changes 为改动摘要（1-3 条） */
export interface ImproveOutcome {
  draft: AgentDraft
  changes: string[]
}

export type ImproveResult = { ok: true; outcome: ImproveOutcome } | { ok: false; error: string }

export function isForgeAgent(agent: { id: string }): boolean {
  return agent.id === FORGE_AGENT_ID
}
