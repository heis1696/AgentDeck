// Squad 编排：领队规划 → worker 并行执行 → 领队汇总 → 集成分支
// 领队编排本身不占并发槽（否则并发=1 时死锁）；worker 走 runner 的独立 worker 槽位
import type { Task, TaskEvent } from '../shared/types'
import type { TaskStore } from './store'
import type { TaskRunner } from './runner'
import type { AgentBackend, BackendSession, BackendSessionEvents } from './backends/types'
import { isGitRepo, createWorktree, mergeBranchInto, branchDiffSummary, currentBranch, commitAll } from './git'

const PLAN_SYSTEM = `你是一个技术团队的领队（leader）。你的职责是把用户的大任务拆解成可独立并行的子任务，交给多个执行者（worker）同时完成。

输出要求（严格遵守）：
1. 只输出一个 JSON 代码块，不要输出其他任何内容
2. 格式：
\`\`\`json
{"analysis": "一句话分析","subtasks": [{"title": "子任务标题", "prompt": "给 worker 的完整指令，必须自包含（worker 看不到你的上下文）"}]}
\`\`\`
3. 子任务数量 1-{MAX}，每个都应可独立执行、互不依赖相同文件
4. 若任务很小不值得拆分，就输出 1 个子任务
5. prompt 用中文，写清楚要做什么、验收标准
6. 可选："agent" 字段指定执行队员（从下方名单里按专长选名字），不指定则由领队队员执行

可用队员名单：
{AGENTS}`

const SYNTH_SYSTEM = `你是团队领队。你的 worker 们已完成各自子任务，下面是他们的结果汇报。请输出最终综合报告（Markdown）：整体完成了什么、每个子任务的关键产出、遗留问题或建议。不要重新执行任何工具调用，只做汇总。`

/** 从模型回复里宽松提取 JSON 计划 */
export function parsePlan(text: string): { analysis?: string; subtasks: Array<{ title: string; prompt: string; agent?: string }> } | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidates: string[] = []
  if (fence) candidates.push(fence[1])
  const firstBrace = text.indexOf('{')
  const lastBrace = text.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(text.slice(firstBrace, lastBrace + 1))
  for (const c of candidates) {
    try {
      const obj = JSON.parse(c.trim())
      if (Array.isArray(obj?.subtasks) && obj.subtasks.length > 0) {
        const subs = obj.subtasks
          .filter((s: any) => typeof s?.prompt === 'string' && s.prompt.trim())
          .map((s: any) => ({
            title: String(s.title ?? '子任务').slice(0, 80),
            prompt: String(s.prompt),
            ...(typeof s.agent === 'string' && s.agent ? { agent: s.agent.slice(0, 40) } : {})
          }))
        if (subs.length) return { analysis: typeof obj.analysis === 'string' ? obj.analysis : undefined, subtasks: subs }
      }
    } catch {}
  }
  return null
}

export interface SquadRunContext {
  store: TaskStore
  runner: TaskRunner
  backends: Map<string, AgentBackend>
  /** 可用队员名单（用于异构派工） */
  getAgents: () => Array<{ id: string; name: string; backend: string; note?: string }>
  opts: () => { concurrency: number; mode: string; notify: boolean; squadMaxWorkers: number }
  pushTask: (taskId: string) => void
  pushEvent: (taskId: string, e: TaskEvent) => void
}

export class SquadRunner {
  constructor(private ctx: SquadRunContext) {}

  private note(taskId: string, text: string) {
    const { store, pushEvent } = this.ctx
    const full = store.appendEvent(taskId, { ts: Date.now(), kind: 'status', text })
    if (full) pushEvent(taskId, full)
  }

  private setPhase(taskId: string, phase: string, extra?: Record<string, unknown>) {
    const { store, pushTask } = this.ctx
    const cur = store.get(taskId)?.squad ?? { phase: 'planning', maxWorkers: 3 }
    store.update(taskId, { squad: { ...cur, phase, ...extra } as any })
    pushTask(taskId)
  }

