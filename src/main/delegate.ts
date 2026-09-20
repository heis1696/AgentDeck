// 委派协议：领队 agent 的内置能力。
// 领队系统提示告知队员名单与 <delegate> 标记语法；运行时截获标记 → 并行执行子任务 →
// 结果回灌 → 领队继续。循环直到领队不再派发。任何支持续聊的后端都适用。
// 提示词文案集中在 src/main/prompts/delegation.ts（本文件只保留解析器与循环逻辑）。
import type { Task, TaskEvent } from '../shared/types'
import type { TaskStore } from './store'
import type { TaskRunner } from './runner'
import type { BackendSession, BackendTurnResult } from './backends/types'
import {
  buildAgentPrompt,
  buildDelegationBlock,
  buildChildPrompt,
  REPORT_PROMPT_HEADER,
  childReportEntry,
  buildRejectionFeedbackPrompt,
  CONTINUE_INSTRUCTION,
  CONTINUE_INSTRUCTION_WITH_REJECTS,
  buildRejectNotice,
  REVIEW_INSTRUCTION,
  undeliveredReportComment,
  leftoverRejectsComment
} from './prompts'
import { isGitRepo, mergeBranchInto, branchDiffSummary, currentBranch, commitAll, branchExists, reclaimWorktree, deleteBranch, markWorktreeCleanup } from './git'
import { currentGitChanges } from '../shared/git-snapshot'

export interface DelegateCall {
  to: string
  prompt: string
  /** 派工理由（领队自述，留痕展示用） */
  reason?: string
}

/** 解析 delegate 标签的属性（属性顺序任意） */
function tagAttr(attrs: string, name: string): string | undefined {
  const m = attrs.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i'))
  return m ? m[1].trim() : undefined
}

/** 从领队回复中提取 delegate 标记（容错：任意属性顺序、md fence 内）。
 *  开标签必须带 to 属性才构成匹配（lookahead）：无 to 的裸标记字样不成为匹配起点，
 *  否则非贪婪体会一路延伸、吞掉后方真实派单的闭合标签（幻影吞单）。 */
export function parseDelegates(text: string): DelegateCall[] {
  const out: DelegateCall[] = []
  const re = /<delegate\b(?=[^>]*\bto\s*=)([^>]*)>([\s\S]*?)<\/delegate>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const prompt = m[2].trim()
    const to = tagAttr(m[1], 'to')
    const reason = tagAttr(m[1], 'reason')
    if (prompt && to) out.push({ to, prompt, ...(reason ? { reason } : {}) })
  }
  return out
}

/** 把 delegate 标记从对外展示文本中剥掉（同解析规则：只剥带 to 的真实派单，不吞裸字样后的正文） */
export function stripDelegates(text: string): string {
  return text.replace(/<delegate\b(?=[^>]*\bto\s*=)[^>]*>[\s\S]*?<\/delegate>/g, '').trim()
}

// ---- 队长间咨询（阶段 1）：目标是另一位队长的办公室会话 ----

export interface ConsultCall {
  to: string
  prompt: string
  reason?: string
}

/** 解析 consult 标签。开标签必须带 to，避免裸标签吞掉后方真实咨询。 */
export function parseConsults(text: string): ConsultCall[] {
  const out: ConsultCall[] = []
  const re = /<consult\b(?=[^>]*\bto\s*=)([^>]*)>([\s\S]*?)<\/consult>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const prompt = m[2].trim()
    const to = tagAttr(m[1], 'to')
    const reason = tagAttr(m[1], 'reason')
    if (prompt && to) out.push({ to, prompt, ...(reason ? { reason } : {}) })
  }
  return out
}

export function stripConsults(text: string): string {
  return text.replace(/<consult\b(?=[^>]*\bto\s*=)[^>]*>[\s\S]*?<\/consult>/g, '').trim()
}

