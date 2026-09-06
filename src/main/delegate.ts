// 委派协议：领队 agent 的内置能力。
// 领队系统提示告知队员名单与 <delegate> 标记语法；运行时截获标记 → 并行执行子任务 →
// 结果回灌 → 领队继续。循环直到领队不再派发。任何支持续聊的后端都适用。
import type { Task, TaskEvent } from '../shared/types'
import type { TaskStore } from './store'
import type { TaskRunner } from './runner'
import type { BackendSession, BackendTurnResult } from './backends/types'
import { isGitRepo, createWorktree, mergeBranchInto, branchDiffSummary, currentBranch, commitAll, branchExists } from './git'

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

/** 从领队回复中提取 delegate 标记（容错：任意属性顺序、md fence 内） */
export function parseDelegates(text: string): DelegateCall[] {
  const out: DelegateCall[] = []
  const re = /<delegate\b([^>]*)>([\s\S]*?)<\/delegate>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const prompt = m[2].trim()
    const to = tagAttr(m[1], 'to')
    const reason = tagAttr(m[1], 'reason')
    if (prompt && to) out.push({ to, prompt, ...(reason ? { reason } : {}) })
  }
  return out
}

/** 把 delegate 标记从对外展示文本中剥掉 */
export function stripDelegates(text: string): string {
  return text.replace(/<delegate\b[^>]*>[\s\S]*?<\/delegate>/g, '').trim()
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
  note?: string
}

/** 组装 agent 身份上下文（拼进任务首条消息——各后端通用的注入方式） */
export function buildAgentPrompt(agent: AgentLike | undefined, userPrompt: string, team: AgentLike[]): string {
  if (!agent) return userPrompt
  const parts: string[] = []
  const persona = [
    agent.role ? `你的定位：${agent.role}` : '',
    agent.systemPrompt?.trim() || ''
  ]
    .filter(Boolean)
    .join('\n')
  if (persona) parts.push(`【你的身份】\n${persona}`)
  parts.push(`【任务】\n${userPrompt}`)
  return parts.join('\n\n')
}

