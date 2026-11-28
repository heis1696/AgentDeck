// 分诊师引擎（动态思考强度评估）：不 import electron，纯 Node + 依赖注入，供主进程 IPC、runner RouteThinkingNode 与 smoke 共用。
// 双通路执行：
//   1. 快通路（优先，~0.5–1.5s）：分诊师绑定了 API 预设（presetId + model）→ 复用 pet-llm.ts 零依赖 HTTP fetch 直连；
//   2. 兜底通路（零额外配置）：未绑预设 → 回退 backend.start 单回合（权限全 deny，硬超时 15s）。
// Fail-open 契约：超时/网络失败/非 JSON 一律降级返回 { ok: false, fallback: 'medium' }，绝不抛异常阻断任务执行。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isThinkingLevel, type AgentThinking, type ThinkingLevel } from '../shared/types'
import {
  isTriageAgent,
  THINKING_RANK,
  TRIAGE_AGENT_ID,
  TRIAGE_SKILL_NAME,
  TRIAGE_SKILL_VERSION,
  type TriageAssessInput,
  type TriageAssessResult,
  type TriageDecision
} from '../shared/triage'
import {
  buildTriageMessages,
  buildTriagePrompt,
  TRIAGE_SKILL_BODIES_PREVIOUS,
  TRIAGE_SKILL_BODY,
  TRIAGE_SKILL_MD,
  type TriagePromptContext
} from './prompts/triage'
import { parseFrontmatter, skillsDir } from './skills'
import { chatCompletion as defaultChatCompletion } from './pet/pet-llm'
import type { ApiPreset } from './presets'
import type { AgentBackend, BackendSession, BackendTurnResult } from './backends/types'

/** 分诊兜底超时默认上限：5 分钟（可经 settings.triageTimeoutMs 调节；前端随时可点跳过立即中止） */
export const TRIAGE_HTTP_TIMEOUT_MS = 300_000
export const TRIAGE_CLI_TIMEOUT_MS = 300_000
/** Fail-open 默认兜底档位 */
export const TRIAGE_FALLBACK_LEVEL: ThinkingLevel = 'medium'

/** 派发协议标记：混进 reason 可能污染时间线/回灌，逐项剥离 */
const DISPATCH_TAG_RE = /<\/?(?:delegate|consult|investigate|continue|round|review)\b[^>]*>/gi

export interface TriageAgentLike {
  id: string
  name: string
  backend: string
  role?: string
  subordinates?: string[]
  model?: string
  presetId?: string
  thinking?: AgentThinking
}

export interface TriageDeps {
  agents: readonly TriageAgentLike[]
  presets: readonly ApiPreset[]
  backends: ReadonlyMap<string, AgentBackend>
  mode: string
  sharedDir: string
  /** CLI 回退通路的工作目录（默认 os.homedir()，避免误入用户项目目录） */
  homedir?: string
  /** 测试桩注入（生产默认 pet-llm.ts 的 chatCompletion） */
  chatCompletion?: typeof defaultChatCompletion
  /** 统一分诊超时上限（来自 settings.triageTimeoutMs，默认 5 分钟） */
  timeoutMs?: number
  httpTimeoutMs?: number
  cliTimeoutMs?: number
}

const DEFAULT_TRIAGE_AGENT: TriageAgentLike = {
  id: TRIAGE_AGENT_ID,
  name: '分诊师',
  backend: 'zcode',
  thinking: 'off',
  role: '分诊'
}

/**
 * 内置 thinking-triage 技能落盘/升级：<sharedDir>/skills/thinking-triage/SKILL.md
 * 升级规则同 ensureForgeSkill：已是当前版或用户编辑过旧版 → 尊重现状；仅未编辑旧版自动升级。
 */
export function ensureTriageSkill(sharedDir: string): void {
  const file = path.join(skillsDir(sharedDir), TRIAGE_SKILL_NAME, 'SKILL.md')
  try {
    const { data, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'))
    if (Number(data.version) >= TRIAGE_SKILL_VERSION) return
    const trimmed = body.trim()
    if (!TRIAGE_SKILL_BODIES_PREVIOUS.some((prev) => prev.trim() === trimmed)) return
  } catch {}
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, TRIAGE_SKILL_MD)
}

/** 技能正文：共享目录里用户编辑过的版本优先；缺失或读不到退回内置正文 */
export function resolveTriageSkillBody(sharedDir: string): string {
  try {
    const raw = fs.readFileSync(path.join(skillsDir(sharedDir), TRIAGE_SKILL_NAME, 'SKILL.md'), 'utf8')
    const { body } = parseFrontmatter(raw)
    if (body.trim()) return body
  } catch {}
  return TRIAGE_SKILL_BODY
}

