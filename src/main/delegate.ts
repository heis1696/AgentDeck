// 委派协议：领队 agent 的内置能力。
// 领队系统提示告知队员名单与 <delegate> 标记语法；运行时截获标记 → 并行执行子任务 →
// 结果回灌 → 领队继续。循环直到领队不再派发。任何支持续聊的后端都适用。
// 提示词文案集中在 src/main/prompts/delegation.ts（本文件只保留解析器与循环逻辑）。
import type { Task, TaskEvent } from '../shared/types'
import type { TaskExpectation, TaskStore } from './store'
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
  leftoverRejectsComment,
  workerFullReportComment,
  reportCopyMarkdown,
  fullTextPointerLines
} from './prompts'
import {
  branchExists,
  branchDiffSummary,
  branchHead,
  commitAll,
  createWorktreeAtBranch,
  currentBranch,
  deleteBranch,
  isGitRepo,
  markWorktreeCleanup,
  mergeBranchInto,
  mergeIntoManagedWorktree,
  reclaimWorktree,
  snapshotGitAfter,
  worktreeChangeDigest,
  writeReportCopy,
  type WorktreeChangeDigest
} from './git'
import { currentGitChanges } from '../shared/git-snapshot'

/** Issue 评论的最小形状：addComment 成功返回；null = Issue 不存在（调用方必须降级，不静默丢） */
export interface IssueCommentLike {
  id: string
}

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
  /** Issue 评论（队员全文报告与回灌失败兜底的落点）。返回 null = Issue 不存在，未送达——
   *  调用方必须降级到任务证据/事件通道，绝不静默丢弃。 */
  addIssueComment?: (issueId: string, text: string) => IssueCommentLike | null
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

// ---- 回灌报告的 git 改动小节（修复「队员改了文件队长拿不到」：领队在反馈里直接看到改动面） ----

/** 体量界：整节 ≤2KB（按 UTF-8 字节计）、文件清单 ≤50 行（且 ≤800 字符），未跟踪文件名 ≤8 个；超限截断留标记 */
export const GIT_REPORT_SECTION_MAX_CHARS = 2048
const GIT_REPORT_STAT_MAX_LINES = 50
const GIT_REPORT_STAT_MAX_CHARS = 800
const GIT_REPORT_UNTRACKED_MAX = 8

// M4 注入面：小节内容全部来自队员可控的文件/改动文本，可伪造 ###/【系统】/六类协议
// 标记骗领队当成结构或指令。六个回合解析器全部是非锚定子串正则（行中同样命中），
// 行首加「\」前缀拦不住——防护用序列内部破坏：对六类标记的开/闭形态、```、行首 ###
// 与【系统 前缀字面量，在末字符前插一个「\」（如 <delegat\e、##\#），原字面量子串
// 不再连续出现、人读几乎无损；diff 行的 +/- 前缀只是普通文本，全局替换天然覆盖。
// 整节再用 ```text 围栏包裹（内容里的 ``` 已被破坏，关不掉围栏）。
const REPORT_LITERAL_RE = /<\/?(?:delegate|consult|investigate|review|round|continue)\b|```|【系统|###/g
const REPORT_FENCE_OPEN = '```text'
const REPORT_FENCE_CLOSE = '```'

/** 序列内部破坏：命中字面量在末字符前插「\」；破坏后的形态不再命中，重复处理幂等 */
function escapeProtocolLiterals(text: string): string {
  return text.replace(REPORT_LITERAL_RE, (m) => `${m.slice(0, -1)}\\${m.slice(-1)}`)
}

