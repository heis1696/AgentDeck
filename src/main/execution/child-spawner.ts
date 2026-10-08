// 委派建单器（批次 4b）：同键建单互斥编排、派单护栏（目标解析/防环/层级/轮数预算）、
// worktree 建树与领队基线回放、dispatchHold 三步翻面、建单失败收口与只读调查建单的唯一所有者。
// 设计与迁移归属见 docs/plan/runner-decomposition.md §5.1/§6.4；TaskRunner 保留两个 smoke
// 直连的签名冻结门面（spawnDelegateChild / spawnInvestigateChild），依赖经窄端口注入
// （store 窄面 / kernel claim 校验 / note/pushTask/enqueue / 会议守卫 / taskCreator /
// getTeam / opts），绝不反向依赖 runner（§5.2）。互斥账仍归批次 4a 的 DelegateLedger
// （spawnInFlightOf/register/retire 窄面），本模块经 ports.ledger 读写。
// 逐行保持区（正文与注释一字未改，变异红测锚文按原文命中）：
//   I4.3 互斥键 = `delegate:sha256(taskId, expectedRunId, to, prompt)`，与落盘 dedupeKey 同格式；
//   I4.4 dispatchHold 三步 = 登记 holding → setWorktreeOwner 磁盘绑定 → updateIf(出生身份+holding) 翻面 → 入队前复核；
//   closeSpawnedChild 条件撤销/让位 = updateIf 落空给具名让位拒单并返回 claimed ?? null。
import type { Task, WorktreeInfo } from '../../shared/types'
import type { TaskExpectation, TaskStore } from '../store'
import { parseSparseAttr, sanitizeChildPrompt, MAX_DEPTH, MAX_TOTAL_ROUNDS, type AgentLike, type DelegateCall, type InvestigateCall } from '../delegate'
import { buildChildPrompt, sharedWorkspaceInstruction, investigationTaskPrompt } from '../prompts'
import { isOfficeTask } from '../agent-sessions'
import { probeCurrentBranch, createWorktree, setWorktreeOwner, reclaimWorktree, replayLeaderBaseline, type WorktreeSparseOutcome } from '../git'
import { runCondition, type RunClaim } from './identity'
import { gitRepositoryProbe } from './git-probe-cache'
import type { DelegateLedger } from './delegate-ledger'
import { createHash } from 'node:crypto'
import path from 'node:path'

/** Main-process task creation dependency. Kept structural to avoid coupling
 * the runner to persistence/projection implementation details. */
export interface ChildTaskCreator {
  createChildTask(input: {
    title: string
    prompt: string
    workdir: string
    backend: string
    agentId?: string
    parentTaskId: string
    dedupeKey?: string
    delegateSourceRunId?: string
    workerIndex: number
    unavailableReason?: string
    worktree?: WorktreeInfo
    dispatchHold?: boolean
    suppressIssue?: boolean
    trigger?: import('../../shared/types').RunTrigger
  }): Task
}
export type TaskCreationRequest = Parameters<ChildTaskCreator['createChildTask']>[0]
export type TaskCreator = ChildTaskCreator | ((input: TaskCreationRequest) => Task)

/**
 * 委派建单器端口：除 ledger（批次 4a 台账的窄方法面）外，每个端口都是单个动作，
 * 不暴露任何 Map（窄端口注入，非「Context 袋」，§4.2）。execution/* → runner.ts 反向
 * import 严禁；store 窄面刻意保持 `store.*` 的方法形态，搬移正文的调用点得以逐字不动。
 */
