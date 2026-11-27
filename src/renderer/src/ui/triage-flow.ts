/**
 * 动态思考强度两道 2s 确认状态机（纯 TS，无 React / DOM 依赖，可直接在 Node 跑冒烟）。
 *
 * 严格串行、零偷跑（DT-2）：
 *   1. idle → confirm-triage (2000ms)：询问是否跳过动态思考评估；**绝不**在此阶段提前调用 assess()。
 *      - 点「跳过」→ 零 assess 调用，以 skipTriage:true 直接放行；
 *      - 点 5 档任一胶囊 → 零 assess 调用，跳过阶段 2，以用户选档直接放行；
 *      - 点「取消」/ Esc → 返回 { action: 'cancelled' }，保留输入框草稿；
 *      - 2s 到期或点「立即评估」→ 进入 assessing，开始调用 assess()。
 *   2. assessing：等待分诊师返回 { level, reason }。
 *      - 点「跳过」/ 选档 /「取消」→ 立即调用 cancel(requestId) 中止在飞请求；
 *      - 失败/超时 → Fail-open，触发 onFallbackToast 并以 fallback 档位直接放行。
 *   3. confirm-level (2000ms)：展示分诊师定档与理由，给用户最后 2s 确认/改档/取消。
 *      - hover 暂停倒计时、移出按剩余时间续计时；
 *      - 2s 到期或点「立即执行」→ 以分诊定档放行；点其他档位 → 以用户改档放行；
 *      - 点「取消」/ Esc → 返回 { action: 'cancelled' }，保留输入框草稿。
 */
import type { AgentThinking, ThinkingLevel, ThinkingSource } from '../../../shared/types'
import type { TriageAssessInput, TriageAssessResult, TriageDecision } from '../../../shared/triage'

export const TRIAGE_CONFIRM_MS = 2000

/** 支持同会话回合级热切思考强度的后端（追问场景可触发分诊确认条） */
const PER_TURN_THINKING_BACKENDS = new Set(['claude', 'codex', 'zcode', 'agy'])

export interface TriagePromptAgentLike {
  backend: string
  thinking?: AgentThinking
}

/** 纯函数：判定本次用户发起操作是否应弹出两道 2s 悬浮确认条 */
export function shouldPromptTriage(input: { agent?: TriagePromptAgentLike | null; kind: 'task' | 'followup' }): boolean {
  const { agent, kind } = input
  if (!agent || agent.thinking !== 'auto') return false
  if (kind === 'task') return agent.backend !== 'opencode'
  return PER_TURN_THINKING_BACKENDS.has(agent.backend)
}

export type TriageStage = 'idle' | 'confirm-triage' | 'assessing' | 'confirm-level'

export interface TriageFlowState {
  stage: TriageStage
  requestId: string | null
  kind: 'task' | 'followup'
  agentName: string
  currentThinking?: ThinkingLevel
  /** 本阶段倒计时总时长（ms） */
  durationMs: number
  /** 当前剩余毫秒（hover 暂停时冻结，未暂停时配对 deadlineAt 供 UI 渲染进度条） */
  remainingMs: number
  /** 未暂停时的到期时间戳（ms）；暂停或非倒计时阶段为 null */
  deadlineAt: number | null
  hovered: boolean
  /** 阶段 3 分诊师定档结果 */
  decision: TriageDecision | null
}

export const IDLE_TRIAGE_STATE: TriageFlowState = Object.freeze({
  stage: 'idle',
  requestId: null,
  kind: 'task',
  agentName: '',
  currentThinking: undefined,
  durationMs: TRIAGE_CONFIRM_MS,
  remainingMs: 0,
  deadlineAt: null,
  hovered: false,
  decision: null
})

export type TriageFlowOutcome =
  | {
      action: 'proceed'
      thinking?: ThinkingLevel
      thinkingSource?: ThinkingSource
      thinkingReason?: string
      skipTriage?: boolean
    }
  | { action: 'cancelled' }

export interface TriageFlowStartInput {
  kind: 'task' | 'followup'
  prompt: string
  handoff?: string
  agentId?: string
  agentName?: string
  workdir?: string
  currentThinking?: ThinkingLevel
  assess: (input: TriageAssessInput) => Promise<TriageAssessResult>
  cancel?: (requestId: string) => Promise<{ ok: boolean }> | void
  onFallbackToast?: (message: string) => void
}