  /** 领队回合：首回合建会话（可 resume），后续直接 send */
  private async leaderTurn(
    taskId: string,
    content: string,
    session?: BackendSession,
    resumeSessionId?: string
  ): Promise<{ session: BackendSession; response: string }> {
    const { store, runner, backends, opts, pushTask, pushEvent } = this.ctx
    const task = store.get(taskId)!
    const backend = backends.get(task.backend)!
    if (session) {
      await session.send(content)
      const finals = store.readEvents(taskId).filter((e) => e.kind === 'final')
      return { session, response: finals[finals.length - 1]?.text ?? '' }
    }
    let resolveTurn: (v: { ok: boolean; response: string; error?: string }) => void = () => {}
    const turnDone = new Promise<{ ok: boolean; response: string; error?: string }>((r) => (resolveTurn = r))
    const events: BackendSessionEvents = {
      onEvent: (e) => {
        const full = store.appendEvent(taskId, e)
        if (full) pushEvent(taskId, full)
      },
      onTurnEnd: (r) => resolveTurn(r),
      onPermission: (req) => runner.askPermission(taskId, req),
      onLaunch: (handle) => {
        runner.registerLaunch(taskId, handle)
      }
    }
    const s = await backend.start({
      prompt: content,
      workdir: task.workdir,
      mode: opts().mode,
      ...(resumeSessionId ? { resumeSessionId } : {}),
      events
    })
    store.update(taskId, { sessionId: s.sessionId })
    pushTask(taskId)
    const r = await Promise.race([
      turnDone,
      new Promise<{ ok: false; response: ''; error: '领队回合超时（10 分钟）' }>((res) =>
        setTimeout(() => res({ ok: false, response: '', error: '领队回合超时（10 分钟）' }), 10 * 60 * 1000)
      )
    ])
    if (!r.ok) throw new Error(r.error || '领队回合失败')
    return { session: s, response: r.response }
  }