/** 解析分诊师回复 JSON：剥代码围栏 → 截首尾 {} → 严格校验 level ∈ 5 档、清洗 reason */
export function parseTriageResponse(response: string): { ok: true; level: ThinkingLevel; reason: string } | { ok: false; error: string } {
  try {
    const stripped = response.replace(/```(?:json)?/gi, '')
    const start = stripped.indexOf('{')
    const end = stripped.lastIndexOf('}')
    if (start === -1 || end <= start) throw new Error('未找到 JSON 对象')
    const parsed = JSON.parse(stripped.slice(start, end + 1)) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('输出不是 JSON 对象')
    const rec = parsed as Record<string, unknown>
    const rawLevel = typeof rec.level === 'string' ? rec.level.trim().toLowerCase() : ''
    if (!isThinkingLevel(rawLevel)) throw new Error(`level 无效: ${String(rec.level ?? '')}`)
    const reason = typeof rec.reason === 'string'
      ? rec.reason.replace(DISPATCH_TAG_RE, '').replace(/\s+/g, ' ').trim().slice(0, 60)
      : ''
    return { ok: true, level: rawLevel, reason: reason || '分诊师自动定档' }
  } catch (err) {
    return { ok: false, error: `分诊师回复解析失败：${err instanceof Error ? err.message : '非 JSON 输出'}` }
  }
}

/**
 * 追问迟滞防抖（DT-8）：保护同会话 Prompt Cache。
 * - 升档（proposed > current）：无条件采纳（防蠢返工优先于缓存）；
 * - 同档：保持；
 * - 小幅降档（仅差 1 档，如 max→high / high→medium）：保留 current，标注 cachePreserved=true；
 * - 大幅降档（落差 ≥ 2 档，如 max→low / high→off）：采纳降档。
 */
export function applyFollowUpHysteresis(
  proposed: ThinkingLevel,
  current: ThinkingLevel | undefined,
  reason: string
): { level: ThinkingLevel; reason: string; rawLevel?: ThinkingLevel; cachePreserved?: boolean } {
  if (!current) return { level: proposed, reason }
  const delta = THINKING_RANK[current] - THINKING_RANK[proposed]
  if (delta === 1) {
    const note = reason.includes('保缓存') ? reason : `${reason}（保缓存沿用原档）`.slice(0, 60)
    return { level: current, reason: note, rawLevel: proposed, cachePreserved: true }
  }
  return { level: proposed, reason }
}

/** 单回合评估：支持 HTTP 预设直连快通路与 CLI 兜底通路；超时/失败/取消一律 Fail-open 返回结构化结果，不抛异常 */
export async function assessTaskThinking(
  deps: TriageDeps,
  input: TriageAssessInput,
  signal?: AbortSignal
): Promise<TriageAssessResult> {
  const startedAt = Date.now()
  if (signal?.aborted) {
    return { ok: false, error: '分诊已取消', fallback: TRIAGE_FALLBACK_LEVEL, cancelled: true }
  }

  const triageAgent = deps.agents.find(isTriageAgent) ?? DEFAULT_TRIAGE_AGENT
  const targetAgent = input.agentId ? deps.agents.find((a) => a.id === input.agentId) : undefined
  const targetBackend = targetAgent ? deps.backends.get(targetAgent.backend) : undefined

  try {
    if (deps.sharedDir) ensureTriageSkill(deps.sharedDir)
  } catch {}
  const skillBody = deps.sharedDir ? resolveTriageSkillBody(deps.sharedDir) : TRIAGE_SKILL_BODY

  const promptCtx: TriagePromptContext = {
    prompt: input.prompt,
    handoff: input.handoff,
    kind: input.kind,
    targetName: targetAgent?.name,
    targetRole: targetAgent?.role,
    targetBackend: targetAgent?.backend,
    isLeader: !!(targetAgent?.subordinates?.length || (targetAgent?.role && /队长|领队|captain|leader/i.test(targetAgent.role))),
    switchMode: targetBackend?.thinkingSwitchMode,
    currentThinking: input.currentThinking
  }

  const finishParsed = (rawText: string, via: TriageDecision['via']): TriageAssessResult => {
    const parsed = parseTriageResponse(rawText)
    if (!parsed.ok) return { ok: false, error: parsed.error, fallback: TRIAGE_FALLBACK_LEVEL }
    const adjusted = input.kind === 'followup'
      ? applyFollowUpHysteresis(parsed.level, input.currentThinking, parsed.reason)
      : { level: parsed.level, reason: parsed.reason }
    return {
      ok: true,
      decision: {
        level: adjusted.level,
        reason: adjusted.reason,
        ...(adjusted.rawLevel ? { rawLevel: adjusted.rawLevel } : {}),
        ...(adjusted.cachePreserved ? { cachePreserved: true } : {}),
        source: 'triage',
        via,
        durationMs: Math.max(0, Date.now() - startedAt)
      }
    }
  }

  // 通路 1：快通路（绑定 API 预设 + 模型 → 零 CLI 启动 HTTP 直连）
  const preset = triageAgent.presetId ? deps.presets.find((p) => p.id === triageAgent.presetId) : undefined
  if (preset && triageAgent.model?.trim()) {
    const complete = deps.chatCompletion ?? defaultChatCompletion
    try {
      const reply = await complete(preset, buildTriageMessages(skillBody, promptCtx), {
        model: triageAgent.model.trim(),
        timeoutMs: deps.httpTimeoutMs ?? deps.timeoutMs ?? TRIAGE_HTTP_TIMEOUT_MS,
        maxTokens: 160,
        signal
      })
      if (signal?.aborted) return { ok: false, error: '分诊已取消', fallback: TRIAGE_FALLBACK_LEVEL, cancelled: true }
      return finishParsed(reply, 'preset-http')
    } catch (err) {
      if (signal?.aborted) return { ok: false, error: '分诊已取消', fallback: TRIAGE_FALLBACK_LEVEL, cancelled: true }
      return {
        ok: false,
        error: `分诊直连失败：${err instanceof Error ? err.message : String(err)}`,
        fallback: TRIAGE_FALLBACK_LEVEL
      }
    }
  }

  // 通路 2：零配置兜底（复用分诊师指向的 CLI 后端单回合，强制不递归 'auto'）
  const backend = deps.backends.get(triageAgent.backend)
  if (!backend) {
    return { ok: false, error: `分诊师平台 ${triageAgent.backend} 不可用`, fallback: TRIAGE_FALLBACK_LEVEL }
  }
  const connection = triageAgent.model && preset
    ? { name: preset.name, baseURL: preset.baseURL, apiKey: preset.apiKey, protocol: preset.protocol }
    : undefined
  const triageThinking: ThinkingLevel | undefined = triageAgent.thinking === 'auto' ? 'off' : triageAgent.thinking

  const ref: { session: BackendSession | null; stopLaunch: (() => void | Promise<unknown>) | null } = { session: null, stopLaunch: null }
  let turnDone: ((r: BackendTurnResult) => void) | null = null
  const firstTurn = new Promise<BackendTurnResult>((resolve) => { turnDone = resolve })
  const timeoutMs = deps.cliTimeoutMs ?? deps.timeoutMs ?? TRIAGE_CLI_TIMEOUT_MS

  const run = (async () => {
    ref.session = await backend.start({
      prompt: buildTriagePrompt(skillBody, promptCtx),
      workdir: deps.homedir ?? os.homedir(),
      mode: deps.mode,
      model: triageAgent.model || undefined,
      thinking: triageThinking,
      connection,
      events: {
        onEvent: () => {},
        onPermission: async () => ({ decision: 'deny' }),
        onTurnEnd: (r) => turnDone?.(r),
        onLaunch: (handle) => { ref.stopLaunch = handle.stop }
      }
    })
    return firstTurn
  })()
  run.catch(() => {})

  let timedOut = false
  let cancelled = false
  let timer: NodeJS.Timeout | undefined
  let onAbort: (() => void) | undefined
  try {
    const guard = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true
        reject(new Error('triage turn timeout'))
      }, timeoutMs)
      if (signal) {
        onAbort = () => {
          cancelled = true
          reject(new Error('triage cancelled'))
        }
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      }
    })
    const r = await Promise.race([run, guard])
    if (!r.ok) return { ok: false, error: r.error || '分诊师回合失败', fallback: TRIAGE_FALLBACK_LEVEL }
    return finishParsed(r.response, 'backend-cli')
  } catch (err) {
    try { await (ref.stopLaunch?.() ?? ref.session?.stop()) } catch {}
    if (cancelled || signal?.aborted) {
      return { ok: false, error: '分诊已取消', fallback: TRIAGE_FALLBACK_LEVEL, cancelled: true }
    }
    return {
      ok: false,
      error: timedOut
        ? `分诊超时（${Math.round(timeoutMs / 1000)}s），已降级默认档——给「分诊师」绑 API 预设可提速至 ~1s`
        : `分诊启动失败：${err instanceof Error ? err.message : String(err)}`,
      fallback: TRIAGE_FALLBACK_LEVEL
    }
  } finally {
    if (timer) clearTimeout(timer)
    if (signal && onAbort) signal.removeEventListener('abort', onAbort)
    if (ref.session) {
      try { await ref.session.close() } catch {}
    }
  }
}

/** 在飞分诊请求管理器：供 IPC triage:assess / triage:cancel 精确取消，结束自动摘账零泄漏 */
export class TriageBroker {
  private readonly inflight = new Map<string, AbortController>()

  async assess(deps: TriageDeps, input: TriageAssessInput): Promise<TriageAssessResult> {
    const reqId = input.requestId?.trim() || `triage_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
    const previous = this.inflight.get(reqId)
    if (previous) previous.abort()
    const controller = new AbortController()
    this.inflight.set(reqId, controller)
    try {
      return await assessTaskThinking(deps, input, controller.signal)
    } finally {
      if (this.inflight.get(reqId) === controller) this.inflight.delete(reqId)
    }
  }

  cancel(requestId: string): boolean {
    const controller = this.inflight.get(requestId.trim())
    if (!controller) return false
    this.inflight.delete(requestId.trim())
    controller.abort()
    return true
  }

  shutdown(): void {
    for (const controller of this.inflight.values()) controller.abort()
    this.inflight.clear()
  }

  get activeCount(): number {
    return this.inflight.size
  }
}
