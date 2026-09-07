// 任务运行器：队列 + 生命周期 + 事件管道
// 状态机：queued → running → done | failed | cancelled
import type { Task, TaskEvent } from '../shared/types'
import type { TaskStore } from './store'
import type { AgentBackend, BackendSession, PermissionRequest, BackendTurnResult } from './backends/types'
import { snapshotGitAfter } from './git'
import { buildAgentPrompt, buildDelegationBlock, runDelegationLoop, type AgentLike } from './delegate'

/** API 预设（主进程 presets.ts 的 ApiPreset 的运行时子集，避免环依赖） */
interface PresetLike {
  id: string
  name: string
  backend: string
  baseURL: string
  apiKey: string
}
import { classifyFailure } from './failure'
import { aggregateUsage } from './usage'
import { canTransition } from '../shared/taskflow'

function getWindows(): { send: (ch: string, v: unknown) => void }[] {
  try {
    const { BrowserWindow } = require('electron') as typeof import('electron')
    return BrowserWindow.getAllWindows() as unknown as { send: (ch: string, v: unknown) => void }[]
  } catch {
    return [] // 无 GUI 环境（测试）
  }
}

/**
 * 回合空转上限：等待终态期间「没有任何事件」（文本增量/工具/状态）达到该时长才判超时。
 * 有事件即续命——真实 agent 一个回合跑十几分钟很正常，固定总时长会把还在工作的回合误杀。
 * 与一次性 CLI 后端（cli-common 10 分钟无输出看门狗）语义对齐。
 * 可用 AGENTDECK_TURN_IDLE_MS 覆盖（测试加速用）。
 */
const TURN_IDLE_TIMEOUT_MS = Number(process.env.AGENTDECK_TURN_IDLE_MS) > 0
  ? Number(process.env.AGENTDECK_TURN_IDLE_MS)
  : 10 * 60 * 1000
const turnTimeoutError = (): BackendTurnResult =>
  ({ ok: false, response: '', error: `回合超时（${Math.round(TURN_IDLE_TIMEOUT_MS / 60000)} 分钟无进展，已停止本回合）` })
/** 后端连接已死的特征：命中后丢弃内存会话、降级 resume 重建（不再需要重启应用） */
const SESSION_DEAD_RE = /连接已关闭|进程退出|EPIPE|ENOTCONN|ECONNRESET|ECONNREFUSED|disconnected/i

export class TaskRunner {
  private store: TaskStore
  private backends: Map<string, AgentBackend>
  private opts: () => { concurrency: number; mode: string; notify: boolean; workerConcurrency?: number }
  private sessions = new Map<string, BackendSession>()
  /** 启动即注册的中止句柄（一次性 CLI 在 session 返回前就要能取消） */
  private launchHandles = new Map<string, { stop: () => void }>()
  private pendingResume = new Map<string, (v: BackendTurnResult) => void>()
  private pendingPermissions = new Map<string, { taskId: string; resolve: (v: { optionId?: string; decision: 'allow' | 'deny' }) => void; timer: NodeJS.Timeout }>()
  private runningNormal = 0
  private runningWorkers = 0
  private getTeam: (() => AgentLike[]) | null = null
  private pumping = false
  /** 回合空转看门狗：等待终态期间任务有新事件即续命，长时间无进展才判超时 */
  private turnWatchdogs = new Map<string, { timer: NodeJS.Timeout; expire: () => void }>()
  /** 回合代号：防止已放弃回合的迟到终态误 resolve 新回合的等待 */
  private turnGen = new Map<string, number>()
  private readonly onTaskChanged?: (task: Task) => void

  constructor(
    store: TaskStore,
    backends: Map<string, AgentBackend>,
    opts: () => { concurrency: number; mode: string; notify: boolean; workerConcurrency?: number },
    onTaskChanged?: (task: Task) => void
  ) {
    this.store = store
    this.backends = backends
    this.opts = opts
    this.onTaskChanged = onTaskChanged
  }

  private win(): { send: (ch: string, v: unknown) => void } | null {
    return getWindows()[0] ?? null
  }