export interface TriageFlowTimers {
  set: (fn: () => void, ms: number) => unknown
  clear: (handle: unknown) => void
}

export interface TriageFlowControllerOptions {
  timers?: TriageFlowTimers
  now?: () => number
  countdownMs?: number
  onChange?: (state: TriageFlowState) => void
  onBusy?: () => void
}

export interface TriageFlowController {
  getState(): TriageFlowState
  start(input: TriageFlowStartInput): Promise<TriageFlowOutcome>
  skip(): void
  pickLevel(level: ThinkingLevel): void
  confirmNow(): void
  cancel(): void
  setHovered(hovered: boolean): void
  reset(): void
}

export function createTriageFlow(options: TriageFlowControllerOptions = {}): TriageFlowController {
  const timers: TriageFlowTimers = options.timers ?? {
    set: (fn, ms) => globalThis.setTimeout(fn, ms),
    clear: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>)
  }
  const now = options.now ?? (() => Date.now())
  const countdownMs = options.countdownMs ?? TRIAGE_CONFIRM_MS

  let state: TriageFlowState = IDLE_TRIAGE_STATE
  let activeInput: TriageFlowStartInput | null = null
  let activeResolve: ((outcome: TriageFlowOutcome) => void) | null = null
  let timerHandle: unknown = undefined
  let sessionSeq = 0
  let activeSession = 0

  const emit = (next: TriageFlowState): void => {
    state = next
    options.onChange?.(state)
  }

  const clearTimer = (): void => {
    if (timerHandle === undefined) return
    const handle = timerHandle
    timerHandle = undefined
    timers.clear(handle)
  }

  const armTimer = (ms: number, onExpire: () => void): void => {
    clearTimer()
    const delay = Math.max(0, Math.round(ms))
    timerHandle = timers.set(() => {
      timerHandle = undefined
      onExpire()
    }, delay)
  }

  const finish = (outcome: TriageFlowOutcome): void => {
    clearTimer()
    activeSession = 0
    const resolve = activeResolve
    activeResolve = null
    activeInput = null
    emit(IDLE_TRIAGE_STATE)
    resolve?.(outcome)
  }

  const abortInflight = (): void => {
    if (state.stage === 'assessing' && state.requestId && activeInput?.cancel) {
      const reqId = state.requestId
      try {
        void Promise.resolve(activeInput.cancel(reqId)).catch(() => {})
      } catch {}
    }
  }

  const beginConfirmLevel = (session: number, decision: TriageDecision): void => {
    if (session !== activeSession) return
    const paused = state.hovered
    const deadlineAt = paused ? null : now() + countdownMs
    emit({
      ...state,
      stage: 'confirm-level',
      decision,
      durationMs: countdownMs,
      remainingMs: countdownMs,
      deadlineAt
    })
    if (!paused) {
      armTimer(countdownMs, () => {
        if (session !== activeSession || state.stage !== 'confirm-level' || !state.decision) return
        finish({
          action: 'proceed',
          thinking: state.decision.level,
          thinkingSource: state.decision.source,
          thinkingReason: state.decision.reason
        })
      })
    }
  }

  const beginAssessing = (session: number): void => {
    if (session !== activeSession || !activeInput) return
    clearTimer()
    const input = activeInput
    const requestId = `tr_${session}_${now().toString(36)}`
    emit({
      ...state,
      stage: 'assessing',
      requestId,
      remainingMs: 0,
      deadlineAt: null,
      decision: null
    })
    const payload: TriageAssessInput = {
      requestId,
      prompt: input.prompt,
      ...(input.handoff ? { handoff: input.handoff } : {}),
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.workdir ? { workdir: input.workdir } : {}),
      ...(input.currentThinking ? { currentThinking: input.currentThinking } : {}),
      kind: input.kind
    }
    let pending: Promise<TriageAssessResult>
    try {
      pending = Promise.resolve(input.assess(payload))
    } catch (err) {
      pending = Promise.reject(err)
    }
    void pending
      .then((res) => {
        if (session !== activeSession) return
        if (!res.ok) {
          if (res.cancelled) {
            finish({ action: 'cancelled' })
            return
          }
          const reason = res.error.slice(0, 120)
          input.onFallbackToast?.(`分诊降级默认档：${reason}`)
          finish({
            action: 'proceed',
            thinking: res.fallback,
            thinkingSource: 'fallback',
            thinkingReason: reason
          })
          return
        }
        beginConfirmLevel(session, res.decision)
      })
      .catch((err) => {
        if (session !== activeSession) return
        const reason = (err instanceof Error ? err.message : String(err)).slice(0, 120)
        input.onFallbackToast?.(`分诊降级默认档：${reason}`)
        finish({
          action: 'proceed',
          thinking: 'medium',
          thinkingSource: 'fallback',
          thinkingReason: reason
        })
      })
  }

  return {
    getState: () => state,

    start: (input) => {
      if (state.stage !== 'idle') {
        options.onBusy?.()
        return Promise.resolve({ action: 'cancelled' })
      }
      const session = ++sessionSeq
      activeSession = session
      activeInput = input
      return new Promise<TriageFlowOutcome>((resolve) => {
        activeResolve = resolve
        const deadlineAt = now() + countdownMs
        emit({
          stage: 'confirm-triage',
          requestId: null,
          kind: input.kind,
          agentName: input.agentName ?? '',
          currentThinking: input.currentThinking,
          durationMs: countdownMs,
          remainingMs: countdownMs,
          deadlineAt,
          hovered: false,
          decision: null
        })
        armTimer(countdownMs, () => {
          if (session !== activeSession || state.stage !== 'confirm-triage') return
          beginAssessing(session)
        })
      })
    },

    skip: () => {
      if (state.stage === 'idle') return
      abortInflight()
      finish({ action: 'proceed', skipTriage: true })
    },

    pickLevel: (level) => {
      if (state.stage === 'idle') return
      const priorDecision = state.stage === 'confirm-level' ? state.decision : null
      const stageBefore = state.stage
      abortInflight()
      const reason = priorDecision
        ? (level === priorDecision.level ? priorDecision.reason : '用户覆盖分诊建议')
        : stageBefore === 'assessing'
          ? '评估中手动指定'
          : '发送前手动指定'
      const source: ThinkingSource = priorDecision && level === priorDecision.level ? priorDecision.source : 'user'
      finish({
        action: 'proceed',
        thinking: level,
        thinkingSource: source,
        thinkingReason: reason
      })
    },

    confirmNow: () => {
      if (state.stage === 'confirm-triage') {
        beginAssessing(activeSession)
        return
      }
      if (state.stage === 'confirm-level' && state.decision) {
        const { level, source, reason } = state.decision
        finish({
          action: 'proceed',
          thinking: level,
          thinkingSource: source,
          thinkingReason: reason
        })
      }
    },

    cancel: () => {
      if (state.stage === 'idle') return
      abortInflight()
      finish({ action: 'cancelled' })
    },

    setHovered: (hovered) => {
      if (state.stage === 'idle' || state.hovered === hovered) return
      if (state.stage === 'assessing') {
        emit({ ...state, hovered })
        return
      }
      const session = activeSession
      if (hovered) {
        const remainingMs = state.deadlineAt !== null ? Math.max(0, state.deadlineAt - now()) : state.remainingMs
        clearTimer()
        emit({ ...state, hovered: true, remainingMs, deadlineAt: null })
      } else {
        const remainingMs = Math.max(0, state.remainingMs)
        const deadlineAt = now() + remainingMs
        emit({ ...state, hovered: false, remainingMs, deadlineAt })
        const currentStage = state.stage
        armTimer(remainingMs, () => {
          if (session !== activeSession || state.stage !== currentStage) return
          if (currentStage === 'confirm-triage') {
            beginAssessing(session)
          } else if (currentStage === 'confirm-level' && state.decision) {
            finish({
              action: 'proceed',
              thinking: state.decision.level,
              thinkingSource: state.decision.source,
              thinkingReason: state.decision.reason
            })
          }
        })
      }
    },

    reset: () => {
      if (state.stage === 'idle') {
        clearTimer()
        return
      }
      abortInflight()
      finish({ action: 'cancelled' })
    }
  }
}
