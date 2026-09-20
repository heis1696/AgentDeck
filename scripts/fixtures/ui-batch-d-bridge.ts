/**
 * Batch D 冒烟假桥（UsageView + PetSettingsPage）：在 ui-draft-bridge 的最小桥之上，
 * 按主进程真实行为补齐「用量汇总」与「桌宠设置」两路：
 *
 * - analytics:summary —— 可脚本化的成功/失败结果；延迟与乱序由用例直接接管 promise。
 * - pet:* —— 内存快照 + notifyState 等价广播（set* 先落快照、再广播、再返回新快照，
 *   与 src/main/pet/index.ts 的 notifyState 一致），onState 订阅同源。
 * - pet:gen-* —— 只记录入参并回放进度/完成/失败事件，不联网、不生成任何位图。
 *
 * 用例可以照 Batch B 的做法直接替换 api.* 方法制造挂起/失败；这里只保证未替换时的默认路径
 * 与主进程一致，并记录调用次数供「连点只写一次」这类断言使用。
 */
import { getDraftBridge } from './ui-draft-bridge'
import { PET_PRESET_NONE } from '../../src/shared/pet'
import type { PetGenDone, PetGenProgress, PetGenStartInput, PetStateSnapshot } from '../../src/shared/pet'
import type { AnalyticsSummary, ErrorAggregate, UsageAggregate } from '../../src/shared/types'

type PetGenError = { packId: string; reason: string }

const api = window.agentdeck
void getDraftBridge()

/* ------------------------------------------------------------ 用量汇总 */

