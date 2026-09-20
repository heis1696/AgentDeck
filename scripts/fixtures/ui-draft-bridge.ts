/**
 * 集成回归用的假桥（window.agentdeck）：按真实契约的最小实现驱动真实 <App/>。
 *
 * 行为对齐主进程（这是回归的意义所在）：
 * - issues:create 同步注册任务与 Issue（tasks.get 立即可取）；
 * - 「稍后」创建只广播 issues:updated、**不广播** task:updated —— 渲染层任务列表不会自己刷新；
 * - tasks.list 的延迟与快照可按用例脚本化（制造响应乱序），事件用监听器表广播。
 *
 * 本模块必须先于渲染层模块执行（ui-draft-harness.tsx 里排第一个 import）：
 * api.ts 的 bridge 常量在模块初始化时读 window.agentdeck。
 */
import type { AgentDeckApi, AgentInfo } from '../../src/shared/contracts'
import type { Goal, Issue, Meeting, Task, TaskEvent } from '../../src/shared/types'

export interface DraftBridgeTaskSeed {
  id: string
  title: string
  parentTaskId?: string
  prompt?: string
  workdir?: string
  status?: Task['status']
}

export interface DraftIssueCreateInput {
  title: string
  description: string
  workdir: string
  startNow?: boolean
}

interface TaskListener { (task: Task): void }
interface IdListener { (id: string): void }
interface IssueListener { (payload: { taskId: string; issueId: string; issue: Issue | null; run: null }): void }

export interface DraftBridge {
  store: { tasks: Task[]; issues: Issue[]; agents: AgentInfo[] }
  calls: { list: number; get: number }
  /** tasks.list 全局延迟（ms）；listScript 优先 */
  listDelayMs: number
  /** 按调用次序脚本化的 tasks.list 响应（shift 消费；snapshot 缺省取当时 store 快照）；用尽后回退全局延迟 */
  listScript: Array<{ snapshot?: Task[]; delayMs?: number }>
  seedTask(seed: DraftBridgeTaskSeed): Task
  /** 模拟 issues:create 的主进程侧：同步注册，只广播 issues:updated */
  createDraftIssue(input: DraftIssueCreateInput): { task: Task; issue: Issue }
  fireTaskUpdated(id: string): void
  fireTaskFocus(id: string): void
  /** 同步从 store 删除并广播 task:deleted（子任务不连带，用例自己控制） */
  fireTaskDeleted(id: string): void
  reset(): void
}

let seq = 0
const nextId = (prefix: string) => `${prefix}_${++seq}`

const listeners = {
  taskUpdated: new Set<TaskListener>(),
  taskDeleted: new Set<IdListener>(),
  taskFocus: new Set<IdListener>(),
  issuesUpdated: new Set<IssueListener>()
}

const store = {
  tasks: [] as Task[],
  issues: [] as Issue[],
  agents: [
    { id: 'agent_z', name: '执行者', backend: 'zcode', color: '#3aa99f' },
    { id: 'agent_c1', name: '甲队长', backend: 'zcode', color: '#4a90d9', role: '队长' },
    { id: 'agent_c2', name: '乙队长', backend: 'zcode', color: '#b8860b', role: '队长' },
    { id: 'agent_c3', name: '丙队长', backend: 'zcode', color: '#9467bd', role: '队长' }
  ] as AgentInfo[]
}

const calls = { list: 0, get: 0 }
let listDelayMs = 0
const listScript: Array<{ snapshot?: Task[]; delayMs?: number }> = []

const emitIssue = (task: Task) => {
  const issue = store.issues.find((candidate) => candidate.taskId === task.id) ?? null
  const payload = { taskId: task.id, issueId: issue?.id ?? '', issue, run: null }
  for (const listener of listeners.issuesUpdated) listener(payload)
}

const snapshot = (override?: Task[]) => {
  if (override) return override.map((task) => ({ ...task }))
  return store.tasks.map((task) => ({ ...task }))
}