export interface ChildSpawnerPorts {
  /** 持久层窄面（六个单动作）：只读探针/条件写/全量清单/standalone 直建/工作树清扫留痕 */
  readonly store: {
    readonly get: (taskId: string) => Task | undefined
    readonly matches: (taskId: string, expected: TaskExpectation) => boolean
    readonly updateIf: (taskId: string, expected: TaskExpectation, patch: Partial<Task>) => Task | undefined
    readonly list: () => Task[]
    readonly create: (input: Parameters<TaskStore['create']>[0]) => Task
    readonly noteWorktreeCleanupFailure: (repoDir: string, failure: { name: string; reason: string; ownerTaskId?: string }) => void
  }
  /** 当前运行认领（kernel claim 校验窄口，execution-kernel.claimForRun） */
  readonly claimForRun: (taskId: string, runId?: string) => RunClaim | undefined
  /** 会议守卫（runner 编排裁决：容器改泊车、成员拒入队） */
  readonly enforceMeetingGuard: (task: Task) => boolean
  /** 时间线留痕（runner：note——状态事件落盘 + 推 UI；expected 限定归属运行） */
  readonly note: (taskId: string, text: string, expected?: TaskExpectation) => void
  /** 建单后的看板推送（runner：pushTask） */
  readonly pushTask: (taskId: string) => void
  /** 入队（runner：enqueue——会议守卫 + 推送 + 调度） */
  readonly enqueue: (task: Task) => void
  /** 队伍提供者（agent 身份与委派名单） */
  readonly getTeam: () => AgentLike[]
  /** 委派预算窄面：仅建单器消费的两项（缺省回落 MAX_DEPTH / MAX_TOTAL_ROUNDS） */
  readonly opts: () => { delegateMaxDepth?: number; delegateMaxTotalRounds?: number }
  /** 建单通道（主进程 TaskService；惰性读取——attachTaskCreator 在 runner 构造之后才挂接） */
  readonly taskCreator: () => TaskCreator | null
  /** 建单失败收口的直撤通道（runner：cancel）。搬移正文不调用它；smoke-delegate-mutation
   *  的红1/红5 把收口变异回旧代码的「直接撤销」时经 this.cancel 触达，必须真实可用。 */
  readonly cancel: (taskId: string) => Promise<unknown>
  /** 沿 parentTaskId 上溯的层级/预算/防环输入（delegate.ancestorBudget 的 store 窄口） */
  readonly ancestorBudget: (taskId: string) => { inherited: number; depth: number; ancestors: Set<string> }
  /** 委派台账（批次 4a）：同键互斥窄面 + seenKeys 登记 + 具名拒单落账 + worker 编号预留 */
  readonly ledger: DelegateLedger
}

export class ChildSpawner {
  private readonly ports: ChildSpawnerPorts
  /** 持久层窄面（构造注入）：搬移正文以 `this.store.*` 原形态调用 */
  private readonly store: ChildSpawnerPorts['store']
  /** 委派台账（批次 4a 窄方法面）：互斥登记 / seenKeys / 具名拒单 / worker 编号 */
  private readonly ledger: DelegateLedger

  constructor(ports: ChildSpawnerPorts) {
    this.ports = ports
    this.store = ports.store
    this.ledger = ports.ledger
  }

  // ---- 窄端口挂回搬移代码的原调用形态（与 runner 侧同名成员一一对应，正文逐字不动；
  // ---- smoke-delegate-mutation 红1/红5 的锚文与替换文按这些形态命中/生效）----
  private get taskCreator(): TaskCreator | null { return this.ports.taskCreator() }
  private note(taskId: string, text: string, expected: TaskExpectation = {}) { this.ports.note(taskId, text, expected) }
  private pushTask(taskId: string) { this.ports.pushTask(taskId) }
  private enqueue(task: Task) { this.ports.enqueue(task) }
  private claimForRun(taskId: string, runId?: string) { return this.ports.claimForRun(taskId, runId) }
  private getTeam(): AgentLike[] { return this.ports.getTeam() }
  private opts() { return this.ports.opts() }
  private enforceMeetingGuard(task: Task): boolean { return this.ports.enforceMeetingGuard(task) }
  private reserveWorkerIndex(taskId: string) { return this.ledger.reserveWorkerIndex(taskId) }
  private recordDelegateRejection(taskId: string, reason: string, dispatch?: { to: string; prompt: string }) { this.ledger.recordDelegateRejection(taskId, reason, dispatch) }
  /** 仅变异红测触达（红1/红5 把收口回退为旧代码的直接撤销），常态零调用 */
  private cancel(taskId: string): Promise<unknown> { return this.ports.cancel(taskId) }
  private workerCount(taskId: string) {
    return this.store.list().filter((t) => t.parentTaskId === taskId).length
  }

  /**
   * 建一个委派子任务并立即入队（委派循环与流式嗅探共用）。同键（dedupeKey）并发
   * 调用共享同一次执行：第二个调用等待复用结果（建出的同一子单，或同一次具名拒单
   * ——拒单留痕也只发生一次），绝不各自建单建树。
   * 目标解析、防环、层级闸、轮数预算闸都在互斥体内（两条建单路径同一套护栏）；
   * 回灌不在本方法（仍归委派循环回合末处理）。返回 null = 被护栏拒绝（原因已留痕事件）。
   */
  spawnDelegateChild(taskId: string, call: DelegateCall, expectedRunId = this.store.get(taskId)?.runId): Promise<Task | null> {
    const mutexKey = expectedRunId
      ? `delegate:${createHash('sha256').update(JSON.stringify([taskId, expectedRunId, call.to, call.prompt])).digest('hex')}`
      : `${taskId}\n${call.to}\n${call.prompt}`
    const inFlight = this.ledger.spawnInFlightOf(mutexKey)
    if (inFlight) return inFlight
    const execution = this.spawnDelegateChildExclusive(taskId, call, expectedRunId)
    this.ledger.registerSpawnInFlight(mutexKey, execution)
    // 结算即撤登记（后续同键调用改走既有落盘查册短路）；登记副本自身吞掉
    // rejection 防 unhandledRejection，结果仍原样返回给调用方（两条调用路径
    // 都有逐单 catch，异常语义不变）。
    void execution.finally(() => {
      this.ledger.retireSpawnInFlight(mutexKey, execution)
    }).catch(() => {})
    return execution
  }