  pushTask(taskId: string) {
    const task = this.store.get(taskId)
    if (!task) return
    // Keep projections in step with every runner lifecycle transition before
    // notifying renderer consumers. The callback is optional for CLI/smoke use.
    this.onTaskChanged?.(task)
    this.win()?.send('task:updated', task)
  }
  /** 记录用户输入（首条 prompt / 追问），对话视图按 user 事件分气泡 */
  private recordUser(taskId: string, text: string) {
    const full = this.store.appendEvent(taskId, { ts: Date.now(), kind: 'user', text })
    if (full) this.pushEvent(taskId, full)
  }
  pushEvent(taskId: string, e: TaskEvent) {
    this.win()?.send('task:event', { taskId, event: e })
  }

  /** 事件管道：落盘 + 推 UI；onTurnEnd 可挂回调 */
  private makeEvents(taskId: string, onTurnEnd?: (r: BackendTurnResult) => void) {
    return {
      onEvent: (e: Omit<TaskEvent, 'seq'>) => {
        this.touchWatchdog(taskId)
        const full = this.store.appendEvent(taskId, e)
        if (full) this.pushEvent(taskId, full)
      },
      onHeartbeat: () => this.touchWatchdog(taskId),
      onTurnEnd: (r: BackendTurnResult) => {
        onTurnEnd?.(r)
        const waiter = this.pendingResume.get(taskId)
        if (waiter) {
          this.pendingResume.delete(taskId)
          waiter(r)
        }
      },
      onLaunch: (handle: { stop: () => void }) => {
        this.launchHandles.set(taskId, handle)
      },
      onPermission: (req: PermissionRequest) => this.askPermission(taskId, req)
    }
  }

  /** 权限确认：推给 UI，5 分钟无响应自动拒绝（领队/worker 共用） */
  askPermission(taskId: string, req: PermissionRequest): Promise<{ optionId?: string; decision: 'allow' | 'deny' }> {
    return new Promise((resolve) => {
      const key = String(req.requestId)
      const previous = this.pendingPermissions.get(key)
      if (previous) {
        clearTimeout(previous.timer)
        previous.resolve({ decision: 'deny' })
      }
      const timer = setTimeout(() => {
        this.pendingPermissions.delete(key)
        resolve({ decision: 'deny' })
      }, 5 * 60 * 1000)
      this.pendingPermissions.set(key, { taskId, resolve, timer })
      this.win()?.send('task:permission', { taskId, request: req })
    })
  }

  /** UI 应答权限请求 */
  resolvePermission(requestId: string, optionId: string, decision: 'allow' | 'deny') {
    const key = String(requestId)
    const p = this.pendingPermissions.get(key)
    if (!p) return { ok: false, error: '请求不存在或已超时' }
    clearTimeout(p.timer)
    this.pendingPermissions.delete(key)
    p.resolve({ optionId, decision })
    return { ok: true }
  }

  /**
   * 空转哨兵：护送一个回合的等待。到点先停掉进行中的回合（会话仍可续聊，不留
   * 僵尸 agent 继续在后台跑），再以超时错误裁决等待方。
   * 在 backend.start 之前就可武装：会话尚未建立时用启动句柄硬杀，握手挂死同样
   * 判败——否则任务会永久卡在 running 并占住并发槽，只能重启应用。
   */
  private idleSentinel(taskId: string, onFire?: () => void): { timeout: Promise<BackendTurnResult>; cancel: () => void } {
    this.disarmWatchdog(taskId)
    let fire: () => void = () => {}
    const timeout = new Promise<BackendTurnResult>((resolve) => {
      fire = () => resolve(turnTimeoutError())
    })
    const expire = () => {
      this.turnWatchdogs.delete(taskId)
      onFire?.()
      const session = this.sessions.get(taskId)
      if (session) {
        void session.stop().catch(() => {})
      } else {
        this.launchHandles.get(taskId)?.stop()
      }
      fire()
    }
    const timer = setTimeout(expire, TURN_IDLE_TIMEOUT_MS)
    this.turnWatchdogs.set(taskId, { timer, expire })
    return { timeout, cancel: () => this.disarmWatchdog(taskId) }
  }
  /** 任务有新事件（任何种类）即视为有进展：看门狗重新计时 */
  private touchWatchdog(taskId: string) {
    const w = this.turnWatchdogs.get(taskId)
    if (!w) return
    clearTimeout(w.timer)
    w.timer = setTimeout(w.expire, TURN_IDLE_TIMEOUT_MS)
  }
  private disarmWatchdog(taskId: string) {
    const w = this.turnWatchdogs.get(taskId)
    if (!w) return
    clearTimeout(w.timer)
    this.turnWatchdogs.delete(taskId)
  }
  private bumpTurnGen(taskId: string) {
    const gen = (this.turnGen.get(taskId) ?? 0) + 1
    this.turnGen.set(taskId, gen)
    return gen
  }