const makeTask = (seed: DraftBridgeTaskSeed): Task => ({
  id: seed.id,
  title: seed.title,
  prompt: seed.prompt ?? '',
  workdir: seed.workdir ?? '',
  backend: 'zcode',
  parentTaskId: seed.parentTaskId,
  status: seed.status ?? 'queued',
  parked: (seed.status ?? 'queued') === 'queued',
  issueId: `iss_${seed.id}`,
  trigger: 'assignment',
  createdAt: Date.now(),
  eventCount: 0
})

const makeIssue = (task: Task, input: DraftIssueCreateInput): Issue => ({
  id: `iss_${task.id}`,
  identifier: `ISS-${++seq}`,
  title: input.title,
  description: input.description,
  status: 'todo',
  priority: 'none',
  labels: [],
  position: store.issues.length,
  createdBy: 'smoke',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  taskId: task.id
})

const bridgeMock: DraftBridge = {
  store,
  calls,
  get listDelayMs() { return listDelayMs },
  set listDelayMs(value: number) { listDelayMs = value },
  listScript,
  seedTask(seed) {
    const existing = store.tasks.find((task) => task.id === seed.id)
    if (existing) return existing
    const task = makeTask(seed)
    store.tasks.push(task)
    const issue = makeIssue(task, { title: seed.title, description: seed.prompt ?? '', workdir: seed.workdir ?? '' })
    store.issues.push(issue)
    return task
  },
  createDraftIssue(input) {
    const id = nextId('t')
    const task = makeTask({ id, title: input.title, prompt: input.description, workdir: input.workdir })
    store.tasks.push(task)
    const issue = makeIssue(task, input)
    store.issues.push(issue)
    // 与主进程一致：稍后创建只广播 issues:updated，不广播 task:updated
    emitIssue(task)
    return { task, issue }
  },
  fireTaskUpdated(id) {
    const task = store.tasks.find((candidate) => candidate.id === id)
    if (!task) return
    for (const listener of listeners.taskUpdated) listener({ ...task })
  },
  fireTaskFocus(id) {
    for (const listener of listeners.taskFocus) listener(id)
  },
  fireTaskDeleted(id) {
    store.tasks = store.tasks.filter((task) => task.id !== id)
    store.issues = store.issues.filter((issue) => issue.taskId !== id)
    for (const listener of listeners.taskDeleted) listener(id)
  },
  reset() {
    store.tasks = []
    store.issues = []
    seq = 0
    calls.list = 0
    calls.get = 0
    listDelayMs = 0
    listScript.length = 0
    listeners.taskUpdated.clear()
    listeners.taskDeleted.clear()
    listeners.taskFocus.clear()
    listeners.issuesUpdated.clear()
  }
}

const subscribe = <T,>(set: Set<T>, listener: T) => {
  set.add(listener)
  return () => { set.delete(listener) }
}

const never = () => () => {}
const settle = <T,>(value: T) => Promise.resolve(value)

