// 委派协议：领队 agent 的内置能力。
// 领队系统提示告知队员名单与 <delegate> 标记语法；运行时截获标记 → 并行执行子任务 →
// 结果回灌 → 领队继续。循环直到领队不再派发。任何支持续聊的后端都适用。
// 提示词文案集中在 src/main/prompts/delegation.ts（本文件只保留解析器与循环逻辑）。
import path from 'node:path'
import type { Task, TaskEvent, ThinkingLevel } from '../shared/types'
import type { TaskExpectation, TaskStore } from './store'
import type { TaskRunner } from './runner'
import type { BackendSession, BackendTurnResult } from './backends/types'
import {
  childReportEntry,
  buildRejectionFeedbackPrompt,
  buildRejectNotice,
  buildReportFeedback,
  budgetTailFeedback,
  policyRejectionPrompt,
  summaryFallbackNote,
  longResultOmittedNote,
  undeliveredReportComment,
  leftoverRejectsComment,
  workerFullReportComment,
  reportCopyMarkdown,
  fullTextPointerLines,
  CHILD_SUMMARY_BODY_PREFIX,
  childSummaryPrompt,
  DELEGATE_REJECT_EXCERPT_MARK,
  REPORT_INLINE_MAX
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
  mergeIntoManagedWorktreeDetached,
  reclaimWorktree,
  reportCopyRelPath,
  sameWorktreePath,
  snapshotGitAfter,
  worktreeChangeDigest,
  writeReportCopy,
  type WorktreeChangeDigest
} from './git'
import { clampIssueCommentBytes } from './issue-relay'
import { currentGitChanges } from '../shared/git-snapshot'

// 拒因摘录标记与回灌界定义在 prompts/delegation.ts（提示词与组装共用同一处）；此处转出口供 runner/smoke 沿用旧导入路径
export { DELEGATE_REJECT_EXCERPT_MARK, REPORT_INLINE_MAX }

const stripRejectExcerpt = (reason: string): string => {
  const excerptStart = reason.indexOf(DELEGATE_REJECT_EXCERPT_MARK)
  return excerptStart < 0 ? reason : reason.slice(0, excerptStart)
}

/** Issue 评论的最小形状：addComment 成功返回；null = Issue 不存在（调用方必须降级，不静默丢） */
export interface IssueCommentLike {
  id: string
}

export interface DelegateCall {
  to: string
  prompt: string
  /** 派工理由（领队自述，留痕展示用） */
  reason?: string
  /** summary 属性（可选布尔）：领队自评该单回灌需要压缩结论时才加——
   *  结果超回灌界时向子单会话追加一轮总结，用总结（非全文）作回灌体 */
  summary?: boolean
  /** sparse 属性（可选，原文保真）：子任务 worktree 的稀疏检出目录前缀列表（逗号分隔）。
   *  缺省 = 全量检出，行为与无此属性时完全一致；值合法性（通配符/空值）由 parseSparseAttr
   *  统一判定，建树侧据此生效或回落全量（docs/WORKTREE-BIG-REPO-PERF.md §6.1/§7.3） */
  sparse?: string
}

/** sparse 属性解析结果（§7.3）：
 *  - undeclared：缺省 / 空值 / 全空白 → 视为未声明，全量检出，行为与今天完全一致
 *  - dirs：合法目录前缀列表（已归一为 `/` 分隔、去重保序）
 *  - invalid：格式非法（含通配符 *?[] 或越界 .. 段）→ 建树侧整单回落全量并注记，绝不拒单 */
export type SparseParseResult =
  | { kind: 'undeclared' }
  | { kind: 'dirs'; dirs: string[] }
  | { kind: 'invalid'; reason: string }

/** sparse 属性值解析：逗号分隔目录前缀；`/` 与 `\` 分隔符都收、统一归一为 `/`；
 *  空段（含全空白值）视为未声明；值里出现通配符 `*?[]` 判格式非法（返回 invalid，
 *  文案供时间线注记）；`..` 段同样按格式非法处理（越界目录在 cone 模式无意义）。
 *  分段归一剥空段/`.` 段/首部 `/`（绝对路径按仓库相对收）与尾 `/` 后去重保序；
 *  归一后为空（如 `sparse="."`，语义即全量）= 未声明。 */
export function parseSparseAttr(value: string | undefined): SparseParseResult {
  if (value === undefined) return { kind: 'undeclared' }
  if (!value.trim()) return { kind: 'undeclared' }
  if (/[*?[\]]/.test(value)) return { kind: 'invalid', reason: `含通配符（${value.trim()}）——稀疏范围只收目录前缀` }
  const dirs: string[] = []
  for (const raw of value.split(',')) {
    const segments = raw.trim().replace(/\\/g, '/').split('/')
    if (segments.includes('..')) return { kind: 'invalid', reason: `含越界路径段（${raw.trim()}）——稀疏范围必须是仓库内目录前缀` }
    const dir = segments.filter((segment) => segment && segment !== '.').join('/')
    if (!dir) continue
    if (!dirs.includes(dir)) dirs.push(dir)
  }
  return dirs.length ? { kind: 'dirs', dirs } : { kind: 'undeclared' }
}

/** 属性扫描：name 必须是独立属性名（名称边界——data-summary 不撞 summary），
 *  值支持双/单引号与裸词（裸词值必须有捕获组，否则 to=Worker 一律落空串派不出去、
 *  summary=false 判真）；引号值整体一个 token 消费，值内部出现的其他属性名字样
 *  不会被再认出来（单引号 reason 值内的 summary="true" 不误启）。残缺引号按裸词
 *  吸收，不再向后方扩散。 */
function parseTagAttrs(attrs: string): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = []
  // 组号：1=属性名（带=）；2=双引号值；3=单引号值；4=裸词值；5=独立属性名（裸属性）
  const re = /([a-zA-Z_][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*))|([a-zA-Z_][\w:-]*)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(attrs))) {
    out.push({ name: (m[1] ?? m[5]).toLowerCase(), value: (m[2] ?? m[3] ?? m[4] ?? '').trim() })
  }
  return out
}

function tagAttr(attrs: string, name: string): string | undefined {
  const hit = parseTagAttrs(attrs).find((a) => a.name === name.toLowerCase())
  return hit ? hit.value : undefined
}

/** summary 布尔属性：支持裸属性（summary）与显式值（summary="true"/"false"），
 *  值按大小写规范化布尔（"FALSE"/"False" 同样为假）；解析走同一份属性扫描——
 *  名称边界与引号值整体消费由扫描器保证，reason 值内出现 summary 一词不误判。 */
function summaryAttr(attrs: string): boolean {
  const hit = parseTagAttrs(attrs).find((a) => a.name === 'summary')
  return !!hit && hit.value.toLowerCase() !== 'false'
}