  /** 关闭并移除内存会话（容错）：防止放弃的会话继续在后台跑、往任务日志里交错写事件 */
  closeSession(taskId: string) {
    const s = this.sessions.get(taskId)
    if (!s) return
    this.sessions.delete(taskId)
    void s.close().catch(() => {})
  }

  /** 回合成功后的收尾：取最终结果 + git 快照 + 用量聚合 + 状态落盘 */
  private async finalizeDone(taskId: string, directResult?: string) {
    const task = this.store.get(taskId)
    if (!task) return
    if (task.status !== 'running') return
    let result = directResult
    const events = this.store.readEvents(taskId)
    if (result === undefined) {
      const finals = events.filter((e) => e.kind === 'final')
      result = finals[finals.length - 1]?.text ?? ''
    }
    const { diff, stat } = await snapshotGitAfter(task.workdir)
    const current = this.store.get(taskId)
    if (!current || !canTransition(current.status, 'done', 'runner')) {
      if (current) this.store.update(taskId, { result, gitDiff: diff || current.gitDiff, gitStat: stat || current.gitStat, usage: aggregateUsage(events) })
      this.pushTask(taskId)
      return
    }
    this.store.update(taskId, {
      status: 'done',
      endedAt: Date.now(),
      result,
      gitDiff: diff || task.gitDiff,
      gitStat: stat || task.gitStat,
      usage: aggregateUsage(events)
    })
    this.pushTask(taskId)
  }

  /** 失败落库：原始错误 + 分类解读（P1） */
  private failTask(taskId: string, error: string) {
    const task = this.store.get(taskId)
    if (!task || !canTransition(task.status, 'failed', 'runner')) return
    this.store.update(taskId, { status: 'failed', endedAt: Date.now(), error, failure: classifyFailure({ error }) })
    this.pushTask(taskId)
  }

  enqueue(task: Task) {
    this.pushTask(task.id)
    this.pump()
  }

  /** 双通道：普通任务受 concurrency 限制；委派子任务受 workerConcurrency 限制（否则领队会占槽死锁） */
  private pump() {
    if (this.pumping) return
    this.pumping = true
    try {
      const { concurrency, workerConcurrency } = this.opts()
      const queued = this.store
        .list()
        .filter((t) => t.status === 'queued' && !t.parked)
        .sort((a, b) => a.createdAt - b.createdAt)
      const normal = queued.filter((t) => !t.parentTaskId)
      const workers = queued.filter((t) => t.parentTaskId)
      while (this.runningNormal < Math.max(1, concurrency) && normal.length) {
        const next = normal.shift()!
        void this.run(next.id)
      }
      while (this.runningWorkers < Math.max(1, workerConcurrency ?? concurrency) && workers.length) {
        const next = workers.shift()!
        void this.run(next.id)
      }
    } finally {
      this.pumping = false
    }
  }

  /** 队伍提供者（agent 身份与委派名单） */
  attachTeam(getTeam: () => AgentLike[]) {
    this.getTeam = getTeam
  }

  private getPresets: (() => PresetLike[]) | null = null
  /** API 预设提供者（agent 引用的连接覆盖） */
  attachPresets(getPresets: () => PresetLike[]) {
    this.getPresets = getPresets
  }