  private async spawnDelegateChildExclusive(taskId: string, call: DelegateCall, expectedRunId: string | undefined): Promise<Task | null> {
    const task = this.store.get(taskId)
    if (!task) return null
    if (!this.enforceMeetingGuard(task)) return null
    const claim = this.claimForRun(taskId, expectedRunId)
    // Only a committed claim may drive a running parent. A parent that is not
    // running yet (queued/parked) has no Run to invalidate, so the observed
    // record is the whole condition; a running record this runner never
    // claimed is foreign and is never adopted.
    const expected: TaskExpectation = claim ? runCondition(claim) : { runId: expectedRunId }
    const active = () => claim
      ? this.store.matches(taskId, expected)
      : this.store.get(taskId)?.status !== 'running' && this.store.get(taskId)?.runId === expectedRunId
    if (!active()) return null
    const guardedNote = (text: string) => this.note(taskId, text, expected)
    const team = this.getTeam?.() ?? []
    const me = team.find((a) => a.id === task.agentId)
    const subs = (me?.subordinates ?? []).map((id) => team.find((a) => a.id === id)).filter(Boolean) as AgentLike[]
    const target =
      subs.find((a) => a.name.toLowerCase() === call.to.toLowerCase()) ??
      subs.find((a) => a.backend.toLowerCase() === call.to.toLowerCase())
    if (!target) {
      // 名单回填 + 队长提示：模型常把「可咨询的队长」当成可派单对象，说清有效名单它才改派得动
      const rosterText = subs.map((a) => `${a.name}（${a.backend}）`).join('、') || '当前为空'
      const elsewhere = team.find((a) => a.id !== me?.id && (a.name.toLowerCase() === call.to.toLowerCase() || a.backend.toLowerCase() === call.to.toLowerCase()))
      const why = elsewhere
        ? `在团队里但不是你的队员（${(elsewhere.subordinates?.length ?? 0) > 0 ? '它是队长' : '它不归你管'}；只能 <consult> 咨询，不能被派活）`
        : '不在你的队员名单里'
      guardedNote(`⚠ 未找到可驱使的队员 "${call.to}"（${why}；你的队员：${rosterText}），跳过`)
      this.recordDelegateRejection(taskId, `to="${call.to}"：${why}`, { to: call.to, prompt: call.prompt })
      return null
    }
    // 防环：目标已在祖先链上（或就是自己）→ 拒绝派发；顺带执行层级闸与全链轮数预算闸
    const { inherited, depth, ancestors } = this.ports.ancestorBudget(taskId)
    ancestors.add(me?.id ?? `@${task.backend}`)
    const targetKey = target.id || `@${target.backend}`
    if (ancestors.has(targetKey)) {
      guardedNote(`⚠ 拒绝派给 ${call.to}：它在当前委派链上（防环），请改派他人或自己做`)
      this.recordDelegateRejection(taskId, `to="${call.to}"：防环拒单，当前委派链已有该队员；不要原样重派`, { to: call.to, prompt: call.prompt })
      return null
    }
    const delegateMaxDepth = this.opts().delegateMaxDepth ?? MAX_DEPTH
    const delegateTotalRounds = this.opts().delegateMaxTotalRounds ?? MAX_TOTAL_ROUNDS
    if (depth >= delegateMaxDepth) {
      guardedNote(`⚠ 委派层级已达上限（${delegateMaxDepth} 层），拒绝派给 ${call.to}`)
      this.recordDelegateRejection(taskId, `to="${call.to}"：委派层级已达上限（${delegateMaxDepth} 层）；不要原样重派`, { to: call.to, prompt: call.prompt })
      return null
    }
    if (delegateTotalRounds - inherited <= 0) {
      guardedNote(`⚠ 全链委派轮数预算已耗尽，拒绝派给 ${call.to}`)
      this.recordDelegateRejection(taskId, `to="${call.to}"：全链委派轮数预算已耗尽；不要原样重派`, { to: call.to, prompt: call.prompt })
      return null
    }
    const dedupeKey = expectedRunId ? `delegate:${createHash('sha256').update(JSON.stringify([taskId, expectedRunId, call.to, call.prompt])).digest('hex')}` : undefined
    const alreadyCreated = dedupeKey && this.store.list().find((candidate) => candidate.dedupeKey === dedupeKey && candidate.parentTaskId === taskId)
    if (alreadyCreated) {
      // 撤键重试命中已落盘的子单（复核③）：前次建单可能在翻面之前中断（创建器落盘后抛 /
      // 归属绑定中断），子单带着 dispatchHold 停在队列外永不执行。恢复路径不再「凭 queued
      // 入队」，按最新登记三分支：
      // ① 仍 holding → 重走归属绑定+登记核实三步（磁盘 owner 绑定 → 条件翻面 → 入队前复核），
      //    全过才翻 queued 并入队；任一步失败为独立具名结果（拒单收口，不留僵尸）。
      // ② 已翻面/被并发方接手 → 让位：在跑方驱动，绝不重复入队、不回收、不撤销。
      // ③ 在跑/已终态 → 原样返回。
      let record = this.store.get(alreadyCreated.id) ?? alreadyCreated
      if (record.dispatchHold === true && record.status === 'queued' && !record.parked && record.gitOperation === undefined) {
        let bindFailure = ''
        if (record.worktree && record.worktree.ownerTaskId !== record.id) {
          // 归属交接三步（恢复路径）①磁盘绑定：setWorktreeOwner 以 false 报失败（git.ts 不抛
          // 错，try/catch 接不住）。证据整体取自任务登记（世代/出生 owner/出生分支），磁盘
          // 不做自证；绑定失败不标元数据已绑定、不记「恢复调度」成功。
          const bound = await setWorktreeOwner(record.worktree.path, record.id, record.worktree)
          if (!bound) bindFailure = 'worktree 归属绑定失败（目录缺失、注册不在案或任务侧世代/归属/分支证据不符）'
        }
        if (!bindFailure) {
          // ②登记核实+翻面：条件提交带出生身份与 holding——并发领取/变更一律落空
          const persisted = this.store.updateIf(record.id, { status: 'queued', runId: record.runId, executionOwner: record.executionOwner, dispatchHold: true }, {
            ...(record.worktree ? { worktree: { ...record.worktree, ownerTaskId: record.id } } : {}),
            dispatchHold: undefined
          })
          if (!persisted) {
            // ③落空 = 登记已被并发领取/变更：重读最新登记让位，绝不凭旧登记入队
            const latest = this.store.get(record.id)
            guardedNote(`⚠ 恢复调度让位：${record.title}（登记已被并发变更：${latest?.status ?? '已删除'}），不重复入队`)
            return latest ?? record
          }
          record = persisted
          // 入队前复核（await 期间并发翻面不双跑）：仍持翻出的登记才入队
          const queued = this.store.get(record.id)
          if (!queued || queued.dispatchHold === true || queued.status !== 'queued') {
            guardedNote(`⚠ 恢复调度让位：${record.title}（${queued ? `状态已到 ${queued.status}` : '登记已删除'}），不重复入队`)
            return queued ?? record
          }
          guardedNote(`↻ 重试命中已落盘未入队的子单，恢复调度：${record.title}`)
          this.enqueue(queued)
          return record
        }
        // 登记核实失败 = 独立具名结果：重读最新归属再收口（已被领取→让位；仍 holding→拒单回收）
        const closed = await this.closeSpawnedChild(taskId, record, call, expected, `恢复调度失败（${bindFailure}）`, taskId)
        return closed
      }
      return record
    }
    const workerIndex = this.reserveWorkerIndex(taskId)
    let workdir = task.workdir
    let unavailableReason: string | undefined
    let worktree: WorktreeInfo | undefined
    // 稀疏检出属性（docs/WORKTREE-BIG-REPO-PERF.md §6.1/§7.3）：缺省=未声明，全量行为零变化；
    // 格式非法回落全量只注记；共享工作区队员不建 worktree，sparse 无处生效同样注记——协议
    // 层错误容忍与既有约定一致：不拒单、不静默
    const sparseSpec = parseSparseAttr(call.sparse)
    if (sparseSpec.kind === 'invalid') {
      guardedNote(`⚠ sparse 属性格式非法（${sparseSpec.reason}），本单回落全量检出`)
    }
    const sparseDirs = sparseSpec.kind === 'dirs' ? sparseSpec.dirs : []
    const gitProbe = !target.sharedWorkspace && task.workdir ? await gitRepositoryProbe(task.workdir) : undefined
    if (gitProbe && !active()) return null
    if (gitProbe?.status === 'error') {
      const why = `无法确认工作区是否可安全隔离，拒绝共享工作区派单——${gitProbe.reason}`
      guardedNote(`⚠ 拒绝派给 ${call.to}：${why}`)
      this.recordDelegateRejection(taskId, `to="${call.to}"：${why}`, { to: call.to, prompt: call.prompt })
      return null
    }
    if (target.sharedWorkspace) {
      // 只读协作队员（审码/咨询类）显式声明共享工作区：零建树开销，直接用领队现场——
      // 与 meeting 调查模式同一约定；写代码的队员仍一律走隔离 worktree
      if (sparseDirs.length) guardedNote(`⚠ sparse 属性被忽略（${sparseDirs.join('、')}）：共享工作区队员不建 worktree，直接使用领队全量现场`)
      unavailableReason = 'Agent 标记共享工作区（只读协作）：直接使用领队工作区，不建 worktree'
    } else if (task.workdir && gitProbe?.status === 'repo') {
      if (!active()) return null
      // 基线分支显式传（缺省会从当前 HEAD 建——领队若中途动过分支，子任务基线会漂移）
      const branchProbe = await probeCurrentBranch(task.workdir)
      if (!active()) return null
      if (!branchProbe.ok) {
        const why = `无法确认隔离 worktree 基线，拒绝派单——${branchProbe.reason}`
        guardedNote(`⚠ 拒绝派给 ${call.to}：${why}`)
        this.recordDelegateRejection(taskId, `to="${call.to}"：${why}`, { to: call.to, prompt: call.prompt })
        return null
      }
      const base = branchProbe.branch || undefined
      if (!active()) return null
      // worktree 创建与领队/其他子任务的 git 操作可能撞 index.lock：重试两次再放弃。
      // lastWtError 只记首次失败——后续重试撞上的是首次失败留下的残肢（branch already
      // exists 等），属余波而非原因；报余波会掩盖真凶（如 Filename too long 被顶掉）
      let wt: { path: string; metadata: WorktreeInfo; sparse?: WorktreeSparseOutcome; pooled?: boolean } | null = null
      let lastWtError = ''
      const leaderDir = task.workdir
      const reclaimCancelledWorktree = async (candidate: { path: string; metadata: WorktreeInfo }, phase: string) => {
        let reason = ''
        try {
          const cleanup = await reclaimWorktree(candidate.path, { force: true, deleteBranch: true, expectedOwnerTaskId: taskId, expectedGenerationId: candidate.metadata.generationId })
          if (!cleanup.ok) reason = `回收结果 ${cleanup.status}：${cleanup.reason ?? '未知原因'}`
        } catch (error) {
          reason = `回收异常：${error instanceof Error ? error.message : String(error)}`
        }
        if (!reason) return
        const name = path.basename(candidate.path)
        const detail = `取消后${phase} worktree 回收失败（${reason}）；现场保留并已记录`
        this.store.noteWorktreeCleanupFailure(leaderDir, { name, reason: detail, ownerTaskId: taskId })
        this.note(taskId, `⚠ ${detail}`)
      }
      for (let attempt = 0; attempt < 3 && !wt; attempt++) {
        if (attempt) await new Promise((r) => setTimeout(r, 500))
        if (!active()) return null
        wt = await createWorktree(leaderDir, `${taskId}_c${workerIndex}`, base, taskId, (m) => { if (!lastWtError) lastWtError = m }, {
          // 超时残肢清理部分失败（分支/注册残留）→ owner 时间线可见，重派撞
          // already exists 时现场与原因都查得到，不再静默
          onCleanupResidue: (failure) => { this.store.noteWorktreeCleanupFailure(leaderDir, failure) },
          // 取池未命中带原因上时间线（归池可观测性）：「这次为什么没省时间」可查
          onPoolMiss: (reason) => { guardedNote(`↘ 池未命中（${reason}），走全量建树`) },
          // 稀疏检出（声明 sparse 属性时）：建树侧目录校验/设置失败自行回落全量，
          // 结果带 sparse 观测面——成功/回落都在下方落时间线注记
          ...(sparseDirs.length ? { sparseDirs } : {})
        })
        if (!active()) {
          if (wt) await reclaimCancelledWorktree(wt, '建树后')
          return null
        }
      }
      if (wt) {
        // 取池命中上时间线（归池可观测性）：秒级换基线复用，语义与全量建树无差别
        if (wt.pooled) guardedNote('↘ 取池命中：复用池内工作树换基线（秒级，未走全量建树）')
        if (wt.sparse) {
          if (wt.sparse.status === 'applied') guardedNote(`↘ 稀疏检出生效（${wt.sparse.dirs?.join('、')}），子单工作树只物化声明目录`)
          else guardedNote(`⚠ 稀疏检出回落全量：${wt.sparse.reason}；本单按全量建树继续，不拒单`)
        }
        workdir = wt.path
        worktree = wt.metadata
        // 子单基线回放（multica「工作区即状态」不变量）：领队的未提交增量此刻只存在于
        // 领队工作区，子单的隔离 worktree 看不见就等于白派单。在子 agent 拿到 cwd 之前，
        // 用私有 index 把增量采集成一个提交回放进子 worktree（不修改领队工作区与用户 index；
        // 失败后的子侧回滚需核验，拒单回收失败需留痕）。回放提交随即成为子分支起始提交（B2 防双算：digest/集成以它为基线，
        // 领队改动不算子产出）；无增量零开销跳过；采集/应用失败具名拒建单回灌原因。
        // 稀疏生效的单带范围（§6.3 回放并集）：回落全量/池化全量树整树物化，无并集必要（零变化）；
        // 池化稀疏复用（二期）结果同样带 applied 范围，并集照常生效
        const replay = await replayLeaderBaseline(task.workdir, wt.path, wt.metadata.baseSha, undefined, {
          ...(wt.sparse?.status === 'applied' && wt.sparse.dirs?.length ? { sparseDirs: wt.sparse.dirs } : {})
        })
        if (!active()) {
          await reclaimCancelledWorktree(wt, '基线回放后')
          return null
        }
        if (replay.status === 'refused') {
          let cleanupFailure: string | undefined
          try {
            const reclaimed = await reclaimWorktree(wt.path, { force: true, deleteBranch: true, expectedOwnerTaskId: taskId, expectedGenerationId: wt.metadata.generationId })
            if (!reclaimed.ok) cleanupFailure = `拒单后的 worktree 回收失败（${reclaimed.status}）：${reclaimed.reason ?? '未知原因'}`
          } catch (error) {
            cleanupFailure = `拒单后的 worktree 回收异常：${String(error)}`
          }
          if (cleanupFailure) {
            this.store.noteWorktreeCleanupFailure(leaderDir, {
              name: path.basename(wt.path),
              reason: cleanupFailure,
              ownerTaskId: taskId
            })
          }
          const refusal = `领队基线回放失败，拒建单——${replay.reason}${cleanupFailure ? `；${cleanupFailure}，现场保留并已记录` : ''}`
          guardedNote(`⚠ 拒绝派给 ${call.to}：${refusal}`)
          this.recordDelegateRejection(taskId, `to="${call.to}"：${refusal}`, { to: call.to, prompt: call.prompt })
          return null
        }
        if (replay.status === 'applied') {
          worktree = {
            ...wt.metadata,
            baseSha: replay.commitSha,
            replay: { commitSha: replay.commitSha, files: replay.files, at: Date.now() }
          }
          guardedNote(`↧ 领队未提交基线已回放进子单（${replay.files} 个文件），子单以回放提交为基线`)
        }
      } else {
        // fail-closed：建树重试 3 次仍失败不再降级共享工作区——队员会在旧基线上白写、
        // 并行队员互相踩，隔离破了等于白派单。具名拒单走既有回灌通道（报首次 git 错误，
        // 重试余波不顶替）；仅 workdir 非 git 仓库/只读共享的环境性共享降级（上方分支）保留。
        const why = `worktree 建立失败，请稍后重派${lastWtError ? `——${lastWtError}` : ''}`
        guardedNote(`⚠ 拒绝派给 ${call.to}：${why}（不降级共享工作区）`)
        this.recordDelegateRejection(taskId, `to="${call.to}"：${why}`, { to: call.to, prompt: call.prompt })
        return null
      }
    } else if (task.workdir) {
      unavailableReason = 'Workspace is not a Git worktree; using the shared workspace'
    }
    if (!active()) return null
    const childInstruction = sanitizeChildPrompt(call.prompt, task.workdir ?? '')
    const scopedInstruction = target.sharedWorkspace ? sharedWorkspaceInstruction(childInstruction) : childInstruction
    const childPrompt = buildChildPrompt(scopedInstruction, task.prompt)
    // 标题取 prompt 前 40 字——多个派单共享同一开场白时（如"每人审查两份报告"）标题会一模一样，
    // 看板上无法区分；与兄弟任务撞标题时追加序号
    const baseTitle = `${target.name}: ${call.prompt.slice(0, 40).replace(/\n/g, ' ')}`
    const siblings = this.store.list().filter((t) => t.parentTaskId === taskId)
    const title = siblings.some((s) => s.title === baseTitle) ? `${baseTitle} #${workerIndex}` : baseTitle
    // 登记 key：循环侧新建的单同样进入会话级去重（否则后续回合复述同一派单会再建）
    this.ledger.rememberSeenKey(taskId, `${call.to}\n${call.prompt}`)
    const childInput = {
      title,
      prompt: childPrompt,
      workdir,
      backend: target.backend,
      ...(target.id ? { agentId: target.id } : {}),
      parentTaskId: taskId,
      workerIndex,
      ...(dedupeKey ? { dedupeKey, delegateSourceRunId: expectedRunId } : {}),
      ...(unavailableReason ? { unavailableReason } : {}),
      ...(worktree ? { worktree } : {}),
      // 建单门禁：子单自创建起对调度器不可见（holding），归属绑定+登记核实三步全过才翻面入队
      dispatchHold: true
    }
    const child = this.taskCreator
      ? (typeof this.taskCreator === 'function' ? this.taskCreator(childInput) : this.taskCreator.createChildTask(childInput))
      : this.store.create({
        // Standalone runner smoke harnesses predate TaskService. Production
        // always attaches the creator above, so this preserves that legacy API.
        ...childInput,
        ...(task.meetingId ? { meetingId: task.meetingId, meetingTaskRole: 'investigation' as const, suppressIssue: true } : {}),
        titleAuto: true
      })
    if (worktree) {
      // 归属交接三步（原建单路径，与恢复路径同一修法）：①登记（已成立，含 holding）
      // ②磁盘归属绑定 ③登记核实+翻面。setWorktreeOwner 以 false 报失败（git.ts 不抛错，
      // try/catch 接不住）——证据整体取自建树返回的元数据（世代/出生 owner/出生分支）；
      // 绑定失败 fail-closed：重读归属后收口（仍 holding→撤销+按领队归属尽力回收+具名
      // 拒单；已被并发方接手→让位），绝不把无归属 worktree 交给队员跑。
      const bound = await setWorktreeOwner(worktree.path, child.id, worktree)
      if (!bound) {
        return this.closeSpawnedChild(taskId, child, call, expected, 'worktree 归属绑定失败', taskId)
      }
      if (!active()) {
        // 仍 holding（无人能领取）：领队归属在绑定期间丢失 → 撤销 + 按子单归属尽力回收 + 具名拒单
        return this.closeSpawnedChild(taskId, child, call, expected, '领队归属已变化', child.id)
      }
      worktree = { ...worktree, ownerTaskId: child.id }
    } else if (!active()) {
      // 无树子单同样尚在 holding：领队归属丢失 → 撤销 + 具名拒单（无现场可回收）
      return this.closeSpawnedChild(taskId, child, call, expected, '领队归属已变化', child.id)
    }
    // ③登记核实+翻面：条件提交带出生身份与 holding——并发领取/变更一律落空（不双跑）；
    // 翻面同时绑定 worktree 元数据与释放 holding（同一个原子提交，无中间可领取态）
    const persisted = this.store.updateIf(child.id, { status: 'queued', runId: child.runId, executionOwner: child.executionOwner, dispatchHold: true }, {
      ...(worktree ? { worktree } : {}),
      dispatchHold: undefined
    })
    if (!persisted) {
      // 落空 = 登记已被并发领取/变更：重读最新登记让位，绝不重复入队、不回收在用现场
      const latest = this.store.get(child.id)
      guardedNote(`⚠ 建单翻面落空（登记已被并发变更：${latest?.status ?? '已删除'}），让位交还当前登记，不重复入队`)
      return latest ?? null
    }
    if (!active()) {
      // 翻面已提交、子单已可被任意调度方领取：让位交还当前记录——不回收在用树、
      // 不 cancel、不宣称「未执行」（在跑方驱动，本回合对账按已接单处理）
      const latest = this.store.get(child.id) ?? persisted
      guardedNote(`⚠ 建单期间领队归属变化，子单「${latest.title}」让位交还当前执行`)
      return latest
    }
    // 入队前核实登记仍在（与恢复路径同规）：消失即取消派发，不盲入队
    const dispatchable = this.store.get(child.id)
    if (!dispatchable) {
      guardedNote(`⚠ 子单登记已消失，取消派发：${call.to}`)
      return null
    }
    guardedNote(`⚡ 已接单：${target.name} ← ${call.prompt.slice(0, 50).replace(/\n/g, ' ')}${call.prompt.length > 50 ? '…' : ''}`)
    this.enqueue(dispatchable)
    return child
  }