/** 从领队回复中提取 delegate 标记（容错：任意属性顺序、md fence 内）。
 *  开标签必须带 to 属性才构成匹配（lookahead）：无 to 的裸标记字样不成为匹配起点，
 *  否则非贪婪体会一路延伸、吞掉后方真实派单的闭合标签（幻影吞单）。
 *  体部哨兵化：正文绝不跨过下一个 <delegate 开标记——残缺标记（漏写闭合/闭合损坏）
 *  的匹配在自己身上失败，吞不了其后真实派单（实测事故：领队引用语法示例
 *  <delegate to="X" reason="…"> 忘写闭合，非贪婪体吃到真实派单的闭合标签，
 *  有效单被并进无效单的 prompt 整体消失，只余对 X 的拒单、有效单零痕迹）。 */
const DELEGATE_RE = /<delegate\b(?=[^>]*\bto\s*=)([^>]*)>((?:(?!<delegate\b)[\s\S])*?)<\/delegate>/

interface DelegateMatch {
  call?: DelegateCall
  start: number
  end: number
}

function matchDelegates(text: string): DelegateMatch[] {
  const out: DelegateMatch[] = []
  const re = new RegExp(DELEGATE_RE.source, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    // 区间对空 prompt/缺 to 的匹配同样登记：它们结构完整（展示剥离要剥掉），
    // 只是构不成派单；残缺开标记的判定（findUnmatchedDelegateOpens）依赖完整区间
    const entry: DelegateMatch = { start: m.index, end: re.lastIndex }
    const prompt = m[2].trim()
    const to = tagAttr(m[1], 'to')
    const reason = tagAttr(m[1], 'reason')
    const sparse = tagAttr(m[1], 'sparse')
    if (prompt && to) entry.call = { to, prompt, ...(reason ? { reason } : {}), ...(summaryAttr(m[1]) ? { summary: true } : {}), ...(sparse !== undefined ? { sparse } : {}) }
    out.push(entry)
  }
  return out
}

export function parseDelegates(text: string): DelegateCall[] {
  return matchDelegates(text).flatMap((m) => (m.call ? [m.call] : []))
}

/** 检出残缺的 delegate 开标记：带 to= 却未被任何完整匹配消费 = 没写闭合或闭合损坏。
 *  残缺标记的正文边界不可知、自身不构成派单，但必须被具名回执（走既有拒单通道），
 *  绝不允许领队按协议「只有已接单或具名拒单才能确认结果」等到永远。
 *  embedded=截断致残：该开标记与其后方某个完整匹配之间既没有有效闭合、也没有任何
 *  闭合形态的字样（< /delegate 之类写坏的闭合也算闭合尝试）——它的正文撞上哨兵边界
 *  （下一个 <delegate 开标记）被截断，后方的完整标记按字面独立解析受理。闭合写坏后
 *  接独立有效单的形态（正文在自己写坏的闭合处结束）不属此类，不得误标内嵌。
 *  契约（保守事实性文案）：只陈述「本单未建单 + 其后完整标记按字面独立受理」，不断言
 *  内嵌单已执行——它按字面受理后仍可能被护栏具名拒单，执行与否以各自回执为准。 */
export function findUnmatchedDelegateOpens(text: string): Array<{ to: string; excerpt: string; embedded: boolean }> {
  const out: Array<{ to: string; excerpt: string; embedded: boolean }> = []
  const matched = matchDelegates(text)
  const reOpen = /<delegate\b(?=[^>]*\bto\s*=)([^>]*)>/g
  let m: RegExpExecArray | null
  while ((m = reOpen.exec(text))) {
    if (matched.some((range) => m!.index >= range.start && m!.index < range.end)) continue
    const to = tagAttr(m[1], 'to')
    if (!to) continue
    const bodyStart = m.index + m[0].length
    const embedded = matched.some((range) => range.start > m!.index && !/<\s*\/\s*delegate/i.test(text.slice(m!.index, range.start)))
    out.push({ to, excerpt: text.slice(bodyStart, bodyStart + 80).trim(), embedded })
  }
  return out
}

/** 残缺开标记的具名拒单文案（bail 与循环扫尾共用同一文案源头）：
 *  截断致残用事实性描述——本单未建单 + 其后完整派单标记按字面独立受理（不断言其
 *  已执行，受理后的拒单/回执各自送达）；纯残缺维持缺闭合/闭合损坏的原文案。 */
export function unmatchedDelegateOpenReason(broken: { to: string; excerpt: string; embedded?: boolean }, why?: string): string {
  const base = broken.embedded
    ? `to="${broken.to}"：标记残缺（缺 </delegate> 闭合或被其后完整派单标记截断），本单未建单；其后出现的完整派单标记按字面独立受理`
    : `to="${broken.to}"：标记残缺（缺 </delegate> 闭合或闭合损坏），未建单`
  return why ? `${base}——${why}` : base
}

/** 把 delegate 标记从对外展示文本中剥掉（同解析规则：只剥带 to 的真实派单，不吞裸字样后的正文；
 *  哨兵化同源——残缺标记剥不掉自身、其文本保留展示，绝不越界吞掉后方派单的展示文本） */
export function stripDelegates(text: string): string {
  return text.replace(new RegExp(DELEGATE_RE.source, 'g'), '').trim()
}

// ---- 队长间咨询（阶段 1）：目标是另一位队长的办公室会话 ----

export interface ConsultCall {
  to: string
  prompt: string
  reason?: string
}

/** 解析 consult 标记（与 delegate 同构：开标签必须带 to 避免裸标记吞掉后方真实咨询；
 *  体部哨兵化——正文绝不跨过下一个 <consult 开标记，残缺标记（漏写闭合/闭合损坏）
 *  的匹配在自己身上失败，吞不了其后真实咨询的闭合标签——案情一同形态：领队引用
 *  咨询示例忘写闭合，非贪婪体吃到真实咨询的闭合标签，有效咨询被并进无效单整体消失）。 */
const CONSULT_RE = /<consult\b(?=[^>]*\bto\s*=)([^>]*)>((?:(?!<consult\b)[\s\S])*?)<\/consult>/

export function parseConsults(text: string): ConsultCall[] {
  const out: ConsultCall[] = []
  const re = new RegExp(CONSULT_RE.source, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const prompt = m[2].trim()
    const to = tagAttr(m[1], 'to')
    const reason = tagAttr(m[1], 'reason')
    if (prompt && to) out.push({ to, prompt, ...(reason ? { reason } : {}) })
  }
  return out
}

/** 同源剥离（与解析同一份正则）：残缺标记剥不掉自身、其文本保留展示，绝不越界吞掉
 *  后方咨询的展示文本。 */