  /** 完整编排（新建领队任务时） */
  async run(taskId: string): Promise<void> {
    const { store, runner, opts } = this.ctx
    const task = store.get(taskId)!
    const maxWorkers = Math.max(1, Math.min(task.squad?.maxWorkers ?? opts().squadMaxWorkers, 6))

    // ---- Phase 0 规划 ----
    const hasRepo = task.workdir ? await isGitRepo(task.workdir) : false
    this.setPhase(taskId, 'planning', { maxWorkers })
    this.note(taskId, `规划中（最多 ${maxWorkers} 个并行子任务）`)

    const planText = PLAN_SYSTEM.replace('{MAX}', String(maxWorkers)).replace(
      '{AGENTS}',
      this.ctx.getAgents()
        .filter((a) => this.ctx.backends.has(a.backend))
        .map((a) => `- ${a.name}（${a.backend}${a.note ? '，' + a.note : ''}）`)
        .join('\n') || '-（无）'
    )
    const ctxNote = hasRepo
      ? '背景：worker 们会在同一 git 仓库的隔离副本（worktree）里并行工作，尽量让子任务改动不同文件/模块以避免合并冲突。'
      : '背景：worker 们没有共享文件（调研/分析类任务），可完全并行。'
    let { session, response } = await this.leaderTurn(taskId, `${planText}\n\n${ctxNote}\n\n用户任务：${task.prompt}`)
    let plan = parsePlan(response)
    if (!plan) {
      this.note(taskId, '规划输出无法解析，重试一次')
      ;({ session, response } = await this.leaderTurn(
        taskId,
        '你上次的输出无法解析为 JSON。请重新输出，且只输出一个 ```json 代码块，不要有任何其他文字。',
        session
      ))
      plan = parsePlan(response)
    }
    if (!plan) throw new Error('领队两次规划输出都无法解析为 JSON')
    plan.subtasks = plan.subtasks.slice(0, maxWorkers)
    this.note(taskId, `规划完成：${plan.subtasks.length} 个子任务${plan.analysis ? ' — ' + plan.analysis : ''}`)

    // ---- Phase 1 派发 worker（支持领队指定队员 → 异构后端路由） ----
    this.setPhase(taskId, 'executing')
    const baseBranch = hasRepo && task.workdir ? await currentBranch(task.workdir) : ''
    const availableAgents = this.ctx.getAgents().filter((a) => this.ctx.backends.has(a.backend))
    const workerIds: string[] = []
    for (let i = 0; i < plan.subtasks.length; i++) {
      const sub = plan.subtasks
      const item = sub[i] as { title: string; prompt: string; agent?: string }
      let workdir = task.workdir
      if (hasRepo && task.workdir) {
        const wt = await createWorktree(task.workdir, `${taskId}_w${i + 1}`, baseBranch || undefined)
        if (wt) workdir = wt.path
      }
      // 领队指定的队员（名字或平台 id，忽略大小写——实测领队爱输出小写平台名）
      const want = item.agent?.toLowerCase()
      const named = want
        ? availableAgents.find((a) => a.name.toLowerCase() === want || a.backend.toLowerCase() === want)
        : undefined
      const agent = named ?? availableAgents.find((a) => a.id === task.agentId)
      const w = store.create({
        title: item.title,
        prompt: item.prompt,
        workdir,
        backend: agent?.backend ?? task.backend,
        ...(agent ? { agentId: agent.id } : {}),
        mode: 'single',
        parentTaskId: taskId,
        workerIndex: i + 1
      })
      workerIds.push(w.id)
      const who = agent ? agent.name : task.backend
      this.note(taskId, `子任务 ${i + 1}/${sub.length} → ${who}：${item.title}`)
      runner.enqueue(store.get(w.id)!)
    }

    // ---- 等待 worker 全部终态 ----
    await this.waitWorkers(taskId, workerIds)
    await this.finish(taskId, session, workerIds, baseBranch, maxWorkers)
  }

  private waitWorkers(taskId: string, workerIds: string[]): Promise<void> {
    const { store } = this.ctx
    return new Promise((resolve) => {
      const check = () => {
        const states = workerIds.map((id) => store.get(id)?.status)
        if (states.every((s) => s === 'done' || s === 'failed' || s === 'cancelled')) resolve()
        else setTimeout(check, 1500)
      }
      check()
    })
  }