/** 把 worktreeChangeDigest 的原始摘录组装成回灌小节；无任何改动时返回 null（不留空小节） */
export function buildGitReportSection(digest: WorktreeChangeDigest): string | null {
  if (!digest.ok) return null
  if (!digest.stat.trim() && !digest.diff.trim() && !digest.untracked.length && !digest.nameStatus.trim()) return null
  const head = `【git 改动摘录】工作分支 \`${digest.branch || '（无元数据）'}\`（基线 ${digest.baseSha.slice(0, 8)}，对基线的全部改动）：`
  let statBlock = ''
  if (digest.stat.trim()) {
    const body = escapeProtocolLiterals(digest.stat.split('\n').map((line) => ` ${line}`).join('\n'))
    statBlock = `文件改动：\n${body}${digest.statTruncated ? '\n…（文件清单截断）' : ''}`
  }
  // B5 二进制可见性：--name-status 逐文件一行（A/M/D/R），diff 摘录被文本改动挤爆时
  // 二进制/删除/重命名仍凭这份清单可见
  let nameStatusBlock = ''
  if (digest.nameStatus.trim()) {
    const body = escapeProtocolLiterals(digest.nameStatus.split('\n').map((line) => ` ${line}`).join('\n'))
    nameStatusBlock = `文件状态（含二进制）：\n${body}${digest.nameStatusTruncated ? '\n…（状态清单截断）' : ''}`
  }
  // 未跟踪文件名逐项独立转义后再拼接：不靠对拼接结果的行级处理兜底（文件名可内嵌换行）
  const untrackedBlock = digest.untracked.length
    ? `未跟踪：${digest.untracked.map((name) => escapeProtocolLiterals(name)).join('、')}${digest.untrackedTruncated ? '…' : ''}`
    : ''
  // m2：「diff 摘要：」标题与 diff 块同生同死——没有可展示的 diff 就不留悬空标题
  const marker = '\n…（diff 截断）'
  const fixedBytes = (withDiffTitle: boolean) => Buffer.byteLength(
    [REPORT_FENCE_OPEN, head, statBlock, nameStatusBlock, untrackedBlock, ...(withDiffTitle ? ['diff 摘要：'] : []), REPORT_FENCE_CLOSE]
      .filter(Boolean).join('\n'), 'utf8')
  let diffBlock = ''
  if (digest.diff.trim()) {
    // m1：体量界按字节计——截断标记等中文字面量的 .length 远小于其实际字节数
    let budget = GIT_REPORT_SECTION_MAX_CHARS - fixedBytes(true) - Buffer.byteLength(marker, 'utf8')
    // 字面量破坏插入的反斜杠余量：命中数未知，统一留 32B，最终还有整节级的字节兜底
    budget -= 32
    if (budget > 0) {
      let text = digest.diff.replace(/\n$/, '')
      let truncated = digest.diffTruncated
      if (Buffer.byteLength(text, 'utf8') > budget) {
        truncated = true
        while (text.length > 0 && Buffer.byteLength(text, 'utf8') > budget) text = text.slice(0, Math.floor(text.length * 0.9))
        const boundary = text.lastIndexOf('\n')
        text = boundary > 0 ? text.slice(0, boundary) : text
      }
      diffBlock = text + (truncated ? marker : '')
    }
  }
  const content = [head, statBlock, nameStatusBlock, untrackedBlock, ...(diffBlock ? ['diff 摘要：', diffBlock] : [])]
    .filter(Boolean).join('\n')
  const fence = (inner: string) => {
    const escaped = escapeProtocolLiterals(inner).split('\n')
    // 首行是我们自己的小节标题（【git 改动摘录】…），不属于队员可控文本，不转义
    const headLine = inner.split('\n')[0]
    if (escaped[0] !== headLine) escaped[0] = headLine
    return `${REPORT_FENCE_OPEN}\n${escaped.join('\n')}\n${REPORT_FENCE_CLOSE}`
  }
  // 终保：极端多字节内容（长中文路径等）+ 破坏插入的字节超出体量界时按字节收缩并留标记
  if (Buffer.byteLength(fence(content), 'utf8') <= GIT_REPORT_SECTION_MAX_CHARS) return fence(content)
  const endMark = '\n…（截断）'
  let inner = content
  while (inner.length > 0 && Buffer.byteLength(fence(inner) + endMark, 'utf8') > GIT_REPORT_SECTION_MAX_CHARS) {
    inner = inner.slice(0, Math.floor(inner.length * 0.9))
  }
  return `${fence(inner)}${endMark}`
}

