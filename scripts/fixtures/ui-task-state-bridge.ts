/**
 * 任务状态隔离回归的假桥（window.agentdeck）：按真实契约的最小实现驱动真实 <App/>。
 *
 * 与 ui-draft-bridge.ts 的差别在于**可控时序**：事件读取与追问发送都能挂起/延迟，
 * 用来复现「A 的异步响应晚于切任务落地」与「A 的发送还在途时切到 B」两类竞态。
 * 未实现的路径一律抛错（而不是悄悄返回空值），用例触达没铺好的桥时会立刻暴露。
 *
 * 本模块必须先于渲染层模块执行（ui-task-state-harness.tsx 里排第一个 import）：
 * api.ts 的 bridge 常量在模块初始化时读 window.agentdeck。
 */
import type { AgentDeckApi } from '../../src/shared/contracts'
import type { Goal, Issue, Meeting, Task, TaskEvent } from '../../src/shared/types'

export interface TaskStateTaskSeed {
  id: string
  title: string
  prompt?: string
  workdir?: string
  status?: Task['status']
  /** 追问区只在有会话 id 且不在排队时渲染 */
  sessionId?: string
}

export interface TaskStateBridge {
  store: { tasks: Task[]; issues: Issue[]; goals: Goal[]; meetings: Meeting[] }
  calls: {
    list: number
    /** 每次 events 读取请求的任务 id（按调用次序） */
    events: string[]
    followUp: Array<{ taskId: string; content: string; opts?: unknown }>
    rename: Array<{ taskId: string; title: string }>
  }
  /** 每个任务的 events 读取延迟（ms）：制造「旧任务的快照晚于切任务回来」 */
  eventsDelay: Map<string, number>
  /** goals.list 的响应延迟（ms）：制造「面板还拿着上一个任务的目标」的上报窗口 */
  goalsDelayMs: number
  /** issues.update 的响应延迟（ms）：制造切任务后旧 Issue 工作流响应晚到 */
  issueUpdateDelay: Map<string, number>
  /** 非空时让会议创建失败，验证失败后表单仍可重试 */
  meetingCreateError: string | null
  /** true 时追问响应挂起，等 settleFollowUps() 才结算（制造在途 busy） */
  holdFollowUps: boolean
  seedTask(seed: TaskStateTaskSeed): Task
  seedGoal(issueId: string, text: string): Goal
  setEvents(taskId: string, events: TaskEvent[]): void
  /** 主进程侧推一条实时事件 */
  fireEvent(taskId: string, event: TaskEvent): void
  /** 结算所有挂起的追问响应 */
  settleFollowUps(result?: { ok: boolean; error?: string }): void
  reset(): void
}

let seq = 0
const nextId = (prefix: string) => `${prefix}_${++seq}`

const listeners = {
  taskUpdated: new Set<(task: Task) => void>(),
  taskFocus: new Set<(id: string) => void>(),
  taskEvent: new Set<(id: string, event: TaskEvent) => void>(),
  issuesUpdated: new Set<(payload: unknown) => void>()
}

const store = {
  tasks: [] as Task[],
  issues: [] as Issue[],
  goals: [] as Goal[],
  meetings: [] as Meeting[]
}

const calls = {
  list: 0,
  events: [] as string[],
  followUp: [] as Array<{ taskId: string; content: string; opts?: unknown }>,
  rename: [] as Array<{ taskId: string; title: string }>
}

/** 任务 id → 事件列表（读取时返回副本） */
const events = new Map<string, TaskEvent[]>()
const eventsDelay = new Map<string, number>()
const issueUpdateDelay = new Map<string, number>()
const pendingFollowUps: Array<{ resolve: (value: { ok: boolean; error?: string }) => void }> = []
let holdFollowUps = false
let goalsDelayMs = 0
let meetingCreateError: string | null = null

const tasksOf = () => store.tasks

const makeTask = (seed: TaskStateTaskSeed): Task => ({
  id: seed.id,
  title: seed.title,
  prompt: seed.prompt ?? '',
  workdir: seed.workdir ?? '',
  backend: 'zcode',
  status: seed.status ?? 'done',
  parked: false,
  issueId: `iss_${seed.id}`,
  sessionId: seed.sessionId ?? `sess_${seed.id}`,
  trigger: 'assignment',
  createdAt: Date.now(),
  eventCount: 0
}) as unknown as Task