const pad2 = (n: number) => `${n}`.padStart(2, '0')
const dayKeyAt = (ts: number) => {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

export interface UsageSeed {
  runs: number
  completed?: number
  failed?: number
  cancelled?: number
  days?: number
  until?: number
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
  errors?: ErrorAggregate[]
}

/** 构造一份与 analytics.ts buildAnalytics 同形状的汇总：runs 含完成/失败/取消/进行中的全部记录 */
export function usageSummary(seed: UsageSeed): AnalyticsSummary {
  const until = seed.until ?? Date.now()
  const inputTokens = seed.inputTokens ?? seed.runs * 1_000
  const outputTokens = seed.outputTokens ?? seed.runs * 400
  const totals: UsageAggregate = {
    runs: seed.runs,
    completed: seed.completed ?? seed.runs,
    failed: seed.failed ?? 0,
    cancelled: seed.cancelled ?? 0,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    costUsd: seed.costUsd ?? 0,
    durationMs: seed.runs * 60_000
  }
  const days = seed.days ?? 0
  const byDay = Array.from({ length: days }, (_, i) => {
    const ts = until - (days - 1 - i) * 86_400_000
    const dayInput = 500 + i * 100
    const dayOutput = 200 + i * 20
    return {
      runs: 1,
      completed: 1,
      failed: i === days - 1 && seed.failed ? Math.min(seed.failed, 1) : 0,
      cancelled: 0,
      inputTokens: dayInput,
      outputTokens: dayOutput,
      totalTokens: dayInput + dayOutput,
      costUsd: 0,
      durationMs: 1_000,
      date: dayKeyAt(ts)
    }
  })
  const row = (key: string, label: string, runs: number): UsageAggregate & { key: string; label: string } => ({
    key, label, runs, completed: runs, failed: 0, cancelled: 0,
    inputTokens: runs * 500, outputTokens: runs * 200, totalTokens: runs * 700, costUsd: 0, durationMs: runs * 1_000
  })
  return {
    since: undefined,
    until,
    generatedAt: until,
    totals,
    byBackend: [row('zcode', 'zcode', Math.max(1, Math.ceil(seed.runs / 2))), row('codex', 'codex', Math.max(1, Math.floor(seed.runs / 2)))],
    byAgent: [row('lead', '工程领队', Math.max(1, Math.ceil(seed.runs / 2)))],
    errors: seed.errors ?? [],
    byDay
  }
}

interface SummaryScript {
  summary?: AnalyticsSummary
  error?: string
}

const analyticsCalls: Array<{ since?: number }> = []
let summaryScript: SummaryScript[] = []
let defaultSummary = usageSummary({ runs: 12, days: 7 })

api.analytics.summary = async (input) => {
  analyticsCalls.push({ since: input?.since })
  const scripted = summaryScript.shift()
  if (scripted?.error) throw new Error(scripted.error)
  return scripted?.summary ?? defaultSummary
}

/* ------------------------------------------------------------ 桌宠快照 */

let snapshot: PetStateSnapshot = {
  enabled: true,
  packId: 'default',
  personaPrompt: '内置「活泼」预设',
  autonomySec: 60,
  presetId: 'preset-a',
  activePresetId: 'preset-a',
  model: 'claude-3-5-haiku-latest',
  presets: [
    { id: 'preset-a', name: '预设甲', protocol: 'anthropic', baseURL: 'https://example.test' },
    { id: 'preset-b', name: '预设乙', protocol: 'openai', baseURL: 'https://example.test' }
  ],
  brainStatus: { source: 'none', lastError: '', silenced: false },
  chatHistory: [],
  packs: [{ id: 'default', builtin: true, ok: true, frameCount: 16 }],
  zoom: 1,
  recentEvent: '',
  life: { affection: 12, mood: 70, tier: '点头之交', moodLabel: '平静', fedToday: 1 }
}

const stateListeners = new Set<(next: PetStateSnapshot) => void>()
const genListeners = {
  progress: new Set<(payload: PetGenProgress) => void>(),
  done: new Set<(payload: PetGenDone) => void>(),
  error: new Set<(payload: PetGenError) => void>()
}

const calls = {
  getState: 0,
  setEnabled: [] as boolean[],
  setPack: [] as string[],
  setPersona: [] as string[],
  setAutonomy: [] as number[],
  setPreset: [] as Array<{ presetId: string; model?: string }>,
  setZoom: [] as number[],
  genStart: [] as PetGenStartInput[],
  genCancel: 0
}

let genStartResult: { ok: boolean; error?: string } = { ok: true }

/** 主进程 notifyState 的等价物：落快照 → 广播 → 返回同一份快照 */
const commit = (patch: Partial<PetStateSnapshot>): PetStateSnapshot => {
  snapshot = { ...snapshot, ...patch }
  for (const listener of stateListeners) listener(snapshot)
  return snapshot
}

api.pet.getState = async () => { calls.getState++; return snapshot }
api.pet.setEnabled = async (on) => { calls.setEnabled.push(on); return commit({ enabled: on }) }
api.pet.setPack = async (id) => { calls.setPack.push(id); return commit({ packId: id }) }
api.pet.setPersona = async (text) => { calls.setPersona.push(text); return commit({ personaPrompt: text }) }
api.pet.setAutonomy = async (sec) => {
  calls.setAutonomy.push(sec)
  return commit({ autonomySec: Math.max(20, Math.round(sec)) })
}
api.pet.setPreset = async (presetId, model) => {
  calls.setPreset.push({ presetId, model })
  return commit({
    presetId,
    activePresetId: presetId === PET_PRESET_NONE ? '' : presetId || 'preset-a',
    ...(model === undefined ? {} : { model })
  })
}
api.pet.setZoom = async (zoom) => { calls.setZoom.push(zoom); return commit({ zoom }) }
api.pet.genStart = async (input) => { calls.genStart.push(input); return genStartResult }
api.pet.genCancel = async () => { calls.genCancel++; return { ok: true } }
api.pet.onState = (listener) => { stateListeners.add(listener); return () => { stateListeners.delete(listener) } }
api.pet.onGenProgress = (listener) => { genListeners.progress.add(listener); return () => { genListeners.progress.delete(listener) } }
api.pet.onGenDone = (listener) => { genListeners.done.add(listener); return () => { genListeners.done.delete(listener) } }
api.pet.onGenError = (listener) => { genListeners.error.add(listener); return () => { genListeners.error.delete(listener) } }

export interface BatchDBridge {
  calls: typeof calls
  analyticsCalls: Array<{ since?: number }>
  snapshot(): PetStateSnapshot
  /** 主进程式落盘 + 广播（用例模拟外部改动/迟到广播） */
  commit(patch: Partial<PetStateSnapshot>): PetStateSnapshot
  /** 下一次 analytics:summary 的脚本（shift 消费；用尽回退 defaultSummary） */
  scriptSummary(...items: SummaryScript[]): void
  setDefaultSummary(summary: AnalyticsSummary): void
  setGenStartResult(result: { ok: boolean; error?: string }): void
  emitGenProgress(payload: PetGenProgress): void
  emitGenDone(payload: PetGenDone): void
  emitGenError(payload: PetGenError): void
  reset(): void
}

export function getBatchDBridge(): BatchDBridge {
  return {
    calls,
    analyticsCalls,
    snapshot: () => snapshot,
    commit,
    scriptSummary: (...items) => { summaryScript = [...summaryScript, ...items] },
    setDefaultSummary: (summary) => { defaultSummary = summary },
    setGenStartResult: (result) => { genStartResult = result },
    emitGenProgress: (payload) => { for (const listener of genListeners.progress) listener(payload) },
    emitGenDone: (payload) => { for (const listener of genListeners.done) listener(payload) },
    emitGenError: (payload) => { for (const listener of genListeners.error) listener(payload) },
    reset: () => {
      summaryScript = []
      defaultSummary = usageSummary({ runs: 12, days: 7 })
      genStartResult = { ok: true }
      analyticsCalls.length = 0
      calls.getState = 0
      calls.setEnabled.length = 0
      calls.setPack.length = 0
      calls.setPersona.length = 0
      calls.setAutonomy.length = 0
      calls.setPreset.length = 0
      calls.setZoom.length = 0
      calls.genStart.length = 0
      calls.genCancel = 0
    }
  }
}