  /**
   * 建单失败收口：处置前先重读子单最新归属与状态（第五轮门禁的收口语义）。
   * 已被释放/领取（在跑）→ 让位交还当前记录：不回收在用树、不 cancel、不宣称「未执行」；
   * 仍 holding → 条件撤销（出生身份+holding 一起进条件）：撤销提交时点子单从未被任何
   * 执行方领取才成立，成立才允许 force 回收现场；撤销落空 = 重读与提交之间的跨进程窗口里
   * 刚翻面被领取 → 重读最新归属并让位，绝不回收在用树。
   * 返回 null = 已按具名拒单收口；返回 Task = 让位（调用方原样交回，由在跑方驱动）。
   */
  private async closeSpawnedChild(taskId: string, child: Task, call: DelegateCall, expected: TaskExpectation, why: string, reclaimOwnerTaskId: string): Promise<Task | null> {
    const latest = this.store.get(child.id)
    if (!latest) return null
    if (latest.dispatchHold !== true || latest.status !== 'queued') {
      this.note(taskId, `⚠ ${why}，但子单「${latest.title}」已被领取（${latest.status}）——让位交还当前执行，不撤销不回收`, expected)
      return latest
    }
    // 条件撤销：holding+出生身份一起作为撤销条件。重读（上方）与撤销提交之间隔着跨进程
    // 窗口，并发方可能恰好翻面释放门禁并派发——无条件撤销会把刚被领取的子单杀掉再回收
    // 其在用树；条件提交落空即让位（holding 子单从未起跑，无需会话/claim 清理）。
    const cancelled = this.store.updateIf(latest.id, { status: 'queued', runId: latest.runId, executionOwner: latest.executionOwner, dispatchHold: true }, { status: 'cancelled', endedAt: Date.now() })
    if (!cancelled) {
      const claimed = this.store.get(latest.id)
      this.note(taskId, `⚠ ${why}，但子单「${claimed?.title ?? latest.title}」已被领取（${claimed?.status ?? '已删除'}）——让位交还当前执行，不撤销不回收`, expected)
      return claimed ?? null
    }
    this.pushTask(latest.id)
    // 撤销成立（提交时点仍未被领取）才走到这里：force 回收现场是安全的
    let cleanup = ''
    if (latest.worktree && latest.workdir) {
      try {
        const reclaimed = await reclaimWorktree(latest.workdir, {
          force: true, deleteBranch: true, expectedOwnerTaskId: reclaimOwnerTaskId,
          ...(latest.worktree.generationId ? { expectedGenerationId: latest.worktree.generationId } : {})
        })
        if (!reclaimed.ok) cleanup = `；worktree 回收未完成（${reclaimed.status}：${reclaimed.reason ?? '未知原因'}），现场保留并已记录`
      } catch (error) {
        cleanup = `；worktree 回收异常（${error instanceof Error ? error.message : String(error)}），现场保留`
      }
      if (cleanup) {
        const leaderDir = this.store.get(taskId)?.workdir ?? ''
        if (leaderDir) {
          this.store.noteWorktreeCleanupFailure(leaderDir, { name: path.basename(latest.worktree.path), reason: `${why}后回收：${cleanup}`, ownerTaskId: taskId })
        }
      }
    }
    this.note(taskId, `⚠ 拒绝派给（${call.to}）：${why}${cleanup}，本单未执行`, expected)
    this.recordDelegateRejection(taskId, `to="${call.to}"：${why}${cleanup}，本单未执行`, { to: call.to, prompt: call.prompt })
    return null
  }