const makeIssue = (task: Task): Issue => ({
  id: `iss_${task.id}`,
  identifier: `ISS-${task.id.toUpperCase()}`,
  title: task.title,
  description: task.prompt,
  status: 'todo',
  priority: 'none',
  labels: [],
  position: store.issues.length,
  createdBy: 'smoke',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  taskId: task.id
}) as unknown as Issue

const meetingAgents = [
  { id: 'captain-1', name: '汇报队长', backend: 'zcode', color: '#64748b', role: 'captain' },
  { id: 'captain-2', name: '质疑队长', backend: 'zcode', color: '#64748b', role: 'captain' },
  { id: 'captain-3', name: '答辩队长', backend: 'zcode', color: '#64748b', role: 'captain' }
]

const bridgeMock: TaskStateBridge = {
  store,
  calls,
  eventsDelay,
  issueUpdateDelay,
  get meetingCreateError() { return meetingCreateError },
  set meetingCreateError(value) { meetingCreateError = value },
  get goalsDelayMs() { return goalsDelayMs },
  set goalsDelayMs(value: number) { goalsDelayMs = value },
  get holdFollowUps() { return holdFollowUps },
  set holdFollowUps(value: boolean) { holdFollowUps = value },
  seedTask(seed) {
    const existing = store.tasks.find((task) => task.id === seed.id)
    if (existing) return existing
    const task = makeTask(seed)
    store.tasks.push(task)
    store.issues.push(makeIssue(task))
    if (!events.has(seed.id)) events.set(seed.id, [])
    return task
  },
  seedGoal(issueId, text) {
    const goal = {
      id: nextId('goal'), issueId, text, completionConditions: [], stopConditions: [],
      maxRuns: 3, maxDurationMs: 3_600_000, status: 'active', runCount: 1, totalDurationMs: 1000,
      createdAt: Date.now(), updatedAt: Date.now()
    } as unknown as Goal
    store.goals.push(goal)
    return goal
  },
  setEvents(taskId, next) { events.set(taskId, next) },
  fireEvent(taskId, event) { for (const listener of listeners.taskEvent) listener(taskId, event) },
  settleFollowUps(result = { ok: true }) {
    while (pendingFollowUps.length) pendingFollowUps.shift()?.resolve(result)
  },
  reset() {
    store.tasks = []
    store.issues = []
    store.goals = []
    store.meetings = []
    seq = 0
    calls.list = 0
    calls.events.length = 0
    calls.followUp.length = 0
    calls.rename.length = 0
    events.clear()
    eventsDelay.clear()
    issueUpdateDelay.clear()
    pendingFollowUps.length = 0
    holdFollowUps = false
    goalsDelayMs = 0
    meetingCreateError = null
    listeners.taskUpdated.clear()
    listeners.taskFocus.clear()
    listeners.taskEvent.clear()
    listeners.issuesUpdated.clear()
  }
}

const subscribe = <T,>(set: Set<T>, listener: T) => { set.add(listener); return () => { set.delete(listener) } }
const never = () => () => {}
const settle = <T,>(value: T) => Promise.resolve(value)
/** 未铺的路径直接抛错：用例触达了假桥没实现的能力时立刻可见，而不是静默走空值 */
const missing = (path: string) => () => { throw new Error(`ui-task-state bridge 未实现：${path}`) }