export function parseConsultsMerged(...texts: string[]): ConsultCall[] {
  const seen = new Set<string>()
  const out: ConsultCall[] = []
  for (const text of texts) {
    for (const call of parseConsults(text)) {
      const key = `${call.to}\n${call.prompt}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(call)
    }
  }
  return out
}

export interface InvestigateCall {
  to: string
  prompt: string
  reason?: string
}

export function parseInvestigates(text: string): InvestigateCall[] {
  const out: InvestigateCall[] = []
  const re = /<investigate\b(?=[^>]*\bto\s*=)([^>]*)>([\s\S]*?)<\/investigate>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const prompt = m[2].trim()
    const to = tagAttr(m[1], 'to')
    const reason = tagAttr(m[1], 'reason')
    if (prompt && to) out.push({ to, prompt, ...(reason ? { reason } : {}) })
  }
  return out
}

export function stripInvestigates(text: string): string {
  return text.replace(/<investigate\b(?=[^>]*\bto\s*=)[^>]*>[\s\S]*?<\/investigate>/g, '').trim()
}

export function parseInvestigatesMerged(...texts: string[]): InvestigateCall[] {
  const seen = new Set<string>()
  const out: InvestigateCall[] = []
  for (const text of texts) for (const call of parseInvestigates(text)) {
    const key = `${call.to}\n${call.prompt}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(call)
  }
  return out
}

// ---- 阶段接力（<continue>）：多阶段任务在阶段边界硬切新会话，简报为唯一携带物 ----

export interface ContinueCall {
  /** 下一阶段简报（自包含：目标/方案文档路径/上阶段成果/关键文件:行号/约束） */
  brief: string
  /** auto = 用户已明确要求继续，立即执行；parked = agent 备好等用户启动 */
  start: 'auto' | 'parked'
  /**
   * 兜底通道命中：标记不在回复末尾（其后仍有正文/围栏），但显式写了 start="auto"。
   * 调用方据此在时间线留痕，让"为什么没走末尾锚定"可观测。
   */
  loose?: boolean
}

/** 末尾锚定主通道：标记后只允许空白 */
const CONTINUE_TAIL_RE = /<continue\b([^>]*)>([\s\S]*?)<\/continue>\s*$/
/** 兜底扫描：全文任意位置的完整闭合标记（取最后一个） */
const CONTINUE_ANY_RE = /<continue\b([^>]*)>([\s\S]*?)<\/continue>/g

/** 协议示例简报的指纹前缀（含专属 commit 号）：与它同源的简报视为复述而非真实接力意图 */
const CONTINUE_EXAMPLE_FINGERPRINT = '阶段2：按 docs/plan.md §3 实现模型选择 UI；阶段1 已完成数据管道（commit 09a47a4'

function continueStart(attrs: string): { start: 'auto' | 'parked'; explicitAuto: boolean } {
  const attr = attrs.match(/\bstart\s*=\s*(["'])(auto|parked)\1/i)
  return { start: attr && attr[2].toLowerCase() === 'auto' ? 'auto' : 'parked', explicitAuto: !!attr && attr[2].toLowerCase() === 'auto' }
}

/**
 * 解析 <continue start="auto|parked">简报</continue>。
 * 主通道末尾锚定：标记后只允许空白——协议即"在回复最后一行输出"，正文/示例/复述
 * 文档里出现标记字样不构成接力意图（防止讨论方案或引用本文档时被误切会话）。
 * start 属性解析容忍多属性/大小写；只有显式 "auto" 才立即执行，
 * 缺省/非法/无引号一律按 parked 备好待人工启动，防止复述协议时误切会话。
 * 兜底通道：主通道未命中时取全文最后一个完整闭合标记，仅当**显式** start="auto"
 * 才采纳（显式意图优先于位置规范；复述协议示例不会带真实简报文本）。实测模型常在
 * 标记后补一句客套收尾或整体包进代码围栏，末尾锚定全灭——这正是硬切"看起来失效"
 * 的主要形态，兜底把这些显式意图救回来。
 */
export function parseContinue(text: string): ContinueCall[] {
  const out: ContinueCall[] = []
  const tail = text.match(CONTINUE_TAIL_RE)
  if (tail) {
    const brief = tail[2].trim()
    // 防复述：与协议示例同指纹的简报不构成接力意图（agent 逐字引用协议块收尾时）
    if (brief && !brief.startsWith(CONTINUE_EXAMPLE_FINGERPRINT)) out.push({ brief, start: continueStart(tail[1]).start })
    return out
  }
  let last: RegExpMatchArray | null = null
  for (const m of text.matchAll(CONTINUE_ANY_RE)) last = m
  if (!last) return out
  const brief = last[2].trim()
  if (!brief) return out
  // 防复述：兜底通道不接受与协议示例同指纹的简报（agent 引用协议全文时示例标记带显式 auto），
  // 也不接受分量不足的简报——真简报按协议必须自包含（目标/成果/约束），讨论里的演示标记通常只有片语
  if (brief.startsWith(CONTINUE_EXAMPLE_FINGERPRINT) || brief.length < 20) return out
  const { start, explicitAuto } = continueStart(last[1])
  if (explicitAuto) out.push({ brief, start: 'auto', loose: true })
  return out
}

/** 多源取最后一个 continue（跨来源按序扫描，后者覆盖前者 = 最新意图） */
export function parseContinueMerged(...texts: string[]): ContinueCall | null {
  let found: ContinueCall | null = null
  for (const text of texts) for (const c of parseContinue(text)) found = c
  return found
}

/** 把 continue 标记从对外展示文本中剥掉 */
export function stripContinue(text: string): string {
  return text.replace(/<continue\b[^>]*>[\s\S]*?<\/continue>/g, '').trim()
}

/**
 * 多源解析并按 to+prompt 去重。
 * 标记可能只出现在回合文本的某一个来源里（终态全文/流式累计/最后一条消息互不包含），
 * 任何单一来源都不能当完整代表；各来源重叠部分的重复解析由去重吸收。
 */
export function parseDelegatesMerged(...texts: string[]): DelegateCall[] {
  const seen = new Set<string>()
  const out: DelegateCall[] = []
  for (const text of texts) {
    for (const call of parseDelegates(text)) {
      const key = `${call.to}\n${call.prompt}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(call)
    }
  }
  return out
}

export interface AgentLike {
  id: string
  name: string
  backend: string
  role?: string
  systemPrompt?: string
  subordinates?: string[]
  /** agent 钉死的模型覆盖（Agent.model 透传给 backend.start） */
  model?: string
  /** API 预设 id（连接覆盖，runner 解析为 connection 传入 backend.start） */
  presetId?: string
  note?: string
}

/** 把子任务指令里的主仓库绝对路径改写成相对路径（队员在隔离副本工作，绝对路径会改错地方） */
export function sanitizeChildPrompt(prompt: string, repoDir: string): string {
  if (!repoDir) return prompt
  const variants = [repoDir, repoDir.replace(/\\/g, '/'), repoDir.replace(/\\/g, '\\\\')]
  let out = prompt
  for (const v of variants) {
    if (v && v.length > 3) out = out.split(v + '/').join('').split(v + '\\').join('')
  }
  return out.trim()
}

/** 领队每轮评估标记（对齐 Multica squad activity：每轮回灌后留痕，outcome 三值） */
export interface RoundNote {
  outcome: string
  reason?: string
}

/** 解析自闭合的 <round outcome="..." reason="..."/> 标记（与 delegate 标记不冲突） */
export function parseRoundNotes(text: string): RoundNote[] {
  const out: RoundNote[] = []
  const re = /<round\b([^>]*?)\/>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const outcome = tagAttr(m[1], 'outcome')
    if (!outcome) continue
    const reason = tagAttr(m[1], 'reason')
    out.push({ outcome, ...(reason ? { reason } : {}) })
  }
  return out
}

/** 把 round 评估标记从对外展示文本中剥掉 */
export function stripRoundNotes(text: string): string {
  return text.replace(/<round\b[^>]*?\/>/g, '').trim()
}

// ---- 委派单审核（maker/checker，v2）：领队必须对 done 子任务出审核结论 ----

export interface ReviewCall {
  /** 单号（#1、#2）或队员名/标题子串（兜底匹配） */
  of: string
  verdict: 'pass' | 'fail'
  note?: string
}

/** 解析自闭合的 <review of="#n" verdict="pass|fail" note="..."/> 标记 */
export function parseReviews(text: string): ReviewCall[] {
  const out: ReviewCall[] = []
  const re = /<review\b([^>]*?)\/>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const of = tagAttr(m[1], 'of')
    const verdict = tagAttr(m[1], 'verdict')
    if (!of || !verdict || (verdict !== 'pass' && verdict !== 'fail')) continue
    const note = tagAttr(m[1], 'note')
    out.push({ of, verdict, ...(note ? { note } : {}) })
  }
  return out
}

/** 把 review 标记从对外展示文本中剥掉 */
export function stripReviews(text: string): string {
  return text.replace(/<review\b[^>]*?\/>/g, '').trim()
}

export interface DelegationContext {
  store: TaskStore
  runner: TaskRunner
  getTeam: () => AgentLike[]
  opts: () => {
    mode: string; notify: boolean; maxParallel: number
    /** 委派预算（缺省回落到模块常量）：单领队轮数 / 全链轮数 / 层级上限 */
    maxRounds?: number; maxTotalRounds?: number; maxDepth?: number
  }
  pushTask: (taskId: string) => void
  pushEvent: (taskId: string, e: TaskEvent) => void
  /** 审核子任务（pass → done，fail → blocked） */
  applyReview?: (childId: string, verdict: 'pass' | 'fail', note?: string) => void
  /** Issue 评论（回灌失败兜底：领队已死时把队员报告摘要落到用户看得到的地方） */
  addIssueComment?: (issueId: string, text: string) => void
}

export interface DelegationOutcome {
  rounds: number
  children: string[]
  finalText: string
  /** 各回合标记解析文本（终态全文/流式累计），供 <continue> 接力解析（delegate 与 continue 同源） */
  scanTexts: string[]
}

const MAX_ROUNDS = 6
/** 全链共享轮数预算（二层委派：祖先已用轮数计入） */
export const MAX_TOTAL_ROUNDS = 8
/** 委派层级上限（领队 → 子领队 → 队员，共 3 层） */
export const MAX_DEPTH = 3

/** 沿 parentTaskId 上溯，返回祖先已用轮数总和、深度、祖先标识集（防环用） */
export function ancestorBudget(store: DelegationContext['store'], taskId: string): { inherited: number; depth: number; ancestors: Set<string> } {
  let inherited = 0
  let depth = 0
  const ancestors = new Set<string>()
  let pid = store.get(taskId)?.parentTaskId
  while (pid && depth < 10) {
    const t = store.get(pid)
    if (!t) break
    depth++
    inherited += t.roundsUsed ?? 0
    // 防环标识：优先 agentId；无 agentId 的任务用 @backend 兜底
    ancestors.add(t.agentId ?? `@${t.backend}`)
    pid = t.parentTaskId
  }
  return { inherited, depth, ancestors }
}

/**
 * 子任务需要合入的分支：worktree 自己的分支优先；没有 worktree 元数据时，只有该
 * 子任务**本轮执行**留下了 available 快照，才按派生约定推断分支名。旧 gitStat
 * （上一轮/无来源/失败取消残留）不构成证据——照它推断会去合一个不存在的幻影分支。
 */
export function delegateChildBranch(
  child: Pick<Task, 'worktree' | 'runId' | 'phaseIndex' | 'startedAt' | 'gitSnapshot' | 'gitDiff' | 'gitStat'>,
  leaderTaskId: string,
  index: number
): string {
  if (child.worktree?.branch) return child.worktree.branch
  return currentGitChanges(child) ? `agentdeck/${leaderTaskId}_c${index}` : ''
}

/**
 * 委派循环：在领队回合结束后执行。
 * session 已就绪；每轮解析 delegate 标记 → 生成子任务 → 等终态 → 结果回灌 session.send。
 * 标记解析用回合文本的全部来源（终态全文/流式累计并集 + 最后一条消息，多源去重——
 * 单一来源可能不含中间消息里的标记）；最终结果只取每轮最后一条 assistant 消息
 * （response），避免中间过程灌进 result/回灌上下文。
 */
export async function runDelegationLoop(
  taskId: string,
  session: BackendSession,
  first: BackendTurnResult,
  ctx: DelegationContext
): Promise<DelegationOutcome> {
  const { store, runner, pushTask, pushEvent } = ctx
  const task = store.get(taskId)!
  const runId = task.runId
  const active = () => {
    const current = store.get(taskId)
    return current?.status === 'running' && current.runId === runId
  }
  const abandoned = (): DelegationOutcome => ({ rounds: 0, children: [], finalText: '', scanTexts: [] })
  if (!active()) return abandoned()
  const team = ctx.getTeam()
  const me = team.find((a) => a.id === task.agentId)
  const subs = (me?.subordinates ?? []).map((id) => team.find((a) => a.id === id)).filter(Boolean) as AgentLike[]
  if (!subs.length) return { rounds: 0, children: [], finalText: first.response, scanTexts: [first.delegationText ?? '', first.response] }

  const note = (text: string) => {
    if (!active()) return
    const e = { ts: Date.now(), kind: 'status' as const, text }
    const full = store.appendEvent(taskId, e)
    if (full) pushEvent(taskId, full)
  }

  const hasRepo = task.workdir ? await isGitRepo(task.workdir) : false
  if (!active()) return abandoned()
  const baseBranch = hasRepo && task.workdir ? await currentBranch(task.workdir) : ''
  if (!active()) return abandoned()

  // ---- 二层委派的三道闸（0.7.0；建单路径的同类闸在 runner.spawnDelegateChild）----
  const { inherited, depth } = ancestorBudget(store, taskId)
  const maxDepth = ctx.opts().maxDepth ?? MAX_DEPTH
  const maxRounds = ctx.opts().maxRounds ?? MAX_ROUNDS
  const maxTotalRounds = ctx.opts().maxTotalRounds ?? MAX_TOTAL_ROUNDS
  const bail = (why: string): DelegationOutcome => {
    note(`⚠ ${why}，本任务不再下派`)
    return { rounds: 0, children: [], finalText: stripDelegates(first.response), scanTexts: [first.delegationText ?? '', first.response] }
  }
  if (depth >= maxDepth) return bail(`委派层级已达上限（${maxDepth} 层）`)
  const budget = Math.min(maxRounds, maxTotalRounds - inherited)
  if (budget <= 0) return bail('全链委派轮数预算已耗尽')

  /** 标记解析用：回合文本的全部来源（终态全文/流式累计并集 + 最后一条消息） */
  let scanTexts: string[] = [first.delegationText ?? '', first.response]
  /** 结果用：每轮最后一条 assistant 消息 */
  let finalResponse = first.response
  let allChildren: string[] = []
  let round = 0
  for (const n of parseRoundNotes(first.response)) {
    note(`领队评估：${n.outcome}${n.reason ? ' — ' + n.reason : ''}`)
  }

  // 被拒派单的零新单兜底回灌（有界防循环）：主通道是随每轮报告捎带（下方），这里只接
  // 「领队没派任何新单」的收尾回合——那种回合没有报告可搭。目标护栏拒单时领队并不知道，
  // 若不回灌它会在「等回灌」的幻觉里干等（实际事故：派给队长 claude/codex 被跳过，单子永远不出现）。
  let rejectedFeedbacks = 0
  const rosterText = subs.map((a) => `${a.name}（${a.backend}）`).join('、')
  const feedbackRejections = async (): Promise<boolean> => {
    if (!active()) return false
    const rejects = runner.takeDelegateRejections(taskId)
    if (!rejects.length || rejectedFeedbacks >= 2) return false
    rejectedFeedbacks++
    note(`⚠ ${rejects.length} 条派单被拒（未建单），原因回灌给领队改派`)
    try {
      const turn = await runner.sendTurn(taskId, session, buildRejectionFeedbackPrompt(rejects, rosterText), runId)
      if (!active()) return false
      if (!turn.ok) throw new Error(turn.error || '回灌回合失败')
      for (const n of parseRoundNotes(turn.response)) {
        note(`领队评估：${n.outcome}${n.reason ? ' — ' + n.reason : ''}`)
      }
      scanTexts = [turn.delegationText ?? '', turn.response]
      finalResponse = turn.response
      return true
    } catch (e) {
      note(`⚠ 拒单回灌失败: ${e instanceof Error ? e.message : String(e)}`)
      return false
    }
  }

  while (round < budget) {
    if (!active()) return abandoned()
    const calls = parseDelegatesMerged(...scanTexts)
    // 收编流式期间提前建的单（等待未决建单完成）。seenKeys 是本会话出现过的全部派单
    // key（含已交付的）：领队在回灌/评估回合里复述旧派单标记时，绝不能当成新派单再建。
    const early = await runner.takeEarlySpawns(taskId)
    if (!active()) return abandoned()
    const fresh = calls.filter((c) => !early.seenKeys.has(`${c.to}\n${c.prompt}`))
    if (!fresh.length && !early.entries.length) {
      // 全部派单已在流式阶段处理且无一建单：把拒单原因回灌，让领队当场改派
      if (await feedbackRejections()) continue
      break
    }
    round++
    const roundChildren = new Map<string, DelegateCall>()
    for (const entry of early.entries) {
      if (entry.childId && store.get(entry.childId)) roundChildren.set(entry.childId, entry.call)
    }
    if (fresh.length) {
      note(`第 ${round} 轮派发：${fresh.map((c) => `${c.to}${c.reason ? `（${c.reason}）` : ''}`).join('、')}${early.entries.length ? `（另有 ${early.entries.length} 单已在流式中提前接单）` : ''}`)
      for (const call of fresh) {
        const child = await runner.spawnDelegateChild(taskId, call, runId)
        if (!active()) return abandoned()
        if (child) roundChildren.set(child.id, call)
      }
    } else {
      note(`第 ${round} 轮：${early.entries.length} 个子任务已在流式中提前接单`)
    }
    if (!roundChildren.size) {
      // 本轮新建的派单全部被护栏拒绝：回灌原因让领队改派，而不是静默结束这轮
      if (await feedbackRejections()) continue
      break
    }
    const childIds = [...roundChildren.keys()]
    allChildren.push(...childIds)
    pushTask(taskId)

    // 等待本轮子任务全部终态（提前建的单可能早已完成，等待即刻通过）
    await new Promise<void>((resolve) => {
      const check = () => {
        const states = childIds.map((id) => store.get(id)?.status)
        if (!active() || states.every((s) => s === undefined || s === 'done' || s === 'failed' || s === 'cancelled')) resolve()
        else setTimeout(check, 1500)
      }
      check()
    })
    if (!active()) return abandoned()

    // 汇报回灌（带单号；审核协议追加）
    const childSeqMap = new Map<string, number>()
    const report = childIds
      .map((id, idx) => {
        const c = store.get(id)!
        if (!c) return childReportEntry('worker', 'cancelled', idx + 1, 'Task was removed')
        const call = roundChildren.get(id)
        const seq = idx + 1
        childSeqMap.set(id, seq)
        const body = c.status === 'done' ? (c.result ?? '').slice(0, 4000) : `状态 ${c.status}${c.error ? ': ' + c.error.slice(0, 300) : ''}`
        return childReportEntry(call?.to ?? c.agentId ?? c.backend, c.status, seq, body)
      })
      .join('\n\n')
    // 拒单随报告捎带：只靠「整轮零新单」兜底送达的话，领队每轮都有新单时永远收不到，
    // 会带着「该单在途」的幻觉继续排计划（iss_t_mu5t2em6_ymbllw 实测：混合轮里一单被拒，
    // 领队连着多轮评估「仍在途等回灌」，该工作项无人领）。take 即清空，兜底通道不会重复送。
    const rideAlongRejects = runner.takeDelegateRejections(taskId)
    let rejectNotice = ''
    let continueInstruction = CONTINUE_INSTRUCTION
    if (rideAlongRejects.length) {
      note(`⚠ ${rideAlongRejects.length} 条派单被拒（未建单），原因随报告回灌给领队改派`)
      rejectNotice = buildRejectNotice(rideAlongRejects, rosterText)
      continueInstruction = CONTINUE_INSTRUCTION_WITH_REJECTS
    }
    note(`第 ${round} 轮结果已回灌，等待领队继续`)
    try {
      const turn = await runner.sendTurn(taskId, session,
        `${REPORT_PROMPT_HEADER}\n\n${report}${rejectNotice}\n\n${continueInstruction}${REVIEW_INSTRUCTION}`, runId
      )
      if (!active()) return abandoned()
      if (!turn.ok) throw new Error(turn.error || '回灌回合失败')
      for (const n of parseRoundNotes(turn.response)) {
        note(`第 ${round} 轮评估：${n.outcome}${n.reason ? ' — ' + n.reason : ''}`)
      }
      // 处理审核结论（每轮回灌后对本轮 done 子任务匹配审核）
      const reviews = parseReviews(turn.response)
      for (const childId of childIds) {
        const child = store.get(childId)
        if (!child || child.status !== 'done') continue
        const seq = childSeqMap.get(childId)
        const call = roundChildren.get(childId)
        // 匹配：#序号 精确匹配，兜底按队员名/标题子串
        const review = reviews.find((r) => r.of === `#${seq}`)
          ?? reviews.find((r) => r.of === call?.to || (child.title && child.title.includes(r.of)))
        if (!review) {
          note(`单 #${seq} 未出审核结论，保留人工审核`)
          continue
        }
        ctx.applyReview?.(childId, review.verdict, review.note)
        note(`单 #${seq} 审核${review.verdict === 'pass' ? '通过' : '退回'}${review.note ? `：${review.note}` : ''}`)
      }
      scanTexts = [turn.delegationText ?? '', turn.response]
      finalResponse = turn.response
    } catch (e) {
      if (!active()) return abandoned()
      note(`⚠ 回灌失败: ${e instanceof Error ? e.message : String(e)}`)
      // 领队会话已死（如应用重启）时回灌无处可去——把队员报告摘要落到 Issue 评论，
      // 别让成果随领队静默丢失；不自动重启领队，是否续跑留给用户
      const issueId = task.issueId
      if (issueId && allChildren.length) {
        const excerpts = allChildren.slice(0, 5).map((id) => {
          const child = store.get(id)
          return `- **${child?.title ?? id}**（${child?.status ?? '?'}）：${(child?.result ?? '').slice(0, 400) || '（无最终输出）'}`
        }).join('\n')
        ctx.addIssueComment?.(issueId, undeliveredReportComment(excerpts))
      }
      break
    }
  }

  // 循环结束仍有未送达的拒单（预算耗尽等路径）：留痕 + Issue 评论，不让工作项静默消失
  if (!active()) return abandoned()
  const leftoverRejects = runner.takeDelegateRejections(taskId)
  if (leftoverRejects.length) {
    note(`⚠ 委派结束仍有 ${leftoverRejects.length} 条派单被拒且未回灌：${leftoverRejects.map((r) => r.slice(0, 80)).join('；')}`)
    if (task.issueId) {
      ctx.addIssueComment?.(task.issueId, leftoverRejectsComment(leftoverRejects))
    }
  }

  // ---- git 集成（有仓库且产生了子任务时） ----
  let integrationNote = ''
  let integrationBranch = ''
  let gitDiff = ''
  let gitStat = ''
  let gitSnapshot: Task['gitSnapshot']
  if (hasRepo && task.workdir && baseBranch && allChildren.length) {
    integrationBranch = `agentdeck/task-${taskId}`
    let allOk = true
    const problems: string[] = []
    let idx = 0
    let mergedCount = 0
    for (const cid of allChildren) {
      idx++
      const c = store.get(cid)!
      if (!c.workdir) continue
      // 该子任务需要合入的分支：自己的工作分支（有改动时）+ 它作为子领队的集成分支（二层委派递归交付）
      const ownBranch = delegateChildBranch(c, taskId, idx)
      const subIntegration = await branchExists(task.workdir, `agentdeck/task-${cid}`) ? `agentdeck/task-${cid}` : ''
      if (!active()) return abandoned()
      if (!ownBranch && !subIntegration) {
        // 没有任何可集成改动，worktree 里没有值得保留的东西：直接回收
        const reclaimed = await reclaimWorktree(c.workdir)
        if (!active()) return abandoned()
        if (c.worktree) store.update(cid, {
          worktree: {
            ...c.worktree,
            cleanupStatus: reclaimed.status,
            ...(reclaimed.reason ? { cleanupReason: reclaimed.reason } : {}),
            ...(reclaimed.ok ? { cleanedAt: Date.now() } : {})
          }
        })
        if (!reclaimed.ok) {
          allOk = false
          problems.push(`worktree cleanup: ${reclaimed.reason ?? reclaimed.status}`)
        }
        continue
      }
      if (ownBranch) await commitAll(c.workdir, `agentdeck: ${c.title}`)
      if (!active()) return abandoned()
      let childOk = true
      for (const b of [ownBranch, subIntegration].filter(Boolean)) {
        const r = await mergeBranchInto(task.workdir, integrationBranch, b!)
        if (!active()) return abandoned()
        if (!r.ok) {
          childOk = false
          allOk = false
          problems.push(r.message)
          if (c.worktree) store.update(cid, {
            worktree: { ...c.worktree, cleanupStatus: 'retained', cleanupReason: r.message }
          })
          if (r.conflict) break
        } else {
          mergedCount++
        }
      }
      // 收尾回收：全部合入集成分支后 worktree 即无保留价值（改动都在集成分支上），
      // 顺带删掉已合并的工作分支；有失败/冲突则保留现场便于排查，留待任务删除时回收
      if (childOk) {
        const reclaimed = await reclaimWorktree(c.workdir)
        if (!active()) return abandoned()
        if (c.worktree) store.update(cid, {
          worktree: {
            ...c.worktree,
            cleanupStatus: reclaimed.status,
            ...(reclaimed.reason ? { cleanupReason: reclaimed.reason } : {}),
            ...(reclaimed.ok ? { cleanedAt: Date.now() } : {})
          }
        })
        if (!reclaimed.ok && reclaimed.status === 'failed') {
          childOk = false
          allOk = false
          problems.push(`worktree cleanup: ${reclaimed.reason ?? 'failed'}`)
        }
        if (childOk && ownBranch && !(await deleteBranch(task.workdir, ownBranch))) {
          if (!active()) return abandoned()
          childOk = false
          allOk = false
          problems.push(`branch cleanup: ${ownBranch}`)
          if (c.worktree) store.update(cid, {
            worktree: { ...c.worktree, cleanupStatus: 'retained', cleanupReason: `branch ${ownBranch} could not be deleted` }
          })
          await markWorktreeCleanup(c.workdir, 'retained', `branch ${ownBranch} could not be deleted`)
        }
        if (!active()) return abandoned()
      }
      if (!allOk) break
    }
    if (allOk && mergedCount > 0) {
      const sum = await branchDiffSummary(task.workdir, baseBranch, integrationBranch)
      if (!active()) return abandoned()
      gitDiff = sum.diff
      gitStat = sum.stat
      gitSnapshot = sum.snapshot
      integrationNote = `改动已合入集成分支 ${integrationBranch}（基线 ${baseBranch}，${mergedCount} 个子任务），确认后可自行 merge`
      note(`集成完成 → ${integrationBranch}`)
    } else if (allOk) {
      // 没有任何子任务产生可合并改动（可能都改在了主目录或无改动）
      const dirty = await import('./git').then((g) => g.snapshotGitAfter(task.workdir))
      if (!active()) return abandoned()
      gitDiff = dirty.diff || ""
      gitStat = dirty.stat || ""
      gitSnapshot = dirty.snapshot
      integrationNote = '子任务无独立分支改动；领队若自己改了文件，改动保留在主目录工作区（未提交）'
    } else {
      // 一次性告知：失败原因只进时间线事件（收件箱/看板等错误面亦可散见），
      // 不写进常驻的集成横幅——横幅长期挂在任务详情上只会在事后造成噪音
      note(`集成停止：${problems.join('; ')}`)
    }
  }

  if (!active()) return abandoned()
  store.update(taskId, {
    ...(integrationBranch ? { integration: { branch: integrationBranch, note: integrationNote } } : {}),
    gitDiff: gitDiff || undefined,
    gitStat: gitStat || undefined,
    gitSnapshot: gitSnapshot ? { ...gitSnapshot, runId, phaseIndex: task.phaseIndex, startedAt: task.startedAt } : undefined,
    roundsUsed: round
  } as Partial<Task>)
  pushTask(taskId)

  return { rounds: round, children: allChildren, finalText: stripReviews(stripRoundNotes(stripDelegates(finalResponse || scanTexts[0] || scanTexts[1]))), scanTexts }
}