/** 领队的委派能力说明（拼在身份之后） */
export function buildDelegationBlock(agent: AgentLike, team: AgentLike[]): string {
  const subs = (agent.subordinates ?? [])
    .map((id) => team.find((a) => a.id === id))
    .filter((a): a is AgentLike => !!a)
  if (!subs.length) return ''
  const roster = subs
    .map((a) => `- ${a.name}（${a.backend}${a.role ? '，' + a.role : ''}${a.note ? '，' + a.note : ''}）`)
    .join('\n')
  return `【你可驱使的队员】
${roster}

【派发协议】
需要队员帮忙时，在回复中输出如下标记（可多个，会并行执行；其余正文照常写）：
<delegate to="队员名" reason="一句话说明为什么派它">完整子任务指令，必须自包含（队员看不到你的上下文）</delegate>
reason 可省略但建议带上——它会展示在执行日志里，方便人理解你的调度决策。
子任务指令中的文件一律用仓库相对路径（如 src/app.ts）——队员在仓库的隔离副本里工作，绝对路径会改错地方。
系统会并行执行并把结果汇报给你，你继续推进；可多轮派发。
判断原则：琐碎小事自己做；可并行或需要专长的才派发。全部完成时输出最终总结（不含任何 delegate 标记）。`
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

export interface DelegationContext {
  store: TaskStore
  runner: TaskRunner
  getTeam: () => AgentLike[]
  opts: () => { mode: string; notify: boolean; maxParallel: number }
  pushTask: (taskId: string) => void
  pushEvent: (taskId: string, e: TaskEvent) => void
}

export interface DelegationOutcome {
  rounds: number
  children: string[]
  finalText: string
}

const MAX_ROUNDS = 6
/** 全链共享轮数预算（二层委派：祖先已用轮数计入） */
const MAX_TOTAL_ROUNDS = 8
/** 委派层级上限（领队 → 子领队 → 队员，共 3 层） */
const MAX_DEPTH = 3

/** 沿 parentTaskId 上溯，返回祖先已用轮数总和、深度、祖先标识集（防环用） */
function ancestorBudget(store: DelegationContext['store'], taskId: string): { inherited: number; depth: number; ancestors: Set<string> } {
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
  const team = ctx.getTeam()
  const me = team.find((a) => a.id === task.agentId)
  const subs = (me?.subordinates ?? []).map((id) => team.find((a) => a.id === id)).filter(Boolean) as AgentLike[]
  if (!subs.length) return { rounds: 0, children: [], finalText: first.response }

  const note = (text: string) => {
    const e = { ts: Date.now(), kind: 'status' as const, text }
    const full = store.appendEvent(taskId, e)
    if (full) pushEvent(taskId, full)
  }

  const hasRepo = task.workdir ? await isGitRepo(task.workdir) : false
  const baseBranch = hasRepo && task.workdir ? await currentBranch(task.workdir) : ''

  // ---- 二层委派的三道闸（0.7.0）----
  const { inherited, depth, ancestors } = ancestorBudget(store, taskId)
  const bail = (why: string): DelegationOutcome => {
    note(`⚠ ${why}，本任务不再下派`)
    return { rounds: 0, children: [], finalText: stripDelegates(first.response) }
  }
  if (depth >= MAX_DEPTH) return bail(`委派层级已达上限（${MAX_DEPTH} 层）`)
  const budget = Math.min(MAX_ROUNDS, MAX_TOTAL_ROUNDS - inherited)
  if (budget <= 0) return bail('全链委派轮数预算已耗尽')
  // 自身也不许派给自己
  ancestors.add(me?.id ?? `@${task.backend}`)

  /** 标记解析用：回合文本的全部来源（终态全文/流式累计并集 + 最后一条消息） */
  let scanTexts: string[] = [first.delegationText ?? '', first.response]
  /** 结果用：每轮最后一条 assistant 消息 */
  let finalResponse = first.response
  let allChildren: string[] = []
  let round = 0

  while (round < budget) {
    const calls = parseDelegatesMerged(...scanTexts)
    if (!calls.length) break
    round++
    const batch = calls.slice(0, Math.max(1, ctx.opts().maxParallel))
    if (batch.length < calls.length) note(`⚠ 本轮仅取前 ${batch.length} 个派发（并行上限）`)

    note(`第 ${round} 轮派发：${batch.map((c) => `${c.to}${c.reason ? `（${c.reason}）` : ''}`).join('、')}`)
    const childIds: string[] = []
    for (const call of batch) {
      const target =
        subs.find((a) => a.name.toLowerCase() === call.to.toLowerCase()) ??
        subs.find((a) => a.backend.toLowerCase() === call.to.toLowerCase())
      if (!target) {
        note(`⚠ 未找到可驱使的队员 "${call.to}"（不在你的队员名单里），跳过`)
        continue
      }
      // 防环：目标已在祖先链上（或就是自己）→ 拒绝派发
      const targetKey = target.id || `@${target.backend}`
      if (ancestors.has(targetKey)) {
        note(`⚠ 拒绝派给 ${call.to}：它在当前委派链上（防环），请改派他人或自己做`)
        continue
      }
      let workdir = task.workdir
      if (hasRepo && task.workdir) {
        const wt = await createWorktree(task.workdir, `${taskId}_c${allChildren.length + childIds.length + 1}`, baseBranch || undefined)
        if (wt) workdir = wt.path
      }
      const childPrompt = sanitizeChildPrompt(call.prompt, task.workdir)
      const child = store.create({
        title: `${target.name}: ${call.prompt.slice(0, 40).replace(/\n/g, ' ')}`,
        prompt: childPrompt,
        workdir,
        backend: target.backend,
        ...(target.id ? { agentId: target.id } : {}),
        parentTaskId: taskId,
        workerIndex: allChildren.length + childIds.length + 1,
        titleAuto: true
      })
      childIds.push(child.id)
      runner.enqueue(store.get(child.id)!)
    }
    if (!childIds.length) break
    allChildren.push(...childIds)
    pushTask(taskId)

    // 等待本轮子任务全部终态
    await new Promise<void>((resolve) => {
      const check = () => {
        const states = childIds.map((id) => store.get(id)?.status)
        if (states.every((s) => s === 'done' || s === 'failed' || s === 'cancelled')) resolve()
        else setTimeout(check, 1500)
      }
      check()
    })

    // 汇报回灌
    const report = childIds
      .map((id, i) => {
        const c = store.get(id)!
        const body = c.status === 'done' ? (c.result ?? '').slice(0, 4000) : `状态 ${c.status}${c.error ? ': ' + c.error.slice(0, 300) : ''}`
        return `### 队员 ${batch[i]?.to} 的结果（${c.status}）\n${body}`
      })
      .join('\n\n')
    note(`第 ${round} 轮结果已回灌，等待领队继续`)
    try {
      const turn = await runner.sendTurn(taskId, session,
        `【系统】队员执行结果汇报：\n\n${report}\n\n请继续推进任务：需要再派发就继续用 <delegate> 标记；已全部完成就输出最终总结（不要再派发）。`
      )
      if (!turn.ok) throw new Error(turn.error || '回灌回合失败')
      scanTexts = [turn.delegationText ?? '', turn.response]
      finalResponse = turn.response
    } catch (e) {
      note(`⚠ 回灌失败: ${e instanceof Error ? e.message : String(e)}`)
      break
    }
  }

  // ---- git 集成（有仓库且产生了子任务时） ----
  let integrationNote = ''
  let integrationBranch = ''
  let gitDiff = ''
  let gitStat = ''
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
      const ownBranch = c.gitStat ? `agentdeck/${taskId}_c${idx}` : ''
      const subIntegration = await branchExists(task.workdir, `agentdeck/task-${cid}`) ? `agentdeck/task-${cid}` : ''
      if (!ownBranch && !subIntegration) continue
      if (ownBranch) await commitAll(c.workdir, `agentdeck: ${c.title}`)
      for (const b of [ownBranch, subIntegration].filter(Boolean)) {
        const r = await mergeBranchInto(task.workdir, integrationBranch, b!)
        if (!r.ok) {
          allOk = false
          problems.push(r.message)
          if (r.conflict) break
        } else {
          mergedCount++
        }
      }
      if (!allOk) break
    }
    if (allOk && mergedCount > 0) {
      const sum = await branchDiffSummary(task.workdir, baseBranch, integrationBranch)
      gitDiff = sum.diff
      gitStat = sum.stat
      integrationNote = `改动已合入集成分支 ${integrationBranch}（基线 ${baseBranch}，${mergedCount} 个子任务），确认后可自行 merge`
      note(`集成完成 → ${integrationBranch}`)
    } else if (allOk) {
      // 没有任何子任务产生可合并改动（可能都改在了主目录或无改动）
      const dirty = await import('./git').then((g) => g.snapshotGitAfter(task.workdir)).catch(() => ({ diff: '', stat: '' }))
      gitDiff = dirty.diff || ""
      gitStat = dirty.stat || ""
      integrationNote = '子任务无独立分支改动；领队若自己改了文件，改动保留在主目录工作区（未提交）'
    } else {
      integrationNote = `集成未完成：${problems.join('; ')}`
      note(`集成停止：${problems.join('; ')}`)
    }
  }

  store.update(taskId, {
    ...(integrationBranch ? { integration: { branch: integrationBranch, note: integrationNote } } : {}),
    gitDiff: gitDiff || undefined,
    gitStat: gitStat || undefined,
    roundsUsed: round
  } as Partial<Task>)
  pushTask(taskId)

  return { rounds: round, children: allChildren, finalText: stripDelegates(finalResponse || scanTexts[0] || scanTexts[1]) }
}