  /** Create a read-only investigation child: no worktree, no integration, no Issue. */
  async spawnInvestigateChild(taskId: string, call: InvestigateCall): Promise<Task | null> {
    const task = this.store.get(taskId)
    if (!task || task.parentTaskId) return null
    if (!this.enforceMeetingGuard(task)) return null
    // Investigation runs on behalf of one claimed Run; round accounting must not
    // be charged to a run that replaced it (or that this runner never owned).
    const claim = this.claimForRun(taskId)
    if (!claim) return null
    const expected = runCondition(claim)
    if (!this.store.matches(taskId, expected)) return null
    const team = this.getTeam?.() ?? []
    const me = team.find((agent) => agent.id === task.agentId)
    const subs = (me?.subordinates ?? []).map((id) => team.find((agent) => agent.id === id)).filter(Boolean) as AgentLike[]
    const target = subs.find((agent) => agent.name.toLowerCase() === call.to.toLowerCase())
      ?? subs.find((agent) => agent.backend.toLowerCase() === call.to.toLowerCase())
    if (!target) { this.note(taskId, `⚠ 未找到可调查队员 "${call.to}"，跳过`, expected); return null }
    const { inherited } = this.ports.ancestorBudget(taskId)
    const budget = this.opts().delegateMaxTotalRounds ?? MAX_TOTAL_ROUNDS
    if (budget - inherited <= 0) { this.note(taskId, '⚠ 全链委派轮数预算已耗尽，拒绝调查', expected); return null }
    this.store.updateIf(taskId, expected, { roundsUsed: (task.roundsUsed ?? 0) + 1 })
    const childInput = {
      title: `${target.name}: 调查 ${call.prompt.slice(0, 40).replace(/\n/g, ' ')}`,
      // 背景块：办公室会话的 task.prompt 只是会话引导（不是任务原文），附给调查员只是噪音
      prompt: buildChildPrompt(investigationTaskPrompt(call.prompt), isOfficeTask(task) ? '' : task.prompt),
      workdir: task.workdir,
      backend: target.backend,
      ...(target.id ? { agentId: target.id } : {}),
      parentTaskId: taskId,
      workerIndex: this.workerCount(taskId) + 1,
      suppressIssue: true,
      trigger: 'meeting' as const,
      unavailableReason: '调查模式：共享工作区只读，不创建 worktree'
    }
    const child = this.taskCreator
      ? (typeof this.taskCreator === 'function' ? this.taskCreator(childInput) : this.taskCreator.createChildTask(childInput))
      : this.store.create({
        ...childInput,
        ...(task.meetingId ? { meetingId: task.meetingId, meetingTaskRole: 'investigation' as const } : {})
      })
    this.note(taskId, `⚡ 已接单（调查）：${target.name} ← ${call.prompt.slice(0, 60).replace(/\n/g, ' ')}`, expected)
    this.enqueue(this.store.get(child.id)!)
    return child
  }
}