export function stripConsults(text: string): string {
  return text.replace(new RegExp(CONSULT_RE.source, 'g'), '').trim()
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

const INVESTIGATE_RE = /<investigate\b(?=[^>]*\bto\s*=)([^>]*)>((?:(?!<investigate\b)[\s\S])*?)<\/investigate>/

export function parseInvestigates(text: string): InvestigateCall[] {
  const out: InvestigateCall[] = []
  const re = new RegExp(INVESTIGATE_RE.source, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const prompt = m[2].trim()
    const to = tagAttr(m[1], 'to')
    const reason = tagAttr(m[1], 'reason')
    if (prompt && to) out.push({ to, prompt, ...(reason ? { reason } : {}) })
  }
  return out
}

/** 同源剥离（与解析同一份正则），语义同 stripConsults。 */
export function stripInvestigates(text: string): string {
  return text.replace(new RegExp(INVESTIGATE_RE.source, 'g'), '').trim()
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

// ---- consult/investigate 残缺开标记检出（与 delegate 同构的具名回执机械）----
// 残缺标记解析不出咨询/调查≠可以无痕：必须被具名回执，绝不允许领队按「已应答」
// 契约等到永远。embedded=截断致残（其正文撞哨兵边界被截断，后方完整标记按字面
// 独立受理）；契约（保守事实性文案）：只陈述「本单未应答 + 其后完整标记按字面独立
// 受理」，不断言内嵌单已应答——受理后是否应答以各自回执为准。

function findUnmatchedOpens(text: string, tag: string, blockRe: RegExp): Array<{ to: string; excerpt: string; embedded: boolean }> {
  const out: Array<{ to: string; excerpt: string; embedded: boolean }> = []
  const matched: Array<{ start: number; end: number }> = []
  const reBlocks = new RegExp(blockRe.source, 'g')
  let m: RegExpExecArray | null
  while ((m = reBlocks.exec(text))) matched.push({ start: m.index, end: reBlocks.lastIndex })
  const reOpen = new RegExp(`<${tag}\\b(?=[^>]*\\bto\\s*=)([^>]*)>`, 'g')
  let o: RegExpExecArray | null
  while ((o = reOpen.exec(text))) {
    if (matched.some((range) => o!.index >= range.start && o!.index < range.end)) continue
    const to = tagAttr(o[1], 'to')
    if (!to) continue
    const bodyStart = o.index + o[0].length
    const embedded = matched.some((range) => range.start > o!.index && !new RegExp(`<\\s*/\\s*${tag}`, 'i').test(text.slice(o!.index, range.start)))
    out.push({ to, excerpt: text.slice(bodyStart, bodyStart + 80).trim(), embedded })
  }
  return out
}

export function findUnmatchedConsultOpens(text: string): Array<{ to: string; excerpt: string; embedded: boolean }> {
  return findUnmatchedOpens(text, 'consult', CONSULT_RE)
}

export function findUnmatchedInvestigateOpens(text: string): Array<{ to: string; excerpt: string; embedded: boolean }> {
  return findUnmatchedOpens(text, 'investigate', INVESTIGATE_RE)
}

export function unmatchedConsultOpenReason(broken: { to: string; excerpt: string; embedded?: boolean }, why?: string): string {
  const base = broken.embedded
    ? `to="${broken.to}"：consult 标记残缺（缺 </consult> 闭合或被其后完整咨询标记截断），本单未应答；其后出现的完整咨询标记按字面独立受理`
    : `to="${broken.to}"：consult 标记残缺（缺 </consult> 闭合或闭合损坏），未应答`
  return why ? `${base}——${why}` : base
}

export function unmatchedInvestigateOpenReason(broken: { to: string; excerpt: string; embedded?: boolean }, why?: string): string {
  const base = broken.embedded
    ? `to="${broken.to}"：investigate 标记残缺（缺 </investigate> 闭合或被其后完整调查标记截断），本单未应答；其后出现的完整调查标记按字面独立受理`
    : `to="${broken.to}"：investigate 标记残缺（缺 </investigate> 闭合或闭合损坏），未应答`
  return why ? `${base}——${why}` : base
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

/** 末尾锚定主通道：标记后只允许空白。起点取末尾闭合标签之前的**最后一个**开标记
 *  （lookahead 断言其后全文不再有开标记字样）——agent 正文先出现开标记（讨论/复述里
 *  引用「我会输出 <continue …> 标记」）、末尾才写真实标记时，简报从真实标记起算，
 *  不再被拼进前文。 */
const CONTINUE_TAIL_RE = /<continue\b(?![\s\S]*<continue\b)([^>]*)>([\s\S]*?)<\/continue>\s*$/
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
 * 锚定起点取末尾闭合标签之前的最后一个开标记：正文先出现开标记、末尾写真实标记时，
 * 简报从真实标记起算，不把中间正文拼进简报。
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
  /** 思考强度档位（Agent.thinking 透传给 backend.start） */
  thinking?: ThinkingLevel
  /** 只读协作标记：true 时派单直接共享领队工作区、不建隔离 worktree（审码/咨询类零建树开销） */
  sharedWorkspace?: boolean
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
  /** 总结轮通路（独立实现）：对已终态子单的存活会话追加一轮 prompt→reply。
   *  返回 null = 无存活会话/后端不支持续轮；回合 !ok = 总结轮失败——调用方一律按 C 行为回退。 */
  sendChildSummaryTurn?: (childId: string, content: string) => Promise<BackendTurnResult | null>
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
export function escapeProtocolLiterals(text: string): string {
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

// ---- 单条回灌正文的结构化组装（C 保底：短文原文整段回灌；长文只回 git 小节 + 全文入口） ----
// 回灌界 REPORT_INLINE_MAX（≤ 此界原文整段进正文；超过则正文不放原文，只回 git 改动小节 + 全文入口指引，
// 领队可选派单时标 summary 走总结轮）定义在 prompts/delegation.ts，派发协议对领队讲的是同一个数。

/** 码点级计数（O(n) 零分配）：代理对算一个码点 */
function countCodepoints(text: string): number {
  let count = 0
  for (let i = 0; i < text.length; i++, count++) {
    const code = text.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) i++
    }
  }
  return count
}

export interface ChildReportBodyInput {
  status: string
  result?: string
  error?: string
  /** git 改动小节（buildGitReportSection 产物；自带围栏与转义） */
  gitSection?: string | null
  /** 全文入口指引行（原文；这里统一过转义防护） */
  pointers?: string[]
  /** 已采纳的队员总结（总结轮产出；原文，这里统一过转义防护）——采纳时正文以它为回灌体 */
  summary?: string
  /** 总结轮回退注记（系统文案原样进正文；如「总结轮未产出」「总结仍超长」） */
  summaryFallbackNote?: string
}

/** 回灌正文：done 单 = 队员总结（已采纳时，前置非全文标注）或原文整段（≤回灌界，码点级）；
 *  原文超界且无可用总结时正文不放原文，只留注记（总结轮回退注记，或未走总结轮时的超界注记——
 *  说明原文为什么不在，领队不会误以为队员没交代）+ git 改动小节 + 全文入口指引。
 *  任何路径不做切片、不留截断标记——全文由双落通道（Issue 评论 + 报告副本）携带。
 *  队员可控文本统一过序列内破坏转义（与 git 小节同源），回灌体里不再有可解析的活标记。 */
export function buildChildReportBody(input: ChildReportBodyInput): string {
  const parts: string[] = []
  if (input.status === 'done') {
    const summary = (input.summary ?? '').trim()
    if (summary) {
      parts.push(`${CHILD_SUMMARY_BODY_PREFIX}\n${escapeProtocolLiterals(summary)}`)
    } else {
      const result = (input.result ?? '').trim()
      const chars = countCodepoints(result)
      if (result && chars <= REPORT_INLINE_MAX) parts.push(escapeProtocolLiterals(result))
      else if (result && !input.summaryFallbackNote) parts.push(longResultOmittedNote(chars))
    }
    if (input.summaryFallbackNote) parts.push(input.summaryFallbackNote)
  } else {
    // failed/error 路径与 result/总结同源转义：队员可控的 error 文本不得携带可解析的活标记
    parts.push(`状态 ${input.status}${input.error ? ': ' + escapeProtocolLiterals(input.error) : ''}`)
  }
  if (input.gitSection) parts.push(input.gitSection)
  if (input.pointers?.length) parts.push(input.pointers.map((line) => escapeProtocolLiterals(line)).join('\n'))
  return parts.filter((part) => part !== '').join('\n\n')
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
  // 共享目录/子单树归属按别名折叠判定（与 git.ts 路径键同源）：共享工作区与自有树
  // 的等值判断大小写敏感时，别名写法的 child.workdir 会被误判「独占树」或漏判共享，
  // 回收归属随之出错（共享目录误回收/自有树漏回收）
  const sharesLeaderWorkspace = (child: Task) => {
    const agent = team.find((candidate) => candidate.id === child.agentId)
    return agent?.sharedWorkspace === true && !!task.workdir && !!child.workdir
      && sameWorktreePath(child.workdir, task.workdir)
  }
  const childOwnsWorktree = (child: Task) => !!child.worktree && !!child.workdir
    && !sharesLeaderWorkspace(child)
    && child.worktree.ownerTaskId === child.id
    && sameWorktreePath(child.worktree.path, child.workdir)
  const me = team.find((a) => a.id === task.agentId)
  const subs = (me?.subordinates ?? []).map((id) => team.find((a) => a.id === id)).filter(Boolean) as AgentLike[]

  const note = (text: string) => {
    if (!active()) return
    const e = { ts: Date.now(), kind: 'status' as const, text }
    // A refused conditional append means this loop no longer owns the Run:
    // only an accepted event may reach host-side consumers.
    const full = store.appendEvent(taskId, e, expected)
    if (full) pushEvent(taskId, full)
  }
  const pendingRejections = () => typeof runner.peekDelegateRejections === 'function'
    ? runner.peekDelegateRejections(taskId, runId)
    : runner.takeDelegateRejections(taskId, runId)
  const acknowledgeRejections = (count: number) => {
    if (typeof runner.acknowledgeDelegateRejections === 'function') runner.acknowledgeDelegateRejections(taskId, runId, count)
  }

  const hasRepo = subs.length && task.workdir ? await isGitRepo(task.workdir) : false
  if (!active()) return abandoned()
  const baseBranch = hasRepo && task.workdir ? await currentBranch(task.workdir) : ''
  if (!active()) return abandoned()

  // ---- 二层委派的三道闸（0.7.0；建单路径的同类闸在 runner.spawnDelegateChild）----
  const { inherited, depth } = ancestorBudget(store, taskId)
  const maxDepth = ctx.opts().maxDepth ?? MAX_DEPTH
  const maxRounds = ctx.opts().maxRounds ?? MAX_ROUNDS
  const maxTotalRounds = ctx.opts().maxTotalRounds ?? MAX_TOTAL_ROUNDS
  const bail = async (why: string): Promise<DelegationOutcome> => {
    note(`⚠ ${why}，本任务不再下派`)
    // 护栏早退即关闭流式建单通道：拒单回灌回复里再流式输出新标记不再建单（有效目标的
    // 新标记否则会被嗅探建出孤儿单），全部走下方逐单对账具名拒单。
    runner.suspendDelegateSpawns?.(taskId)
    // 逐单对账（复核②）：本回合文本里每个派单标记要么已有子单（流式提前建单）、
    // 要么已有具名拒单、要么此刻补具名拒单。拒单队列非空绝不代表整批已处理——
    // 实测形态：X 在流式里被拒（队列已有 X）+ Y 只出现在终态文本，旧逻辑见队列非空
    // 直接跳过解析，Y 既无子单也无拒单、整单无痕。
    const early = await runner.takeEarlySpawns(taskId, runId)
    if (!active()) return abandoned()
    const acceptedKeys = new Set(early.entries.map((entry) => `${entry.call.to}\n${entry.call.prompt}`))
    const calls = parseDelegatesMerged(first.delegationText ?? '', first.response)
    for (const call of calls) {
      const key = `${call.to}\n${call.prompt}`
      if (acceptedKeys.has(key)) continue
      if (runner.delegateRejectionRecorded?.(taskId, runId, key)) continue
      runner.recordDelegateRejection(taskId, `to="${call.to}"：${why}；不要原样重派`, { to: call.to, prompt: call.prompt })
    }
    // 残缺开标记同样具名（解析不出派单≠可以无痕）：护栏触发时领队也要知道它们未建单
    const bailBrokenSeen = new Set<string>()
    for (const text of [first.delegationText ?? '', first.response]) {
      for (const broken of findUnmatchedDelegateOpens(text)) {
        const key = `${broken.to}\n${broken.excerpt}`
        if (bailBrokenSeen.has(key)) continue
        bailBrokenSeen.add(key)
        runner.recordDelegateRejection(taskId, unmatchedDelegateOpenReason(broken, why), { to: broken.to, prompt: broken.excerpt })
      }
    }
    let rejects = pendingRejections()
    if (rejects.length) {
      try {
        const turn = await runner.sendTurn(taskId, session, policyRejectionPrompt(rejects), runId)
        if (!active()) return abandoned()
        if (!turn.ok) throw new Error(turn.error || '拒单回灌失败')
        acknowledgeRejections(rejects.length)
        // 拒单回灌回复若再出新标记，同样逐单对账（建议并入⑤）：已接单/已有具名拒单的
        // 复述不误拒，真正的新标记此刻补具名拒单——护栏已触发绝不建单；残缺开标记同规。
        // 此刻已无下一轮回灌通道，新拒单以时间线留痕 + Issue 评论兜底，不再追加回合
        // （对拒单回灌再做回灌会无界循环）。
        const bailReconciled = new Set(acceptedKeys)
        const bailRejectsBefore = pendingRejections().length
        for (const call of parseDelegatesMerged(turn.delegationText ?? '', turn.response)) {
          const key = `${call.to}\n${call.prompt}`
          if (bailReconciled.has(key)) continue
          if (runner.delegateRejectionRecorded?.(taskId, runId, key)) { bailReconciled.add(key); continue }
          runner.recordDelegateRejection(taskId, `to="${call.to}"：${why}；不要原样重派`, { to: call.to, prompt: call.prompt })
          bailReconciled.add(key)
        }
        const bailBrokenSeen = new Set<string>()
        for (const text of [turn.delegationText ?? '', turn.response]) {
          for (const broken of findUnmatchedDelegateOpens(text)) {
            const key = `${broken.to}\n${broken.excerpt}`
            if (bailBrokenSeen.has(key)) continue
            bailBrokenSeen.add(key)
            runner.recordDelegateRejection(taskId, unmatchedDelegateOpenReason(broken, why), { to: broken.to, prompt: broken.excerpt })
          }
        }
        const bailNewRejects = pendingRejections().length - bailRejectsBefore
        if (bailNewRejects > 0) {
          note(`⚠ 拒单回灌回复仍出现 ${bailNewRejects} 条未受理的新派单/残缺标记（护栏已触发不建单），已具名留痕`)
          if (task.issueId) ctx.addIssueComment?.(task.issueId, leftoverRejectsComment(pendingRejections()))
        }
        return { rounds: 0, children: [], finalText: stripDelegates(turn.response), scanTexts: [turn.delegationText ?? '', turn.response] }
      } catch (error) {
        note(`⚠ 政策拒单未送达领队：${error instanceof Error ? error.message : String(error)}`)
        if (task.issueId) ctx.addIssueComment?.(task.issueId, leftoverRejectsComment(rejects))
      }
    }
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
  const rosterText = subs.map((a) => `${a.name}（${a.backend}）`).join('、') || '当前为空'
  const feedbackRejections = async (): Promise<boolean> => {
    if (!active()) return false
    const rejects = pendingRejections()
    const policyOnly = rejects.length > 0 && rejects.every((reason) => /防环拒单|委派层级已达上限|全链委派轮数预算已耗尽/.test(stripRejectExcerpt(reason)))
    if (!rejects.length || rejectedFeedbacks >= (policyOnly ? 1 : 2)) return false
    rejectedFeedbacks++
    note(`⚠ ${rejects.length} 条派单被拒（未建单），原因回灌给领队改派`)
    try {
      const turn = await runner.sendTurn(taskId, session, buildRejectionFeedbackPrompt(rejects, rosterText), runId)
      if (!active()) return false
      if (!turn.ok) throw new Error(turn.error || '回灌回合失败')
      acknowledgeRejections(rejects.length)
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

  // ---- 预算收尾（复核④）：最后预算回合的报告回灌若已流式提前建单，循环退出前必须
  // 收编该单——等待终态、计入集成候选、最后一轮报告回灌；未受理的新标记一律具名拒单。
  // 循环顶部只在轮首收编提前建单，最后一轮回灌自身流式出来的新单没人收：不在此收口，
  // 它们就悬空（建了单没人等、没回灌、不进集成），领队与看板都看不到其终局。
  const collectBudgetTail = async (): Promise<void> => {
    const tail = await runner.takeEarlySpawns(taskId, runId)
    if (!active()) return
    const tailChildren = new Map<string, DelegateCall>()
    for (const entry of tail.entries) {
      if (entry.childId && store.get(entry.childId)) tailChildren.set(entry.childId, entry.call)
    }
    // 未受理的新标记（最后轮文本里解析得出、既未建单也无具名拒单）：预算已尽，具名拒单。
    // 对账以已接单键为准（seenKeys 含本会话全部已受理/已回执的派单 key）：领队在收尾
    // 回复里复述已接单标记不得误发拒单；真正的新标记不绕过。
    const budgetReject = (call: DelegateCall) => {
      const key = `${call.to}\n${call.prompt}`
      if (tail.seenKeys.has(key)) return
      if (runner.delegateRejectionRecorded?.(taskId, runId, key)) return
      runner.recordDelegateRejection(taskId, `to="${call.to}"：委派轮数预算已耗尽，未建单；不要原样重派`, { to: call.to, prompt: call.prompt })
    }
    // 残缺开标记同样不绕过（出口复用具名残缺拒单规则）：解析不出派单≠可以无痕
    const budgetBrokenSeen = new Set<string>()
    const budgetRejectBroken = (text: string) => {
      for (const broken of findUnmatchedDelegateOpens(text)) {
        const key = `${broken.to}\n${broken.excerpt}`
        if (budgetBrokenSeen.has(key)) continue
        budgetBrokenSeen.add(key)
        runner.recordDelegateRejection(taskId, unmatchedDelegateOpenReason(broken, '委派轮数预算已耗尽'), { to: broken.to, prompt: broken.excerpt })
      }
    }
    for (const call of parseDelegatesMerged(...scanTexts)) budgetReject(call)
    for (const text of scanTexts) budgetRejectBroken(text)
    if (!tailChildren.size) return
    // 等待收编单全部终态（提前建的单可能早已完成，等待即刻通过）
    await new Promise<void>((resolve) => {
      const check = () => {
        const states = [...tailChildren.keys()].map((id) => store.get(id)?.status)
        if (!active() || states.every((s) => s === undefined || s === 'done' || s === 'failed' || s === 'cancelled')) resolve()
        else setTimeout(check, 1500)
      }
      check()
    })
    if (!active()) return
    // 队员改动落盘（multica「nothing silently discarded」，与主循环同规）
    for (const id of tailChildren.keys()) {
      const c = store.get(id)
      if (!c?.worktree || !c.workdir || (c.status !== 'done' && c.status !== 'failed')) continue
      await commitAll(c.workdir, `agentdeck: ${c.title}`)
      if (!active()) return
    }
    // 全文双落 + 报告组装（与主循环同源文案）；单号顺延已报告子单之后。
    // 收编单变 cancelled 保留终局回执：状态行进报告，不从回灌与 allChildren 静默消失。
    const tailEntries: string[] = []
    const tailSeq = new Map<string, number>()
    let seq = allChildren.length
    for (const [id, call] of tailChildren) {
      const c = store.get(id)
      if (!c || (c.status !== 'done' && c.status !== 'failed' && c.status !== 'cancelled')) continue
      seq++
      tailSeq.set(id, seq)
      reportedChildren.set(id, c)
      const fullBody = c.status === 'done' ? (c.result ?? '').trim() || '（无最终输出）' : `状态 ${c.status}${c.error ? ': ' + c.error : ''}`
      let copyRel = ''
      let issueOk = false
      if (c.status !== 'cancelled' && task.workdir && hasRepo) {
        const written = await writeReportCopy(task.workdir, id, reportCopyMarkdown({ childId: id, title: c.title, seq, status: c.status, runId: c.runId ?? '', finishedAt: Date.now(), body: fullBody }))
        if (!active()) return
        if (written) copyRel = reportCopyRelPath(task.workdir, written)
        else note(`⚠ 收编单 #${seq} 的报告副本写入失败（领队工作区不可写），全文仅存 Issue 评论`)
      }
      if (c.status !== 'cancelled' && task.issueId) {
        let commentText = workerFullReportComment(c.title, seq, c.status, c.runId ?? '', fullBody)
        const clamped = clampIssueCommentBytes(commentText)
        if (clamped.truncated) {
          commentText = copyRel
            ? `${clamped.text}\n\n…（评论超出 64KB 通道上限已截断，完整全文以报告副本为准：${copyRel}）`
            : `${clamped.text}\n\n…（评论超出 64KB 通道上限已截断，且报告副本写入失败，全文未完整留存）`
        }
        issueOk = !!ctx.addIssueComment?.(task.issueId, commentText)
        if (!issueOk) note(`⚠ 收编单 #${seq} 的全文评论未送达（Issue 不存在或已删除），全文以报告副本与任务时间线为准`)
      }
      let gitSection: string | null = null
      if (c.status === 'done' && c.worktree && c.workdir) {
        const digest = await worktreeChangeDigest(c.workdir, c.worktree, {
          diffChars: 1200, statLines: GIT_REPORT_STAT_MAX_LINES, statChars: GIT_REPORT_STAT_MAX_CHARS, untrackedNames: GIT_REPORT_UNTRACKED_MAX
        })
        if (!active()) return
        gitSection = buildGitReportSection(digest)
      }
      const body = buildChildReportBody({
        status: c.status,
        result: c.result,
        error: c.error,
        gitSection,
        pointers: fullTextPointerLines(copyRel, issueOk, seq)
      })
      tailEntries.push(childReportEntry(call?.to ?? c.agentId ?? c.backend, c.status, seq, body))
      allChildren.push(id)
    }
    if (!tailEntries.length) return
    pushTask(taskId)
    // 最后一轮回灌：拒单随报告捎带；指令明确「预算已尽、新派单不再受理」
    const rideAlong = pendingRejections()
    if (rideAlong.length) note(`⚠ ${rideAlong.length} 条派单被拒（未建单），原因随预算收尾报告回灌给领队`)
    note(`预算收尾：${tailEntries.length} 个流式提前建单的子任务已收编，回灌最后一轮结果`)
    // 收尾回合关闭流式建单通道（预算收尾护栏）：不守提示的领队在收尾回复里流式输出
    // 新标记时不再建单——回合末按已接单键对账，新标记具名拒单、复述不误拒、无孤儿子单。
    runner.suspendDelegateSpawns?.(taskId)
    try {
      const turn = await runner.sendTurn(taskId, session,
        budgetTailFeedback(tailEntries.join('\n\n'), rideAlong.length ? buildRejectNotice(rideAlong, rosterText) : ''), runId
      )
      if (!active()) return
      if (!turn.ok) throw new Error(turn.error || '预算收尾回灌失败')
      acknowledgeRejections(rideAlong.length)
      runner.acknowledgeDelegateReceipts?.(taskId, runId, [...tailChildren.keys()])
      for (const n of parseRoundNotes(turn.response)) {
        note(`领队评估：${n.outcome}${n.reason ? ' — ' + n.reason : ''}`)
      }
      // 审核结论与普通轮同规：收编报告附审核协议，领队的 review 标记在此匹配生效
      const reviews = parseReviews(turn.response)
      for (const [id, seqNo] of tailSeq) {
        const child = store.get(id)
        if (!child || child.status !== 'done') continue
        const call = tailChildren.get(id)
        const review = reviews.find((r) => r.of === `#${seqNo}`)
          ?? reviews.find((r) => r.of === call?.to || (child.title && child.title.includes(r.of)))
        if (!review) {
          note(`单 #${seqNo} 未出审核结论，保留人工审核`)
          continue
        }
        ctx.applyReview?.(id, review.verdict, review.note)
        note(`单 #${seqNo} 审核${review.verdict === 'pass' ? '通过' : '退回'}${review.note ? `：${review.note}` : ''}`)
      }
      // 收编回灌回合里出现的新标记：不会再受理（预算已尽、循环即将退出），按已接单键
      // 对账具名拒单；残缺开标记同规不绕过；未送达部分由循环后的遗留拒单通道兜底
      const tailTexts = [turn.delegationText ?? '', turn.response]
      for (const call of parseDelegatesMerged(...tailTexts)) budgetReject(call)
      for (const text of tailTexts) budgetRejectBroken(text)
      scanTexts = tailTexts
      finalResponse = turn.response
    } catch (e) {
      note(`⚠ 预算收尾回灌失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  for (;;) {
    if (!active()) return abandoned()
    if (round >= budget) {
      await collectBudgetTail()
      break
    }
    const calls = parseDelegatesMerged(...scanTexts)
    // 收编流式期间提前建的单（等待未决建单完成）。seenKeys 是本会话出现过的全部派单
    // key（含已交付的）：领队在回灌/评估回合里复述旧派单标记时，绝不能当成新派单再建。
    const early = await runner.takeEarlySpawns(taskId, runId)
    if (!active()) return abandoned()
    const fresh = calls.filter((c) => !early.seenKeys.has(`${c.to}\n${c.prompt}`))
    // 残缺标记（带 to= 但缺闭合/闭合损坏）具名回执：它们不构成派单，但领队协议是
    // 「只有已接单或具名拒单才能确认结果」，不回执它就会永远等下去（案情一的有效单
    // 正是先被残缺示例标记吞没、再整单无痕）。recordDelegateRejection 按 key 去重，
    // 同一文本多轮扫描不会重复记录。
    const brokenReported = new Set<string>()
    for (const text of scanTexts) {
      for (const broken of findUnmatchedDelegateOpens(text)) {
        const key = `${broken.to}\n${broken.excerpt}`
        if (brokenReported.has(key)) continue
        brokenReported.add(key)
        runner.recordDelegateRejection(taskId, unmatchedDelegateOpenReason(broken), { to: broken.to, prompt: broken.excerpt })
      }
    }
    if (!fresh.length && !early.entries.length) {
      // 全部派单已在流式阶段处理且无一建单：把拒单原因回灌，让领队当场改派
      if (await feedbackRejections()) continue
      break
    }
    const nextRound = round + 1
    const roundChildren = new Map<string, DelegateCall>()
    // 已受理（建出子单）的派单 key：扫尾时区分「已受理/已有具名拒单/静默丢失」
    const acceptedKeys = new Set<string>()
    for (const entry of early.entries) {
      if (entry.childId && store.get(entry.childId)) {
        roundChildren.set(entry.childId, entry.call)
        acceptedKeys.add(`${entry.call.to}\n${entry.call.prompt}`)
      }
    }
    let lostSpawns = 0
    if (fresh.length) {
      note(`第 ${nextRound} 轮派发：${fresh.map((c) => `${c.to}${c.reason ? `（${c.reason}）` : ''}`).join('、')}${early.entries.length ? `（另有 ${early.entries.length} 单已在流式中提前接单）` : ''}`)
      for (const call of fresh) {
        let child: Task | null = null
        try {
          child = await runner.spawnDelegateChild(taskId, call, runId)
        } catch (error) {
          // 建单通道异常不得连累整批：该单具名拒单走回执通道，其余派单照常受理
          lostSpawns++
          runner.recordDelegateRejection(taskId, `to="${call.to}"：建单异常（${error instanceof Error ? error.message : String(error)}），本单未执行`, { to: call.to, prompt: call.prompt })
          continue
        }
        if (!active()) return abandoned()
        if (child) {
          roundChildren.set(child.id, call)
          acceptedKeys.add(`${call.to}\n${call.prompt}`)
        }
      }
    } else {
      note(`第 ${nextRound} 轮：${early.entries.length} 个子任务已在流式中提前接单`)
    }
    // 逐单受理扫尾：既没建出子单、又没有具名拒单的派单 = 静默丢失（历史事故：seenKeys
    // 先登记 + 建单静默失败 → 回合末被「已处理」过滤整单无痕）。补具名拒单走既有回执
    // 通道，让「每一单要么有报告、要么有拒单」成为不变量。
    for (const call of fresh) {
      const key = `${call.to}\n${call.prompt}`
      if (acceptedKeys.has(key)) continue
      if (runner.delegateRejectionRecorded?.(taskId, runId, key)) continue
      lostSpawns++
      runner.recordDelegateRejection(taskId, `to="${call.to}"：建单未成功且无拒单原因（系统侧异常），本单未执行`, { to: call.to, prompt: call.prompt })
    }
    if (lostSpawns) note(`⚠ ${lostSpawns} 条派单未建成单（原因见拒单回灌），已具名回灌领队`)
    if (!roundChildren.size) {
      if (round === 0) round = 1
      // 本轮新建的派单全部被护栏拒绝：回灌原因让领队改派，而不是静默结束这轮
      if (await feedbackRejections()) continue
      break
    }
    round = nextRound
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
    // ① 领队主仓库根 .agentdeck-reports/<单号>.md（info/exclude 忽略，零污染；worktree
    // 内写入经 git-common-dir 归位主仓库根）与 ② 领队 Issue 评论（64KB 通道上限：钳制后
    // 持真实副本路径指引回权威层）。副本先行落盘（权威层），评论只是第二通道；
    // 评论未送达（返回 null）必须留痕降级，绝不静默丢弃。
    const fullTextEntries = new Map<string, { seq: number; issueOk: boolean; copyPath: string }>()
    for (let idx = 0; idx < childIds.length; idx++) {
      const id = childIds[idx]
      const c = store.get(id)
      if (!c || (c.status !== 'done' && c.status !== 'failed' && c.status !== 'cancelled')) continue
      const seq = idx + 1
      const fullBody = c.status === 'done'
        ? (c.result ?? '').trim() || '（无最终输出）'
        : `状态 ${c.status}${c.error ? ': ' + c.error : ''}`
      let copyAbs = ''
      if (task.workdir && hasRepo) {
        const written = await writeReportCopy(task.workdir, id, reportCopyMarkdown({
          childId: id, title: c.title, seq, status: c.status, runId: c.runId ?? '', finishedAt: Date.now(), body: fullBody
        }))
        if (!active()) return abandoned()
        if (written) copyAbs = written
        else note(`⚠ 单 #${seq} 的报告副本写入失败（领队工作区不可写），全文仅存 Issue 评论`)
      }
      let issueOk = false
      if (task.issueId) {
        let commentText = workerFullReportComment(c.title, seq, c.status, c.runId ?? '', fullBody)
        const clamped = clampIssueCommentBytes(commentText)
        if (clamped.truncated) {
          commentText = copyAbs
            ? `${clamped.text}\n\n…（评论超出 64KB 通道上限已截断，完整全文以报告副本为准：${reportCopyRelPath(task.workdir!, copyAbs)}）`
            : `${clamped.text}\n\n…（评论超出 64KB 通道上限已截断，且报告副本写入失败，全文未完整留存）`
        }
        const comment = ctx.addIssueComment?.(task.issueId, commentText) ?? null
        issueOk = !!comment
        if (!issueOk) note(`⚠ 单 #${seq} 的全文评论未送达（Issue 不存在或已删除），全文以报告副本与任务时间线为准`)
      }
      fullTextEntries.set(id, { seq, issueOk, copyPath: copyAbs ? reportCopyRelPath(task.workdir!, copyAbs) : '' })
    }

    // ---- summary 层（可选）：派单标了 summary 且结果超回灌界时，在全文双落之后向该
    // 子单会话追加一轮总结请求，产出（≤回灌界才采纳）作为回灌体并前置「非全文」标注。
    // 时序契约：commitAll 与全文双落已在上方完成且行为不变；总结轮不改子单终态；
    // 领队反馈等总结回合完成后才发出（下方回灌组装在此之后）。失败/不支持续轮/
    // 总结仍超长都只按 C 行为回退并注明原因，绝不循环重试。
    const summaryBodies = new Map<string, string>()
    const summaryFallbackNotes = new Map<string, string>()
    for (let idx = 0; idx < childIds.length; idx++) {
      const id = childIds[idx]
      const c = store.get(id)
      const call = roundChildren.get(id)
      if (!c || c.status !== 'done' || call?.summary !== true) continue
      const fullResult = (c.result ?? '').trim()
      if (!fullResult || countCodepoints(fullResult) <= REPORT_INLINE_MAX) continue
      if (!active()) return abandoned()
      const seq = idx + 1
      let turn: BackendTurnResult | null | undefined
      try {
        turn = await ctx.sendChildSummaryTurn?.(id, childSummaryPrompt())
      } catch {
        turn = null
      }
      if (!active()) return abandoned()
      const produced = turn?.ok ? (turn.response ?? '').trim() : ''
      if (produced && countCodepoints(produced) <= REPORT_INLINE_MAX) {
        summaryBodies.set(id, produced)
        note(`单 #${seq} 总结轮已产出（${countCodepoints(produced)} 字），作为回灌体`)
      } else {
        const why = produced ? '总结仍超长' : '总结轮未产出'
        summaryFallbackNotes.set(id, summaryFallbackNote(why))
        note(`单 #${seq} ${why}，回灌按全文入口指引回退`)
      }
    }

    // 汇报回灌（带单号；审核协议追加）。正文按 C 保底组装：短文原文整段回灌；长文只回
    // git 改动小节 + 全文入口指引（标 summary 的单先走总结轮，产出前置非全文标注）。
    // 任何路径不做切片、不留截断标记；全文已双落，正文不承担携带全文的职责。
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
        pointers: full ? fullTextPointerLines(full.copyPath, full.issueOk, full.seq) : [],
        summary: summaryBodies.get(id),
        summaryFallbackNote: summaryFallbackNotes.get(id)
      })
      reportEntries.push(childReportEntry(call?.to ?? c.agentId ?? c.backend, c.status, seq, body))
    }
    const report = reportEntries.join('\n\n')
    // 拒单随报告捎带：只靠「整轮零新单」兜底送达的话，领队每轮都有新单时永远收不到，
    // 会带着「该单在途」的幻觉继续排计划（iss_t_mu5t2em6_ymbllw 实测：混合轮里一单被拒，
    // 领队连着多轮评估「仍在途等回灌」，该工作项无人领）。take 即清空，兜底通道不会重复送。
    const rideAlongRejects = pendingRejections()
    let rejectNotice = ''
    if (rideAlongRejects.length) {
      note(`⚠ ${rideAlongRejects.length} 条派单被拒（未建单），原因随报告回灌给领队改派`)
      rejectNotice = buildRejectNotice(rideAlongRejects, rosterText)
    }
    note(`第 ${round} 轮结果已回灌，等待领队继续`)
    try {
      const turn = await runner.sendTurn(taskId, session, buildReportFeedback(report, rejectNotice), runId)
      if (!active()) return abandoned()
      if (!turn.ok) throw new Error(turn.error || '回灌回合失败')
      acknowledgeRejections(rideAlongRejects.length)
      runner.acknowledgeDelegateReceipts?.(taskId, runId, childIds)
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
  const leftoverRejects = pendingRejections()
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
        // 就地 merge 前置（续链互殴修复）：领队留在托管 worktree 的未提交交付先 commitAll
        // 落盘——否则干净校验直接拒掉整轮集成、任务带着空 note 静默 done。roundBaseSha 取
        // commitAll 之后的 HEAD：领队交付已成集成分支的净新增提交（finalizer headSha 观测
        // 链自洽），本轮 diff 证据以它为基线，不与队员改动混算。
        const leaderOnIntegration = baseBranch === integrationBranch
        let leaderDeliveryNote = ''
        let roundBaseSha = ''
        if (leaderOnIntegration) {
          const headBeforeDelivery = await branchHead(task.workdir, integrationBranch)
          if (!active()) return abandoned()
          const delivered = await commitAll(task.workdir, `agentdeck: 领队续链交付（${task.title}）`)
          if (!active()) return abandoned()
          roundBaseSha = await branchHead(task.workdir, integrationBranch)
          if (!active()) return abandoned()
          if (delivered && roundBaseSha && roundBaseSha !== headBeforeDelivery) {
            leaderDeliveryNote = '；领队集成 worktree 的未提交交付已先行落盘（计入本轮净新增）'
            note('领队集成 worktree 的未提交交付已先行落盘，本轮集成继续')
          }
        }
        let allOk = true
        const problems: string[] = []
        let idx = 0
        let mergedCount = 0
        for (const cid of allChildren) {
          idx++
          const c = reportedChildren.get(cid)
          if (!c || !c.workdir) continue
          // cancelled 收编单只留终局回执：用户取消的半成品不进集成分支、现场不清理
          //（恢复「cancelled 现场保持原样交人工」契约——不 merge、不 commitAll、不回收，
          // 半成品改动以未提交状态留在其 worktree，交由保留判定与人工处理）。
          if (c.status === 'cancelled') continue
          // Every child write is bound to the exact child record this pass read:
          // a child that was re-run cannot receive a stale worktree conclusion.
          const capturedChild: TaskExpectation = { ...childIdentity(c), gitOperationToken: operation.token }
          // 该子任务需要合入的分支：自己的工作分支（有改动时）+ 它作为子领队的集成分支（二层委派递归交付）
          const ownBranch = delegateChildBranch(c, taskId, idx)
          const subIntegration = await branchExists(task.workdir, `agentdeck/task-${cid}`) ? `agentdeck/task-${cid}` : ''
          if (!active()) return abandoned()
          if (!ownBranch && !subIntegration) {
            // 没有任何可集成改动，worktree 里没有值得保留的东西：直接回收（优先归池复用）
            if (!childOwnsWorktree(c)) continue
            const reclaimed = await reclaimWorktree(c.workdir, {
              repool: true,
              expectedOwnerTaskId: c.id,
              ...(c.worktree?.generationId ? { expectedGenerationId: c.worktree.generationId } : {})
            })
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
            let r = leaderOnIntegration
              ? await mergeIntoManagedWorktree(task.workdir, b!, taskId)
              : await mergeBranchInto(task.workdir, integrationBranch, b!)
            if (!active()) return abandoned()
            // 续链退路：就地合并被拒且非冲突（commitAll 后仍不干净、状态不可判等）→
            // 退回临时 worktree 通道——同分支双检出（--detach）合并后 update-ref 回指，
            // 托管副本按幻影暂存守卫对齐。冲突不走此路（abort 后留待人工/下轮改派）。
            if (!r.ok && !r.conflict && leaderOnIntegration) {
              note(`就地合并 ${b} 被拒（${r.message.slice(0, 120)}），退回临时 worktree 通道重试`)
              const viaDetach = await mergeIntoManagedWorktreeDetached(task.workdir, b!, taskId)
              if (!active()) return abandoned()
              r = viaDetach.ok ? viaDetach : { ...viaDetach, message: `${r.message}；临时 worktree 通道仍失败：${viaDetach.message}` }
            }
            // 临时 merge worktree 的 finally 清理失败不再静默：目录名+原因记上时间线
            if (r.cleanupWarning) note(`合并临时 worktree 清理失败（保留现场，待下轮清扫兜底）：${r.cleanupWarning}`)
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
          // 顺带删掉已合并的工作分支（优先归池，供下一次派单换基线秒级复用）；
          // 有失败/冲突则保留现场便于排查，留待任务删除时回收
          if (childOk && childOwnsWorktree(c)) {
            const reclaimed = await reclaimWorktree(c.workdir, {
              repool: true,
              expectedOwnerTaskId: c.id,
              ...(c.worktree?.generationId ? { expectedGenerationId: c.worktree.generationId } : {})
            })
            if (!active()) return abandoned()
            if (c.worktree) store.updateIf(cid, capturedChild, {
              worktree: {
                ...c.worktree,
                cleanupStatus: reclaimed.status,
                ...(reclaimed.reason ? { cleanupReason: reclaimed.reason } : {}),
                ...(reclaimed.ok ? { cleanedAt: Date.now() } : {})
              }
            })
            // 部分成功（目录已回收、分支/注册残留）同样浮出：residue 清单进问题汇总
            //（回合末记上时间线），不再静默 retained——残留分支会在重派时撞 already exists
            if (!reclaimed.ok && (reclaimed.status === 'failed' || reclaimed.residue?.length)) {
              childOk = false
              allOk = false
              problems.push(`worktree cleanup: ${reclaimed.reason ?? 'failed'}${reclaimed.residue?.length ? `（残留：${reclaimed.residue.join('、')}）` : ''}`)
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
          integrationNote = `改动已合入集成分支 ${integrationBranch}（基线 ${baseBranch}，${mergedCount} 个子任务${replayedFiles ? `；含领队回放基线 ${replayedFiles} 文件` : ''}${leaderDeliveryNote}），确认后可自行 merge`
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
          // 绝不静默 done：失败原因既进时间线事件，也写进常驻集成说明（note 曾留空，
          // 任务看着正常完成、集成结果却整个丢失——跨轮重试也无从判断）。
          integrationNote = `集成失败：${problems.join('; ')}（现场已保留，排查后可追问重试集成）`
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
          await reclaimWorktree(pendingFollow.path, {
            expectedOwnerTaskId: taskId,
            expectedGenerationId: pendingFollow.metadata.generationId
          })
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