const api = {
  tasks: {
    list: () => {
      calls.list++
      return settle(tasksOf().map((task) => ({ ...task })))
    },
    get: (id: string) => settle(tasksOf().find((task) => task.id === id) ?? null),
    events: (id: string) => {
      calls.events.push(id)
      const payload = (events.get(id) ?? []).map((event) => ({ ...event }))
      const delay = eventsDelay.get(id) ?? 0
      return new Promise<TaskEvent[]>((resolve) => setTimeout(() => resolve(payload), delay))
    },
    followUp: (taskId: string, content: string, opts?: unknown) => {
      calls.followUp.push({ taskId, content, opts })
      if (!holdFollowUps) return settle({ ok: true })
      return new Promise<{ ok: boolean; error?: string }>((resolve) => { pendingFollowUps.push({ resolve }) })
    },
    rename: (taskId: string, title: string) => {
      calls.rename.push({ taskId, title })
      const task = tasksOf().find((candidate) => candidate.id === taskId)
      if (task) task.title = title
      // 与主进程一致：重命名会广播 task:updated，渲染层目录据此刷新（详情页标题随之更新）
      if (task) for (const listener of listeners.taskUpdated) listener({ ...task })
      return settle(task ?? null)
    },
    cancel: () => settle({ ok: true }),
    start: () => settle({ ok: true }),
    retry: () => settle({ ok: true }),
    delete: () => settle({ ok: true }),
    move: () => settle({ ok: true }),
    rewind: () => settle({ ok: true }),
    create: missing('tasks.create'),
    fileDiff: () => settle({ ok: true, file: '', additions: 0, deletions: 0, diff: '', binary: false, truncated: false }),
    onUpdated: (listener: (task: Task) => void) => subscribe(listeners.taskUpdated, listener),
    onDeleted: never,
    onFocusTask: (listener: (id: string) => void) => subscribe(listeners.taskFocus, listener),
    onEvent: (listener: (id: string, event: TaskEvent) => void) => subscribe(listeners.taskEvent, listener),
    onEventsInvalidated: never,
    onPermission: never,
    respondPermission: () => settle({ ok: true })
  },
  issues: {
    list: () => settle(store.issues.map((issue) => ({ ...issue }))),
    get: (id: string) => settle(store.issues.find((issue) => issue.id === id) ?? null),
    runs: () => settle([]),
    comments: () => settle([]),
    update: (id: string, patch: Partial<Issue>) => {
      const issue = store.issues.find((candidate) => candidate.id === id)
      const next = issue ? { ...issue, ...patch, updatedAt: Date.now() } : null
      const delay = issueUpdateDelay.get(id) ?? 0
      return new Promise<Issue | null>((resolve) => setTimeout(() => resolve(next), delay))
    },
    addComment: () => settle(null),
    create: missing('issues.create'),
    onUpdated: (listener: (payload: unknown) => void) => subscribe(listeners.issuesUpdated, listener)
  },
  goals: {
    list: () => {
      const payload = store.goals.map((goal) => ({ ...goal }))
      return new Promise<Goal[]>((resolve) => setTimeout(() => resolve(payload), goalsDelayMs))
    },
    checkpoints: () => settle([]),
    runs: () => settle([]),
    get: () => settle(null),
    onUpdated: never,
    onDeleted: never,
    create: missing('goals.create'),
    start: () => settle({ ok: true }),
    pause: () => settle({ ok: true }),
    continue: () => settle({ ok: true }),
    cancel: () => settle({ ok: true }),
    delete: () => settle({ ok: true })
  },
  meetings: {
    list: () => settle(store.meetings.map((meeting) => ({ ...meeting }))),
    onUpdated: never,
    onDeleted: never,
    create: () => meetingCreateError
      ? Promise.reject(new Error(meetingCreateError))
      : Promise.reject(new Error('ui-task-state bridge 未实现：meetings.create')),
    get: () => settle(null)
  },
  agents: {
    list: () => settle(meetingAgents.map((agent) => ({ ...agent }))),
    models: () => settle({ backend: 'zcode', source: 'freeform', models: [] })
  },
  skills: {
    list: () => settle({ root: '', skills: [] })
  },
  settings: {
    get: () => settle({ theme: 'dark' }),
    set: (patch: Record<string, unknown>) => settle({ theme: 'dark', ...patch }),
    onUpdated: never
  },
  sidecar: { onStatus: never, status: () => settle(null) },
  pickDir: () => settle(''),
  openPath: () => settle(undefined),
  notify: () => undefined
} as unknown as AgentDeckApi

;(window as unknown as { agentdeck: AgentDeckApi }).agentdeck = api

export function getTaskStateBridge(): TaskStateBridge {
  return bridgeMock
}
