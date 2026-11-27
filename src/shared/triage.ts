// 动态思考强度与分诊师（ag_triage）共享契约：主进程、preload 与渲染层共用的常量、类型与纯函数。
import type { ThinkingLevel, ThinkingSource } from './types'
import { isForgeAgent } from './forge'

export const TRIAGE_AGENT_ID = 'ag_triage'
export const TRIAGE_SKILL_NAME = 'thinking-triage'
/** 技能内容版本：内置正文升级时 +1（同时把旧正文逐字追加进 prompts/triage.ts 的 TRIAGE_SKILL_BODIES_PREVIOUS） */
export const TRIAGE_SKILL_VERSION = 1

export function isTriageAgent(agent: { id: string }): boolean {
  return agent.id === TRIAGE_AGENT_ID
}

/** 系统内置专用 Agent（锻造师 + 分诊师）：不进常规任务/委派/会议/自动化/目标执行名单，不可导出或被锻造师改进 */
export function isSystemAgent(agent: { id: string }): boolean {
  return isForgeAgent(agent) || isTriageAgent(agent)
}

export const THINKING_RANK: Readonly<Record<ThinkingLevel, number>> = {
  off: 0,
  low: 1,
  medium: 2,
  high: 3,
  max: 4
}

const THINKING_ORDER: readonly ThinkingLevel[] = ['off', 'low', 'medium', 'high', 'max']

/** 自动升档安全网纯函数：off→low→medium→high→max；已到 max 返回 null */
export function nextEscalatedThinkingLevel(current?: ThinkingLevel): ThinkingLevel | null {
  if (!current) return 'high'
  const idx = THINKING_ORDER.indexOf(current)
  if (idx < 0 || idx >= THINKING_ORDER.length - 1) return null
  return THINKING_ORDER[idx + 1]
}

export type TriageAssessKind = 'task' | 'followup' | 'delegate' | 'goal' | 'handoff'

export interface TriageAssessInput {
  /** 前端请求标识，供 triage:cancel 精确中止 */
  requestId?: string
  prompt: string
  handoff?: string
  agentId?: string
  workdir?: string
  /** 追问场景携带：当前任务已生效档位，供迟滞防抖与分诊参考 */
  currentThinking?: ThinkingLevel
  kind: TriageAssessKind
}

export interface TriageDecision {
  level: ThinkingLevel
  reason: string
  /** 追问迟滞保缓存触发时：rawLevel 为分诊师原始建议，level 为最终采纳档位 */
  rawLevel?: ThinkingLevel
  cachePreserved?: boolean
  source: Extract<ThinkingSource, 'triage' | 'fallback'>
  via: 'preset-http' | 'backend-cli' | 'fallback'
  durationMs: number
}

export type TriageAssessResult =
  | { ok: true; decision: TriageDecision }
  | { ok: false; error: string; fallback: ThinkingLevel; cancelled?: boolean }