  /** agent 引用的 API 预设 → 会话连接覆盖（预设 + 模型须同时具备） */
  private resolveConnection(agentId?: string) {
    const me = (this.getTeam?.() ?? []).find((a) => a.id === agentId)
    const preset = me?.presetId ? this.getPresets?.().find((p) => p.id === me.presetId) : undefined
    return me?.model && preset ? { name: preset.name, baseURL: preset.baseURL, apiKey: preset.apiKey } : undefined
  }

  private newRunId(taskId: string) {
    return `run_${taskId}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
  }

  /** Finish one successful turn, including any delegation emitted before the final message. */
  private async completeTurn(taskId: string, session: BackendSession, r: BackendTurnResult): Promise<string> {
    const task = this.store.get(taskId)!
    const team = this.getTeam?.() ?? []
    const me = team.find((a) => a.id === task.agentId)
    let finalText = r.response
    if (me?.subordinates?.length && task.backend !== 'dsh') {
      const outcome = await runDelegationLoop(taskId, session, r, {
        store: this.store,
        runner: this,
        getTeam: () => this.getTeam?.() ?? [],
        opts: () => ({ mode: this.opts().mode, notify: this.opts().notify, maxParallel: Math.max(1, this.opts().workerConcurrency ?? this.opts().concurrency) }),
        pushTask: (id) => this.pushTask(id),
        pushEvent: (id, e) => this.pushEvent(id, e)
      })
      finalText = outcome.finalText || r.response
    }
    await this.finalizeDone(taskId, finalText)
    return finalText
  }

  /**
   * 隐藏回合：让 agent 根据执行内容重起一个简短标题。
   * 调用方需先把事件管道切到静默（titleMode），失败静默返回 false，不影响任务本体。
   */
  private async retitleByAgent(taskId: string, session: BackendSession): Promise<boolean> {
    try {
      const r = await this.sendTurn(
        taskId,
        session,
        '【系统】请根据这次任务的执行内容，用不超过 24 个字重起一个简短标题（概括做了什么，不要复述指令原文）。只输出标题本身：不要编号、引号、书名号或任何解释。'
      )
      if (!r.ok) return false
      const line = r.response
        .split(/\r?\n/)
        .map((s) => s.replace(/^[#>*\-\s]+/, '').replace(/["'「」《》`*]/g, '').trim())
        .find((s) => s.length > 0)
      if (!line) return false
      this.store.update(taskId, { title: line.slice(0, 60), titleAuto: false })
      return true
    } catch {
      return false
    }
  }

  /**
   * Send one follow-up and return the exact turn payload, including prior messages.
   * 等待全程由空转看门狗护送：有事件就续命；真超时时先停回合再返回错误，
   * 后端不会留一个还在跑的僵尸回合跟下一次操作抢会话。
   */
  async sendTurn(taskId: string, session: BackendSession, content: string): Promise<BackendTurnResult> {
    const gen = this.bumpTurnGen(taskId)
    let settleTurn: (v: BackendTurnResult) => void = () => {}
    const turn = new Promise<BackendTurnResult>((resolve) => {
      settleTurn = resolve
      this.pendingResume.set(taskId, (v) => {
        if ((this.turnGen.get(taskId) ?? 0) !== gen) return // 已放弃回合的迟到终态：丢弃，不污染新回合
        resolve(v)
      })
    })
    let idleFired = false
    const { timeout, cancel } = this.idleSentinel(taskId, () => { idleFired = true })
    try {
      // send 不阻塞裁决：立即失败（连接已死等）要马上浮出，不能干等空转上限；
      // 看门狗触发的 stop 会让 send 以 reject 收尾，统一按超时语义上报
      void session.send(content).catch((e) => {
        settleTurn(idleFired ? turnTimeoutError() : { ok: false, response: '', error: e instanceof Error ? e.message : String(e) })
      })
      return await Promise.race([turn, timeout])
    } finally {
      cancel()
      this.pendingResume.delete(taskId)
    }
  }

  /** 执行一个任务（首回合） */
  private async run(taskId: string) {
    const task = this.store.get(taskId)
    if (!task || task.status !== 'queued') return
    const backend = this.backends.get(task.backend)
    if (!backend) {
      this.failTask(taskId, `未知后端: ${task.backend}`)
      this.pushTask(taskId)
      return
    }
    const isWorker = !!task.parentTaskId
    if (isWorker) this.runningWorkers++
    else this.runningNormal++
    this.store.update(taskId, { status: 'running', startedAt: Date.now(), runId: this.newRunId(taskId), error: undefined, failure: undefined })
    this.pushTask(taskId)
    this.recordUser(taskId, task.prompt)

    // 首回合完成信号
    let firstTurnDone: ((v: BackendTurnResult) => void) | null = null
    const firstTurnPromise = new Promise<BackendTurnResult>((resolve) => {
      firstTurnDone = resolve
    })

    // agent 身份注入：人设 + （领队时）委派协议
    const team = this.getTeam?.() ?? []
    const me = team.find((a) => a.id === task.agentId)
    let prompt = buildAgentPrompt(me, task.prompt, team)
    if (task.handoff) {
      prompt = `${prompt}

【交接备注（本次执行重点，来自用户）】
${task.handoff}`
    }
    if (me?.subordinates?.length && task.backend !== 'dsh') {
      const block = buildDelegationBlock(me, team)
      if (block) prompt = `${prompt}\n\n${block}`
    }

    // 看门狗在 backend.start 之前武装：握手/建会话阶段挂死同样按空转判败并可硬杀，
    // 不再永久卡住 running 状态与并发槽；启动期间的线级心跳照常续命
    const sentinel = this.idleSentinel(taskId)
    try {
      // 标题回合的事件不进对话流（text/final/usage 静默），onTurnEnd 照常驱动 sendTurn
      let titleMode = false
      const baseEvents = this.makeEvents(taskId, (r) => firstTurnDone?.(r))
      const session = await Promise.race([
        backend.start({
          prompt,
          workdir: task.workdir,
          mode: this.opts().mode,
          model: me?.model,
          connection: this.resolveConnection(task.agentId),
          events: {
            ...baseEvents,
            onEvent: (e) => {
              this.touchWatchdog(taskId) // 静默事件（标题回合增量）不进日志，但同样是进展信号
              if (titleMode && e.kind !== 'error') return
              baseEvents.onEvent(e)
            }
          }
        }).then((s) => ({ session: s })),
        sentinel.timeout.then((r) => ({ timeout: r }))
      ]).then((outcome) => {
        if ('timeout' in outcome) throw new Error(outcome.timeout.error)
        return outcome.session
      })
      this.sessions.set(taskId, session)
      this.store.update(taskId, { sessionId: session.sessionId })
      this.pushTask(taskId)

      // 首回合由同一哨兵继续护送：长时间无任何进展先停回合再判失败，不再无限等待
      let r: BackendTurnResult
      try {
        r = await Promise.race([firstTurnPromise, sentinel.timeout])
      } finally {
        sentinel.cancel()
      }
      if (r.ok) {
        // 自动派生标题的任务：让 agent 总结重起标题（隐藏回合；worker/dsh 除外——前者会与回灌争用会话，后者不支持续聊）
        if (task.titleAuto && !task.parentTaskId && task.backend !== 'dsh') {
          titleMode = true
          const titled = await this.retitleByAgent(taskId, session)
          titleMode = false
          if (titled) this.pushTask(taskId)
        }
        // 领队：进入委派循环（截获 <delegate> 标记 → 并行子任务 → 回灌 → 继续）
        // 0.7.0 起 worker 也可以是子领队（带 subordinates 即生效；delegate 内有防环与层级/预算闸）
        const finalText = await this.completeTurn(taskId, session, r)
        if (this.opts().notify) this.notify(task, '完成', finalText)
      } else {
        this.closeSession(taskId)
        this.failTask(taskId, r.error || '回合失败')
        this.maybeAutoRetry(taskId)
        if (this.opts().notify) this.notify(task, '失败', r.error || '')
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.closeSession(taskId)
      this.failTask(taskId, msg)
      this.maybeAutoRetry(taskId)
      if (this.opts().notify) this.notify(task, '失败', msg)
    } finally {
      sentinel.cancel()
      this.store.flushEvents(taskId)
      this.launchHandles.delete(taskId)
      this.pushTask(taskId)
      if (isWorker) this.runningWorkers--
      else this.runningNormal--
      this.pump()
    }
  }

  /**
   * 自动重试（P4）：仅 retryable 的瞬态失败（限流/超时/进程崩溃/沙箱），上限 2 次。
   * 第 1 次优先带会话续跑（同后端可 resume）；第 2 次强制新会话（会话可能已被污染）。
   * 手动"重新运行"不受此影响（恒新会话、attempt 清零）。
   */
  private maybeAutoRetry(taskId: string) {
    const task = this.store.get(taskId)
    if (!task || task.status !== 'failed') return
    const attempt = task.attempt ?? 0
    if (attempt >= 2) return
    const failure = task.failure
    if (!failure?.retryable) return
    const next = attempt + 1
    const fresh = next >= 2 || !task.sessionId || task.backend === 'dsh'
    this.store.update(taskId, {
      status: 'queued',
      endedAt: undefined,
      runId: undefined,
      attempt: next,
      ...(fresh ? { sessionId: undefined } : {})
    })
    const full = this.store.appendEvent(taskId, {
      ts: Date.now(),
      kind: 'status',
      text: `⟳ 自动重试 ${next}/2（${failure.title}）${fresh ? '· 新会话' : '· 续会话'}`
    })
    if (full) this.pushEvent(taskId, full)
    this.pushTask(taskId)
    this.enqueue(this.store.get(taskId)!)
  }

  private notify(task: Task, what: string, body: string) {
    if (!this.opts().notify) return
    try {
      const { Notification, BrowserWindow } = require('electron') as typeof import('electron')
      if (Notification.isSupported()) {
        const n = new Notification({
          title: `任务${what}: ${task.title}`,
          body: (body || '').slice(0, 180)
        })
        n.on('click', () => {
          // 后台时点击系统通知：先唤起窗口再聚焦任务
          const w = BrowserWindow.getAllWindows()[0]
          if (w) {
            w.show()
            w.focus()
          }
          this.win()?.send('task:focus', task.id)
        })
        n.show()
      }
    } catch {}
  }

  /** 续聊：在已完成任务的会话上追加消息，任务回到 running */
  async followUp(taskId: string, content: string): Promise<{ ok: boolean; error?: string }> {
    const task = this.store.get(taskId)
    if (!task) return { ok: false, error: '任务不存在' }
    const message = content.trim()
    if (!message) return { ok: false, error: '追问不能为空' }
    if (task.status === 'running') return { ok: false, error: '任务正在运行' }
    if (task.status !== 'done' && task.status !== 'failed') return { ok: false, error: '任务尚未完成' }
    const backend = this.backends.get(task.backend)
    if (!backend) return { ok: false, error: '后端不可用' }
    if (!this.sessions.get(taskId) && !task.sessionId) return { ok: false, error: '无会话可恢复' }
    this.recordUser(taskId, message)

    const beginRun = () => {
      this.store.update(taskId, { status: 'running', startedAt: Date.now(), runId: this.newRunId(taskId), endedAt: undefined, error: undefined, failure: undefined })
      this.pushTask(taskId)
    }

    // 1) 内存会话健在：直接续聊
    let liveSession = this.sessions.get(taskId)
    if (liveSession) {
      beginRun()
      try {
        const r = await this.sendTurn(taskId, liveSession, message)
        if (!r.ok) throw new Error(r.error || '续聊回合失败')
        const finalText = await this.completeTurn(taskId, liveSession, r)
        if (this.opts().notify) this.notify(task, '完成', finalText)
        return { ok: true }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (!SESSION_DEAD_RE.test(msg)) {
          this.failTask(taskId, msg)
          this.pushTask(taskId)
          return { ok: false, error: msg }
        }
        // 后端连接已死（进程退出/管道断开）：丢弃内存会话，走下面的 resume 重建——
        // 以前这种情况只能重启应用，现在等价于把重启后的恢复路径内置
        this.closeSession(taskId)
        liveSession = undefined
      }
    }

    // 2) resume 路径：内存会话丢失（应用重启/连接死亡）时按 sessionId 重建
    if (!task.sessionId) {
      const msg = '无会话可恢复'
      this.failTask(taskId, msg)
      this.pushTask(taskId)
      return { ok: false, error: msg }
    }
    beginRun()
    // 续聊沿用 agent 钉死的模型（zcode resume 每次重传 runtimeModel；CLI --model 与 --resume 正交）
    const me = (this.getTeam?.() ?? []).find((a) => a.id === task.agentId)
    let resumeSession: BackendSession
    // 看门狗在 backend.start 之前武装：resume 重建阶段挂死同样按空转判败，
    // 不永久卡住 running 状态（此前只能重启应用）
    const sentinel = this.idleSentinel(taskId)
    try {
      const gen = this.bumpTurnGen(taskId)
      const turn = new Promise<BackendTurnResult>((resolve) => {
        this.pendingResume.set(taskId, (v) => {
          if ((this.turnGen.get(taskId) ?? 0) !== gen) return
          resolve(v)
        })
      })
      resumeSession = await Promise.race([
        backend.start({
          prompt: message,
          workdir: task.workdir,
          mode: this.opts().mode,
          model: me?.model,
          connection: this.resolveConnection(task.agentId),
          resumeSessionId: task.sessionId,
          events: this.makeEvents(taskId)
        }).then((s) => ({ session: s })),
        sentinel.timeout.then((r) => ({ timeout: r }))
      ]).then((outcome) => {
        if ('timeout' in outcome) throw new Error(outcome.timeout.error)
        return outcome.session
      })
      this.sessions.set(taskId, resumeSession)
      this.store.update(taskId, { sessionId: resumeSession.sessionId })
      this.pushTask(taskId)
      try {
        const r = await Promise.race([turn, sentinel.timeout])
        if (!r.ok) throw new Error(r.error || '续聊回合失败')
        const finalText = await this.completeTurn(taskId, resumeSession, r)
        if (this.opts().notify) this.notify(task, '完成', finalText)
        return { ok: true }
      } finally {
        sentinel.cancel()
        this.pendingResume.delete(taskId)
      }
    } catch (e) {
      this.pendingResume.delete(taskId)
      this.disarmWatchdog(taskId)
      const msg = e instanceof Error ? e.message : String(e)
      this.failTask(taskId, msg)
      this.pushTask(taskId)
      return { ok: false, error: msg }
    }
  }

  async cancel(taskId: string): Promise<{ ok: boolean; error?: string }> {
    const task = this.store.get(taskId)
    if (!task) return { ok: false, error: '任务不存在' }
    if (task.status === 'queued') {
      this.store.update(taskId, { status: 'cancelled', endedAt: Date.now() })
      this.pushTask(taskId)
      return { ok: true }
    }
    if (task.status !== 'running') return { ok: false, error: '任务不在运行中' }
    const session = this.sessions.get(taskId)
    this.store.update(taskId, { status: 'cancelled', endedAt: Date.now() })
    this.pushTask(taskId)
    // 级联取消子任务（领队被取消时，运行中/排队的子任务一并停）
    for (const child of this.store.list().filter((t) => t.parentTaskId === taskId && (t.status === 'running' || t.status === 'queued'))) {
      void this.cancel(child.id)
    }
    // 先用启动句柄硬停（一次性 CLI 的 session 可能还没返回）
    this.launchHandles.get(taskId)?.stop()
    this.launchHandles.delete(taskId)
    try {
      await session?.stop()
    } catch {}
    try {
      await session?.close()
    } catch {}
    this.sessions.delete(taskId)
    for (const [key, pending] of this.pendingPermissions) {
      if (pending.taskId !== taskId) continue
      clearTimeout(pending.timer)
      pending.resolve({ decision: 'deny' })
      this.pendingPermissions.delete(key)
    }
    this.disarmWatchdog(taskId)
    this.store.flushEvents(taskId)
    return { ok: true }
  }

  async shutdown() {
    for (const [, s] of this.sessions) {
      try {
        await s.close()
      } catch {}
    }
    this.sessions.clear()
    for (const [key, pending] of this.pendingPermissions) {
      clearTimeout(pending.timer)
      pending.resolve({ decision: 'deny' })
      this.pendingPermissions.delete(key)
    }
  }

  sessionCount() {
    return this.sessions.size
  }
}