  /** 汇总 + 集成 + 收尾（重启恢复时 resume 领队会话后也走这里） */
  async finish(
    taskId: string,
    session: BackendSession | undefined,
    workerIds: string[],
    baseBranch: string,
    maxWorkers: number,
    recovered = false
  ): Promise<void> {
    const { store, pushTask } = this.ctx
    const task = store.get(taskId)!
    const results = workerIds.map((id) => {
      const t = store.get(id)!
      return { title: t.title, status: t.status, result: t.result ?? '', error: t.error ?? '', gitStat: t.gitStat ?? '' }
    })
    const doneCount = results.filter((r) => r.status === 'done').length
    this.note(taskId, `子任务完成：${doneCount}/${results.length}${recovered ? '（应用重启后恢复）' : ''}`)

    // ---- Phase 2 汇总 ----
    this.setPhase(taskId, 'synthesizing')
    const summaryInput = results
      .map(
        (r, i) =>
          `## 子任务 ${i + 1}: ${r.title}（${r.status === 'done' ? '✓ 完成' : '✗ ' + r.status}）\n${r.gitStat ? '改动: ' + r.gitStat.split('\n')[0] + '\n' : ''}${r.status === 'done' ? r.result.slice(0, 4000) : '失败原因: ' + r.error.slice(0, 500)}`
      )
      .join('\n\n')
    let s = session
    if (!s) {
      // 重启恢复：resume 领队会话
      ;({ session: s } = await this.leaderTurn(taskId, `${SYNTH_SYSTEM}\n\n---\n${summaryInput}`, undefined, task.sessionId))
    } else {
      await this.leaderTurn(taskId, `${SYNTH_SYSTEM}\n\n---\n${summaryInput}`, s)
    }
    const finals = store.readEvents(taskId).filter((e) => e.kind === 'final')
    const finalReport = finals[finals.length - 1]?.text ?? ''

    // ---- Phase 3 集成 ----
    let integrationNote = ''
    let integrationBranch = ''
    let gitDiff = ''
    let gitStat = ''
    if (task.workdir && baseBranch) {
      this.setPhase(taskId, 'integrating')
      // 先把各 worker worktree 里的改动提交到其分支（worker 只改文件不提交）
      for (const wid of workerIds) {
        const wt = store.get(wid)!
        if (wt.gitStat && wt.workdir) {
          await commitAll(wt.workdir, `agentdeck: ${wt.title}`)
        }
      }
      integrationBranch = `agentdeck/squad-${taskId}`
      const branches = workerIds.map((_, i) => `agentdeck/${taskId}_w${i + 1}`)
      let allOk = true
      const problems: string[] = []
      for (let i = 0; i < branches.length; i++) {
        const wt = store.get(workerIds[i])!
        if (!wt.gitStat) continue // 无改动的 worker 跳过合并
        const r = await mergeBranchInto(task.workdir, integrationBranch, branches[i])
        if (!r.ok) {
          allOk = false
          problems.push(r.message)
          if (r.conflict) break
        }
      }
      if (allOk) {
        const sum = await branchDiffSummary(task.workdir, baseBranch, integrationBranch)
        gitDiff = sum.diff
        gitStat = sum.stat
        integrationNote = `改动已合入集成分支 ${integrationBranch}（基线 ${baseBranch}），确认后可自行 merge`
        this.note(taskId, `集成完成 → ${integrationBranch}`)
      } else {
        integrationNote = `集成未完成：${problems.join('; ')}。worker 分支：${branches.join(', ')}`
        this.note(taskId, `集成停止：${problems.join('; ')}`)
      }
    }

    try {
      await s?.close()
    } catch {}
    store.update(taskId, {
      status: 'done',
      endedAt: Date.now(),
      result: finalReport,
      gitDiff: gitDiff || undefined,
      gitStat: gitStat || undefined,
      squad: { phase: 'done', maxWorkers, ...(integrationBranch ? { integrationBranch } : {}), ...(integrationNote ? { integrationNote } : {}) }
    })
    pushTask(taskId)
  }

  /** 应用启动时恢复中断的领队任务 */
  async recover(): Promise<void> {
    const { store } = this.ctx
    const leaders = store
      .list()
      .filter((t) => t.mode === 'squad' && (t.status === 'running' || t.status === 'queued'))
    for (const leader of leaders) {
      const workers = store.list().filter((t) => t.parentTaskId === leader.id)
      const allTerminal = workers.length > 0 && workers.every((w) => ['done', 'failed', 'cancelled'].includes(w.status))
      if (allTerminal && leader.squad && leader.squad.phase !== 'planning') {
        // worker 都跑完了：恢复汇总+集成
        const baseBranch = leader.workdir ? await currentBranch(leader.workdir).catch(() => '') : ''
        store.update(leader.id, { status: 'running' })
        this.note(leader.id, '检测到应用重启，恢复汇总阶段')
        try {
          await this.finish(leader.id, undefined, workers.map((w) => w.id), baseBranch, leader.squad.maxWorkers, true)
        } catch (e) {
          store.update(leader.id, {
            status: 'failed',
            endedAt: Date.now(),
            error: `恢复失败: ${e instanceof Error ? e.message : String(e)}（子任务结果已保留）`
          })
        }
      } else {
        store.update(leader.id, {
          status: 'failed',
          endedAt: Date.now(),
          error: '应用重启导致协同中断（子任务可单独查看/重跑）'
        })
      }
    }
  }
}