/** 类型面按 AgentDeckApi 对齐（未触达的方法给出空实现，触达缺失会在用例里显式暴露） */
const api = {
  worktrees: { prune: () => settle({ scanned: 0, removed: [], retained: [], failed: [] }) },
  tasks: {
    list: () => {
      calls.list++
      const scripted = listScript.shift()
      const payload = snapshot(scripted?.snapshot)
      const delay = scripted?.delayMs ?? listDelayMs
      return new Promise<Task[]>((resolve) => setTimeout(() => resolve(payload), delay))
    },
    get: (id: string) => {
      calls.get++
      return settle(store.tasks.find((task) => task.id === id) ?? null)
    },
    events: (_id: string, _afterSeq?: number): Promise<TaskEvent[]> => settle([]),
    create: settle as unknown as AgentDeckApi['tasks']['create'],
    cancel: () => settle({ ok: true }),
    followUp: () => settle({ ok: true }),
    delete: () => settle({ ok: true }),
    retry: () => settle({ ok: true }),
    move: () => settle({ ok: true }),
    start: () => settle({ ok: true }),
    rewind: () => settle({ ok: true }),
    rename: (id: string, title: string) => {
      const task = store.tasks.find((candidate) => candidate.id === id)
      if (task) task.title = title
      return settle(task ?? null)
    },
    fileDiff: () => settle({ ok: true, file: '', additions: 0, deletions: 0, diff: '', binary: false, truncated: false }),
    onEventsInvalidated: never,
    onUpdated: (listener: TaskListener) => subscribe(listeners.taskUpdated, listener),
    onDeleted: (listener: IdListener) => subscribe(listeners.taskDeleted, listener),
    onFocusTask: (listener: IdListener) => subscribe(listeners.taskFocus, listener),
    onEvent: never,
    onPermission: never,
    respondPermission: () => settle({ ok: true })
  },
  issues: {
    list: () => settle(store.issues.map((issue) => ({ ...issue }))),
    get: (id: string) => settle(store.issues.find((issue) => issue.id === id) ?? null),
    create: (input: DraftIssueCreateInput) => {
      const { task, issue } = bridgeMock.createDraftIssue(input)
      return settle(issue)
    },
    runs: () => settle([]),
    comments: () => settle([]),
    update: (id: string) => settle(store.issues.find((issue) => issue.id === id) ?? null),
    addComment: () => settle(null),
    onUpdated: (listener: IssueListener) => subscribe(listeners.issuesUpdated, listener)
  },
  goals: {
    list: (): Promise<Goal[]> => settle([]),
    get: () => settle(null),
    create: (input: { text: string; issueId: string }) => settle({
      id: nextId('goal'), text: input.text, issueId: input.issueId, status: 'draft',
      completionConditions: [], stopConditions: [], maxRuns: 1, maxDurationMs: 3_600_000,
      workdir: '', createdAt: Date.now(), updatedAt: Date.now()
    } as unknown as Goal),
    runs: () => settle([]),
    checkpoints: () => settle([]),
    snapshots: () => settle([]),
    decisions: () => settle([]),
    approveEvolution: () => settle(null),
    evolve: () => settle({ ok: true }),
    evolveStep: () => settle({ ok: true }),
    rollback: () => settle({ ok: true }),
    start: () => settle({ ok: true }),
    pause: () => settle({ ok: true }),
    resume: () => settle({ ok: true }),
    cancel: () => settle({ ok: true }),
    continue: () => settle({ ok: true }),
    checkpoint: () => settle(null),
    delete: () => settle({ ok: true }),
    onUpdated: never,
    onDeleted: never
  },
  meetings: {
    list: (): Promise<Meeting[]> => settle([]),
    get: () => settle(null),
    create: (input: { issueId: string; topic: string }) => settle({
      id: nextId('meet'), issueId: input.issueId, topic: input.topic, status: 'draft',
      participants: [], rounds: [], createdAt: Date.now()
    } as unknown as Meeting),
    start: () => settle({ ok: true }),
    pause: () => settle({ ok: true }),
    resume: () => settle({ ok: true }),
    interject: () => settle({ ok: true }),
    cancel: () => settle({ ok: true }),
    approveAction: () => settle({ ok: true }),
    delete: () => settle({ ok: true }),
    onUpdated: never,
    onDeleted: never
  },
  automations: {
    list: () => settle([]),
    create: settle as unknown as AgentDeckApi['automations']['create'],
    update: () => settle(null),
    delete: () => settle({ ok: true }),
    runNow: () => settle({ ok: true })
  },
  settings: {
    get: () => settle({ theme: 'dark' }),
    set: (patch: Record<string, unknown>) => settle({ theme: 'dark', ...patch }),
    onUpdated: never,
    probe: () => settle({ ok: true, detail: '', searched: [] })
  },
  pickDir: () => settle(''),
  openPath: () => settle(undefined),
  notify: () => undefined,
  agents: {
    list: () => settle(store.agents.map((agent) => ({ ...agent }))),
    save: (list: AgentInfo[]) => settle(list),
    models: () => settle({ backend: 'zcode', source: 'freeform', models: [] }),
    draft: settle as unknown as AgentDeckApi['agents']['draft'],
    improve: settle as unknown as AgentDeckApi['agents']['improve'],
    evaluate: settle as unknown as AgentDeckApi['agents']['evaluate'],
    importMd: settle as unknown as AgentDeckApi['agents']['importMd'],
    exportMd: settle as unknown as AgentDeckApi['agents']['exportMd']
  },
  presets: {
    list: () => settle([]),
    save: (list: never[]) => settle(list) as unknown as AgentDeckApi['presets']['save'],
    newId: () => settle('preset_new'),
    models: () => settle({ backend: 'zcode', source: 'freeform', models: [] })
  },
  runtimes: { snapshot: () => settle([]) },
  analytics: { summary: () => settle({}) },
  sidecar: { status: () => settle(null), sync: () => settle({}), reconnect: () => settle(null), onStatus: never },
  pet: {
    getState: () => settle(null),
    setEnabled: () => settle(null),
    setPack: () => settle(null),
    getPackAssets: () => settle(null),
    sendChat: () => settle(null),
    setPersona: () => settle(null),
    setAutonomy: () => settle(null),
    setPreset: () => settle(null),
    setZoom: () => settle(null),
    feed: () => settle(null),
    openSettingsWindow: () => settle(undefined),
    genStart: () => settle({ ok: true }),
    genCancel: () => settle({ ok: true }),
    windowEvent: () => undefined,
    onSay: never,
    onState: never,
    onDrag: never,
    onThrown: never,
    onPackChanged: never,
    onMenuClosed: never,
    onGenProgress: never,
    onGenDone: never,
    onGenError: never
  },
  skills: {
    list: () => settle({ root: '', skills: [] }),
    get: () => settle(null),
    save: settle as unknown as AgentDeckApi['skills']['save'],
    delete: () => settle({ ok: true }),
    import: settle as unknown as AgentDeckApi['skills']['import'],
    installFromUrl: settle as unknown as AgentDeckApi['skills']['installFromUrl'],
    searchOnline: () => settle({ entries: [], total: 0 }),
    installOnline: settle as unknown as AgentDeckApi['skills']['installOnline'],
    openExternal: () => settle(undefined),
    targets: () => settle({ targets: [], states: {} }),
    install: () => settle({ ok: true }),
    uninstall: () => settle({ ok: true }),
    openDir: () => settle(undefined)
  },
  mcp: {
    list: () => settle({ servers: [] }),
    save: settle as unknown as AgentDeckApi['mcp']['save'],
    delete: () => settle({ ok: true }),
    targets: () => settle({ targets: [], states: {} }),
    install: () => settle({ ok: true }),
    uninstall: () => settle({ ok: true })
  },
  hooks: {
    list: () => settle({ hooks: [] }),
    get: () => settle(null),
    save: settle as unknown as AgentDeckApi['hooks']['save'],
    delete: () => settle({ ok: true }),
    targets: () => settle({ targets: [], states: {} }),
    install: () => settle({ ok: true }),
    uninstall: () => settle({ ok: true })
  },
  plugins: {
    inventory: () => settle({ items: [] }),
    setEnabled: () => settle({ ok: true }),
    openDir: () => settle(undefined),
    install: settle as unknown as AgentDeckApi['plugins']['install'],
    uninstall: () => settle({ ok: true })
  },
  marketplaces: {
    status: settle as unknown as AgentDeckApi['marketplaces']['status'],
    register: settle as unknown as AgentDeckApi['marketplaces']['register'],
    listPlugins: () => settle({ plugins: [] }),
    listRegistered: () => settle({ marketplaces: [] })
  },
  sources: {
    catalog: () => settle({ entries: [] }),
    list: () => settle({ sources: [] }),
    add: settle as unknown as AgentDeckApi['sources']['add'],
    quickAdd: settle as unknown as AgentDeckApi['sources']['quickAdd'],
    remove: () => settle({ ok: true }),
    sync: settle as unknown as AgentDeckApi['sources']['sync'],
    browse: () => settle({ assets: [] }),
    listSkills: () => settle({ groups: [] }),
    importSkill: settle as unknown as AgentDeckApi['sources']['importSkill']
  },
  updates: {
    getState: settle as unknown as AgentDeckApi['updates']['getState'],
    check: settle as unknown as AgentDeckApi['updates']['getState'],
    apply: () => settle({ ok: true }),
    applyAll: () => settle({ ok: true }),
    rollback: () => settle({ ok: true }),
    onState: never
  }
} as unknown as AgentDeckApi

;(window as unknown as { agentdeck: AgentDeckApi }).agentdeck = api

export function getDraftBridge(): DraftBridge {
  return bridgeMock
}
