// 委派协议：领队 agent 的内置能力。
// 领队系统提示告知队员名单与 <delegate> 标记语法；运行时截获标记 → 并行执行子任务 →
// 结果回灌 → 领队继续。循环直到领队不再派发。任何支持续聊的后端都适用。
import type { Task, TaskEvent } from '../shared/types'
import type { TaskStore } from './store'
import type { TaskRunner } from './runner'
import type { BackendSession } from './backends/types'
import { isGitRepo, createWorktree, mergeBranchInto, branchDiffSummary, currentBranch, commitAll } from './git'

export interface DelegateCall {
  to: string
  prompt: string
}

/** 从领队回复中提取 delegate 标记（容错：任意属性顺序、md fence 内） */
export function parseDelegates(text: string): DelegateCall[] {
  const out: DelegateCall[] = []
  const re = /<delegate\s+to\s*=\s*"([^"]+)"\s*>([\s\S]*?)<\/delegate>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const prompt = m[2].trim()
    if (prompt) out.push({ to: m[1].trim(), prompt })
  }
  return out
}

/** 把 delegate 标记从对外展示文本中剥掉 */
export function stripDelegates(text: string): string {
  return text.replace(/<delegate\s+to\s*=\s*"[^"]+"\s*>[\s\S]*?<\/delegate>/g, '').trim()
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
<delegate to="队员名">完整子任务指令，必须自包含（队员看不到你的上下文）</delegate>
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

/**
 * 委派循环：在领队回合结束后执行。
 * session 已就绪；每轮解析 delegate 标记 → 生成子任务 → 等终态 → 结果回灌 session.send。
 * 返回最终（已剥标记）文本与全部子任务 id。
 */
export async function runDelegationLoop(
  taskId: string,
  session: BackendSession,
  firstResponse: string,
  ctx: DelegationContext
): Promise<DelegationOutcome> {
  const { store, runner, pushTask, pushEvent } = ctx
  const task = store.get(taskId)!
  const team = ctx.getTeam()
  const me = team.find((a) => a.id === task.agentId)
  const subs = (me?.subordinates ?? []).map((id) => team.find((a) => a.id === id)).filter(Boolean) as AgentLike[]
  if (!subs.length) return { rounds: 0, children: [], finalText: firstResponse }

  const note = (text: string) => {
    const e = { ts: Date.now(), kind: 'status' as const, text }
    const full = store.appendEvent(taskId, e)
    if (full) pushEvent(taskId, full)
  }

  const hasRepo = task.workdir ? await isGitRepo(task.workdir) : false
  const baseBranch = hasRepo && task.workdir ? await currentBranch(task.workdir) : ''

  let response = firstResponse
  let allChildren: string[] = []
  let round = 0

  while (round < MAX_ROUNDS) {
    const calls = parseDelegates(response)
    if (!calls.length) break
    round++
    const batch = calls.slice(0, Math.max(1, ctx.opts().maxParallel))
    if (batch.length < calls.length) note(`⚠ 本轮仅取前 ${batch.length} 个派发（并行上限）`)

    note(`第 ${round} 轮派发：${batch.map((c) => c.to).join(', ')}`)
    const childIds: string[] = []
    for (const call of batch) {
      const target =
        subs.find((a) => a.name.toLowerCase() === call.to.toLowerCase()) ??
        subs.find((a) => a.backend.toLowerCase() === call.to.toLowerCase())
      if (!target) {
        note(`⚠ 未找到可驱使的队员 "${call.to}"（不在你的队员名单里），跳过`)
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
        prompt: call.prompt,
        workdir,
        backend: target.backend,
        ...(target.id ? { agentId: target.id } : {}),
        parentTaskId: taskId,
        workerIndex: allChildren.length + childIds.length + 1
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
      await session.send(
        `【系统】队员执行结果汇报：\n\n${report}\n\n请继续推进任务：需要再派发就继续用 <delegate> 标记；已全部完成就输出最终总结（不要再派发）。`
      )
      const finals = store.readEvents(taskId).filter((e) => e.kind === 'final')
      response = finals[finals.length - 1]?.text ?? ''
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
      if (!c.gitStat || !c.workdir) continue
      await commitAll(c.workdir, `agentdeck: ${c.title}`)
      const r = await mergeBranchInto(task.workdir, integrationBranch, `agentdeck/${taskId}_c${idx}`)
      if (!r.ok) {
        allOk = false
        problems.push(r.message)
        if (r.conflict) break
      } else {
        mergedCount++
      }
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
    gitStat: gitStat || undefined
  } as Partial<Task>)
  pushTask(taskId)

  return { rounds: round, children: allChildren, finalText: stripDelegates(response) }
}