// ---- 单条回灌摘要的结构化组装（A1：结论段有界 + git 小节 + 全文入口指引；4000 只兜底） ----

/** 结论段摘录字数：result 首部进摘要的量；全文走双落通道（Issue 评论 + 报告副本） */
export const REPORT_CONCLUSION_CHARS = 1200
/** 摘要物理硬顶：结构化摘要下正常到不了这里，只是最后防线；触发必须带「N 字未送」标记 */
export const REPORT_BODY_HARD_CAP = 4000

export interface ChildReportBodyInput {
  status: string
  result?: string
  error?: string
  /** git 改动小节（buildGitReportSection 产物；自带围栏与转义） */
  gitSection?: string | null
  /** 全文入口指引行（原文；这里统一过转义防护） */
  pointers?: string[]
}

/** 结构化摘要体：结论段（result 首部有界）+ git 改动小节 + 全文入口指引。
 *  队员可控文本（结论段、指引里的路径）不做伪装结构承诺，指引行统一过字面量破坏转义。 */
export function buildChildReportBody(input: ChildReportBodyInput): string {
  const parts: string[] = []
  if (input.status === 'done') {
    const result = input.result ?? ''
    const head = result.slice(0, REPORT_CONCLUSION_CHARS)
    parts.push(head)
    if (result.length > head.length) {
      parts.push(`…（结论段只摘前 ${REPORT_CONCLUSION_CHARS} 字，后 ${result.length - head.length} 字未进摘要；全文见下方入口）`)
    }
  } else {
    parts.push(`状态 ${input.status}${input.error ? ': ' + input.error.slice(0, 300) : ''}`)
  }
  if (input.gitSection) parts.push(input.gitSection)
  if (input.pointers?.length) parts.push(input.pointers.map((line) => escapeProtocolLiterals(line)).join('\n'))
  const body = parts.filter((part) => part !== '').join('\n\n')
  const overflow = body.length - REPORT_BODY_HARD_CAP
  if (overflow <= 0) return body
  return body.slice(0, REPORT_BODY_HARD_CAP)
    + `\n…（回灌正文超 ${REPORT_BODY_HARD_CAP} 字触发最后防线截断：后 ${overflow} 字未送；全文见 Issue 评论与报告副本）`
}

/**
 * 委派循环：在领队回合结束后执行。
 * session 已就绪；每轮解析 delegate 标记 → 生成子任务 → 等终态 → 结果回灌 session.send。
 * 标记解析用回合文本的全部来源（终态全文/流式累计并集 + 最后一条消息，多源去重——
 * 单一来源可能不含中间消息里的标记）；最终结果只取每轮最后一条 assistant 消息
 * （response），避免中间过程灌进 result/回灌上下文。
 *
 * `expected` 是本次委派所属运行的完整执行归属（发起该回合前捕获）。循环不再从
 * store 重新读取身份：所有事件追加、状态写入和内存状态收编都以它为准，回合终态
 * 之后被替换的运行不会被旧响应、旧轮数或旧集成结果污染。
 */
