// 锻造师（agent 生成器）共享契约：主进程 agents:draft / agents:improve 与渲染层共用的常量与类型
export const FORGE_AGENT_ID = 'ag_forge'
export const FORGE_SKILL_NAME = 'agent-crafter'
/** 技能内容版本：内置正文升级时 +1；共享目录里用户编辑过的旧版不强制覆盖 */
export const FORGE_SKILL_VERSION = 3

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

/** 导入 .md（Claude subagent 格式）→ 草稿（复用生成确认视图；backend 等仍人工配置） */
export type ImportResult = { ok: true; draft: AgentDraft } | { ok: false; error: string }

/** 导出 .md 结果（path 为写盘路径；用户取消也走 {ok:false}） */
export type ExportResult = { ok: true; path: string } | { ok: false; error: string }

/** 触发评测单条判定：input 为典型任务，shouldMatch 为应有归属，matched 为锻造师判定归属 */
export interface EvaluateVerdict {
  input: string
  shouldMatch: boolean
  matched: boolean
}

/** 评测结果：passRate 由应用侧按 verdicts 复算（matched === shouldMatch 的占比），不信任模型自报 */
export interface EvaluateOutcome {
  verdicts: EvaluateVerdict[]
  passRate: number
  suggestion?: string
}

export type EvaluateResult = { ok: true; outcome: EvaluateOutcome } | { ok: false; error: string }

export function isForgeAgent(agent: { id: string }): boolean {
  return agent.id === FORGE_AGENT_ID
}