export function runDelegationLoop(taskId: string, session: BackendSession, first: BackendTurnResult, ctx: DelegationContext): Promise<DelegationOutcome>
export function runDelegationLoop(taskId: string, session: BackendSession, first: BackendTurnResult, expected: TaskExpectation, ctx: DelegationContext): Promise<DelegationOutcome>
export async function runDelegationLoop(
  taskId: string,
  session: BackendSession,
  first: BackendTurnResult,
  expectedOrContext: TaskExpectation | DelegationContext,
  context?: DelegationContext
): Promise<DelegationOutcome> {
  const ctx = context ?? expectedOrContext as DelegationContext
  const { store, runner, pushTask, pushEvent } = ctx
  // Preserve the four-argument entry for direct consumers. Production passes
  // the expectation captured before the turn, rather than discovering it here.
  const observed = context ? undefined : store.get(taskId)
  const expected: TaskExpectation = context ? expectedOrContext as TaskExpectation
    : { status: 'running', runId: observed?.runId, executionOwner: observed?.executionOwner }
  const runId = expected.runId
  const active = () => store.matches(taskId, expected)
  const abandoned = (): DelegationOutcome => ({ rounds: 0, children: [], finalText: '', scanTexts: [] })
  if (!active()) return abandoned()
  const task = store.get(taskId)
  if (!task) return abandoned()
  const team = ctx.getTeam()
  const me = team.find((a) => a.id === task.agentId)
  const subs = (me?.subordinates ?? []).map((id) => team.find((a) => a.id === id)).filter(Boolean) as AgentLike[]
  if (!subs.length) return { rounds: 0, children: [], finalText: first.response, scanTexts: [first.delegationText ?? '', first.response] }

  const note = (text: string) => {
    if (!active()) return
    const e = { ts: Date.now(), kind: 'status' as const, text }
    // A refused conditional append means this loop no longer owns the Run:
    // only an accepted event may reach host-side consumers.
    const full = store.appendEvent(taskId, e, expected)
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
  const reportedChildren = new Map<string, Task>()
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
    const rejects = runner.takeDelegateRejections(taskId, runId)
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
    const early = await runner.takeEarlySpawns(taskId, runId)
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

    // multica「nothing silently discarded」：队员终态（含 failed）即把 worktree 改动 commitAll
    // 落盘到其工作分支，不等集成期——此后即便领队被替换/取消（本循环任何一步早退），
    // 队员的实际改动都已留在可发现的分支提交里，而不是悬在随时可能被清扫的未提交状态。
    // 只对带 worktree 元数据的队员执行（workdir 属于隔离 worktree）；cancelled 不在此列，
    // 其现场保持原样交由保留判定与人工处理。
    for (const id of childIds) {
      const c = store.get(id)
      if (!c?.worktree || !c.workdir || (c.status !== 'done' && c.status !== 'failed')) continue
      await commitAll(c.workdir, `agentdeck: ${c.title}`)
      if (!active()) return abandoned()
    }

    // ---- 全文双落（队员终态即执行，不随摘要回灌的成败）：完整 result 同时落到
    // ① 领队 Issue 评论（store 无上限，截断只发生在调用点）与 ② 领队 workdir 的
    // .agentdeck-reports/<单号>.md（info/exclude 忽略，零污染；二层领队落自己的
    // workdir，机制相同）。评论未送达（返回 null）必须留痕降级，绝不静默丢弃。
    const fullTextEntries = new Map<string, { seq: number; issueOk: boolean; copyPath: string }>()
    for (let idx = 0; idx < childIds.length; idx++) {
      const id = childIds[idx]
      const c = store.get(id)
      if (!c || (c.status !== 'done' && c.status !== 'failed')) continue
      const seq = idx + 1
      const fullBody = c.status === 'done'
        ? (c.result ?? '').trim() || '（无最终输出）'
        : `状态 ${c.status}${c.error ? ': ' + c.error : ''}`
      let issueOk = false
      if (task.issueId) {
        const comment = ctx.addIssueComment?.(task.issueId, workerFullReportComment(c.title, seq, c.status, c.runId ?? '', fullBody)) ?? null
        issueOk = !!comment
        if (!issueOk) note(`⚠ 单 #${seq} 的全文评论未送达（Issue 不存在或已删除），全文以报告副本与任务时间线为准`)
      }
      let copyPath = ''
      if (task.workdir && hasRepo) {
        const written = await writeReportCopy(task.workdir, id, reportCopyMarkdown({
          childId: id, title: c.title, seq, status: c.status, runId: c.runId ?? '', finishedAt: Date.now(), body: fullBody
        }))
        if (!active()) return abandoned()
        if (written) copyPath = written
        else note(`⚠ 单 #${seq} 的报告副本写入失败（领队工作区不可写），全文仅存 Issue 评论`)
      }
      fullTextEntries.set(id, { seq, issueOk, copyPath })
    }

    // 汇报回灌（带单号；审核协议追加）。摘要改为结构化组装：单号+状态在条目标题，
    // 体是「结论段（result 首部有界）+ git 改动小节 + 全文入口指引」——4000 字物理截断
    // 只是最后防线（触发带截断标记），全文已双落，摘要不再承担携带全文的职责。
    // done 单的 git 小节：集成期 commitAll 在循环之后才跑，此刻 worktree 里是未提交
    // 改动——digest 只读计算（对 worktree 基线 sha diff + 未跟踪列名），让领队不依赖
    // 集成就能「验收」改动面。
    const childSeqMap = new Map<string, number>()
    const reportEntries: string[] = []
    for (let idx = 0; idx < childIds.length; idx++) {
      const id = childIds[idx]
      const c = store.get(id)
      if (!c) {
        reportEntries.push(childReportEntry('worker', 'cancelled', idx + 1, 'Task was removed'))
        continue
      }
      reportedChildren.set(id, c)
      const call = roundChildren.get(id)
      const seq = idx + 1
      childSeqMap.set(id, seq)
      let gitSection: string | null = null
      if (c.status === 'done' && c.worktree && c.workdir) {
        const digest = await worktreeChangeDigest(c.workdir, c.worktree, {
          diffChars: 1200, statLines: GIT_REPORT_STAT_MAX_LINES, statChars: GIT_REPORT_STAT_MAX_CHARS, untrackedNames: GIT_REPORT_UNTRACKED_MAX
        })
        if (!active()) return abandoned()
        gitSection = buildGitReportSection(digest)
      }
      const full = fullTextEntries.get(id)
      const body = buildChildReportBody({
        status: c.status,
        result: c.result,
        error: c.error,
        gitSection,
        pointers: full ? fullTextPointerLines(full.copyPath, full.issueOk, full.seq) : []
      })
      reportEntries.push(childReportEntry(call?.to ?? c.agentId ?? c.backend, c.status, seq, body))
    }
    const report = reportEntries.join('\n\n')
    // 拒单随报告捎带：只靠「整轮零新单」兜底送达的话，领队每轮都有新单时永远收不到，
    // 会带着「该单在途」的幻觉继续排计划（iss_t_mu5t2em6_ymbllw 实测：混合轮里一单被拒，
    // 领队连着多轮评估「仍在途等回灌」，该工作项无人领）。take 即清空，兜底通道不会重复送。
    const rideAlongRejects = runner.takeDelegateRejections(taskId, runId)
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
        const comment = ctx.addIssueComment?.(issueId, undeliveredReportComment(excerpts)) ?? null
        if (!comment) note(`⚠ Issue 评论未送达（Issue 不存在），队员报告摘要转投任务时间线：\n${excerpts}`)
      }
      break
    }
  }

  // 循环结束仍有未送达的拒单（预算耗尽等路径）：留痕 + Issue 评论，不让工作项静默消失
  if (!active()) return abandoned()
  const leftoverRejects = runner.takeDelegateRejections(taskId, runId)
  if (leftoverRejects.length) {
    note(`⚠ 委派结束仍有 ${leftoverRejects.length} 条派单被拒且未回灌：${leftoverRejects.map((r) => r.slice(0, 80)).join('；')}`)
    if (task.issueId) {
      const comment = ctx.addIssueComment?.(task.issueId, leftoverRejectsComment(leftoverRejects)) ?? null
      if (!comment) note('⚠ Issue 评论未送达（Issue 不存在），被拒派单以任务时间线留痕为准')
    }
  }

  // ---- git 集成（有仓库且产生了子任务时） ----
  let integrationNote = ''
  let integrationBranch = ''
  let pendingFollow: Awaited<ReturnType<typeof createWorktreeAtBranch>> = null
  let gitDiff = ''
  let gitStat = ''
  let gitSnapshot: Task['gitSnapshot']
  if (hasRepo && task.workdir && baseBranch && allChildren.length) {
    const childIdentity = (child: Task): TaskExpectation => ({
      status: child.status, runId: child.runId, executionOwner: child.executionOwner,
      attempt: child.attempt, startedAt: child.startedAt, phaseIndex: child.phaseIndex,
      workdir: child.workdir, workVersion: child.workVersion
    })
    const candidates = [...reportedChildren.values()].filter((child) => !!child.workdir)
    const terminal = candidates.every((child) => ['done', 'failed', 'cancelled'].includes(child.status))
    const operation = terminal ? store.claimGitOperation([
      { id: taskId, expected: { ...expected, workdir: task.workdir, workVersion: task.workVersion } },
      ...candidates.map((child) => ({ id: child.id, expected: childIdentity(child) }))
    ]) : undefined
    if (!operation) {
      note('Git integration deferred: an execution changed or another Git operation owns the workspace')
    } else {
      try {
        integrationBranch = `agentdeck/task-${taskId}`
        // 续链二次集成：领队 workdir 已是检出集成分支的托管 worktree（上一轮集成切过基线）。
        // 临时 worktree 再检出同一分支会被 git 拒绝——此轮 merge 就地做（mergeIntoManagedWorktree
        // 只接受 .agentdeck-worktrees 托管目录，用户工作副本绝不就地改）；证据 diff 改用本轮
        // 集成起点 sha（此时 base 分支即集成分支自身，base...integration 会得到空证据）。
        const leaderOnIntegration = baseBranch === integrationBranch
        const roundBaseSha = leaderOnIntegration ? await branchHead(task.workdir, integrationBranch) : ''
        if (!active()) return abandoned()
        let allOk = true
        const problems: string[] = []
        let idx = 0
        let mergedCount = 0
        for (const cid of allChildren) {
          idx++
          const c = reportedChildren.get(cid)
          if (!c || !c.workdir) continue
          // Every child write is bound to the exact child record this pass read:
          // a child that was re-run cannot receive a stale worktree conclusion.
          const capturedChild: TaskExpectation = { ...childIdentity(c), gitOperationToken: operation.token }
          // 该子任务需要合入的分支：自己的工作分支（有改动时）+ 它作为子领队的集成分支（二层委派递归交付）
          const ownBranch = delegateChildBranch(c, taskId, idx)
          const subIntegration = await branchExists(task.workdir, `agentdeck/task-${cid}`) ? `agentdeck/task-${cid}` : ''
          if (!active()) return abandoned()
          if (!ownBranch && !subIntegration) {
            // 没有任何可集成改动，worktree 里没有值得保留的东西：直接回收
            const reclaimed = await reclaimWorktree(c.workdir)
            if (!active()) return abandoned()
            if (c.worktree) store.updateIf(cid, capturedChild, {
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
          let childAdvanced = false
          for (const b of [ownBranch, subIntegration].filter(Boolean)) {
            // M3：merge 对 Already-up-to-date 的分支返回成功但不产生新提交——
            // 只有集成分支 HEAD 真实前进才计入 mergedCount，否则空 diff 会清掉既有证据
            const headBefore = await branchHead(task.workdir, integrationBranch)
            if (!active()) return abandoned()
            const r = leaderOnIntegration
              ? await mergeIntoManagedWorktree(task.workdir, b!, taskId)
              : await mergeBranchInto(task.workdir, integrationBranch, b!)
            if (!active()) return abandoned()
            if (!r.ok) {
              childOk = false
              allOk = false
              problems.push(r.message)
              if (c.worktree) store.updateIf(cid, capturedChild, {
                worktree: { ...c.worktree, cleanupStatus: 'retained', cleanupReason: r.message }
              })
              if (r.conflict) break
            } else {
              const headAfter = await branchHead(task.workdir, integrationBranch)
              if (headAfter && headAfter !== headBefore) childAdvanced = true
            }
          }
          if (childAdvanced) mergedCount++
          // 收尾回收：全部合入集成分支后 worktree 即无保留价值（改动都在集成分支上），
          // 顺带删掉已合并的工作分支；有失败/冲突则保留现场便于排查，留待任务删除时回收
          if (childOk) {
            const reclaimed = await reclaimWorktree(c.workdir)
            if (!active()) return abandoned()
            if (c.worktree) store.updateIf(cid, capturedChild, {
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
              if (c.worktree) store.updateIf(cid, capturedChild, {
                worktree: { ...c.worktree, cleanupStatus: 'retained', cleanupReason: `branch ${ownBranch} could not be deleted` }
              })
              await markWorktreeCleanup(c.workdir, 'retained', `branch ${ownBranch} could not be deleted`)
            }
            if (!active()) return abandoned()
          }
          if (!allOk) break
        }
        if (allOk && mergedCount > 0) {
          const sum = await branchDiffSummary(task.workdir, leaderOnIntegration && roundBaseSha ? roundBaseSha : baseBranch, integrationBranch)
          if (!active()) return abandoned()
          gitDiff = sum.diff
          gitStat = sum.stat
          gitSnapshot = sum.snapshot
          // B4 取舍标注：领队未提交基线经回放提交进了集成分支，领队原工作区仍持同一份
          // 未提交改动（跨线合并是人/后续流程的事）——集成证据与 UI 说明必须亮明这一点
          const replayedFiles = [...reportedChildren.values()]
            .reduce((total, child) => total + (child.worktree?.replay?.files ?? 0), 0)
          integrationNote = `改动已合入集成分支 ${integrationBranch}（基线 ${baseBranch}，${mergedCount} 个子任务${replayedFiles ? `；含领队回放基线 ${replayedFiles} 文件` : ''}），确认后可自行 merge`
          note(`集成完成 → ${integrationBranch}${replayedFiles ? `（含领队回放基线 ${replayedFiles} 文件）` : ''}`)
          // ---- 续链换基线：领队工作目录切到集成分支的托管 worktree ----
          // 只在首次集成成功（本轮基线还不是集成分支）时切换；用户当前分支/仓库根副本绝不改——
          // 只新建 .agentdeck-worktrees 下的 worktree 并把 task.workdir 指过去（owner metadata
          // 登记 + 删任务连带回收 + 启动清扫走既有渠道）。此后 followUp/续聊/二次派单自然以
          // 集成结果为基线（子单 base=集成分支）。早退/无改动/失败路径不切换。
          if (!leaderOnIntegration) {
            // M2 快照口径（切换前收编）：workdir 切走后，领队留在原目录的未提交改动不再属于
            // 任何快照——切换前先摘录进本轮证据，不从 gitDiff/gitStat 静默消失。
            const prior = await snapshotGitAfter(task.workdir)
            if (!active()) return abandoned()
            if (prior.diff.trim() || prior.stat.trim()) {
              const label = `\n\n--- 领队原目录未提交改动（切换前收编自 ${task.workdir}） ---\n`
              gitDiff = (gitDiff + label + prior.diff).slice(0, 200_000)
              gitStat = `${gitStat}\n${prior.stat}`.slice(0, 10_000)
              note(`领队原目录的未提交改动已收编进本轮证据（切换后原目录不再属于快照口径）`)
            }
            const wt = await createWorktreeAtBranch(task.workdir, `task-${taskId}-integrated`, integrationBranch, taskId)
            if (!wt) {
              note(`⚠ 续链基线切换失败：集成分支 ${integrationBranch} 已可用，但领队工作目录保持原位`)
            } else {
              // M1 拆两步：目录建好后只在此挂起，落盘挪到 git operation 释放后的第一条语句
              // （下方）——operation 持有期内 store 禁止 workVersion 变化，而改 workdir 必然
              // 触发自动 bump，落盘只能放在释放之后；从释放到落盘之间零 await、零 active()
              // 早退，窗口同样消除。若落盘仍失败（任务已被替换/取消），回滚目录、分支保留。
              pendingFollow = wt
            }
          }
        } else if (allOk) {
          // 没有任何子任务产生可合并改动（可能都改在了主目录或无改动）。
          // M3：工作副本也干净时整段省略证据键——否则一个 clean workspace 快照会顶掉
          // 既有集成快照，finalizer 随即把上一轮的 gitDiff/gitStat 当无证据清空。
          const dirty = await snapshotGitAfter(task.workdir)
          if (!active()) return abandoned()
          if (dirty.diff.trim() || dirty.stat.trim()) {
            gitDiff = dirty.diff || ''
            gitStat = dirty.stat || ''
            gitSnapshot = dirty.snapshot
          }
          integrationNote = '子任务无独立分支改动；领队若自己改了文件，改动保留在主目录工作区（未提交）'
        } else {
          // 一次性告知：失败原因只进时间线事件（收件箱/看板等错误面亦可散见），
          // 不写进常驻的集成横幅——横幅长期挂在任务详情上只会在事后造成噪音
          note(`集成停止：${problems.join('; ')}`)
        }
      } finally {
        store.releaseGitOperation(operation)
      }
      // M1 拆两步（续）：operation 一释放立刻落盘续链 worktree 的归属——从上面的 finally
      // 到这里零 await、零 active() 早退，窗口消除。落盘成功后任何早退留下的都是已登记的
      // 续链 worktree（清扫按 owner.integration.branch 保留）；落盘失败（任务已被替换/
      // 取消）则回滚刚建的目录：集成分支保留（结果都在分支上），绝不留孤儿 worktree。
      if (pendingFollow) {
        const persisted = store.updateIf(taskId, expected, {
          integration: { branch: integrationBranch, note: integrationNote },
          workdir: pendingFollow.path,
          worktree: pendingFollow.metadata
        })
        if (persisted) {
          pushTask(taskId)
          note(`续链基线已切换：领队工作区 → 集成 worktree（检出 ${integrationBranch}），后续追问/续聊/派单以集成结果为基线`)
        } else {
          await reclaimWorktree(pendingFollow.path)
          note('⚠ 续链基线切换未落盘（任务归属已变化），集成结果保留在集成分支上')
        }
        pendingFollow = null
      }
    }
  }

  if (!active()) return abandoned()
  // Read the current record for the phase fields and commit conditionally on
  // this Run: a replaced Run keeps whatever the replacement wrote.
  const current = store.get(taskId)
  const updated = store.updateIf(taskId, expected, {
    ...(integrationBranch ? { integration: { branch: integrationBranch, note: integrationNote } } : {}),
    // M3：本轮没有产生新证据时不带这些键——store.update 走 Object.assign，连 undefined
    // 也会覆盖；显式省略才能保住上一轮的 gitDiff/gitStat/gitSnapshot（如二轮无净新增）。
    ...(gitDiff ? { gitDiff } : {}),
    ...(gitStat ? { gitStat } : {}),
    ...(gitSnapshot ? { gitSnapshot: { ...gitSnapshot, runId, phaseIndex: current?.phaseIndex, startedAt: current?.startedAt } } : {}),
    roundsUsed: round
  } as Partial<Task>)
  if (updated) pushTask(taskId)

  return { rounds: round, children: allChildren, finalText: stripReviews(stripRoundNotes(stripDelegates(finalResponse || scanTexts[0] || scanTexts[1]))), scanTexts }
}
