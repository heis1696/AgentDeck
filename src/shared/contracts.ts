import type { Automation, AppSettings, AnalyticsSummary, Comment, Goal, GoalCheckpoint, GoalRun, Issue, IssuePriority, IssueStatus, Notification, Run, RunTrigger, RuntimeSnapshot, Task, TaskEvent } from './types'
import type { SkillDetail, SkillMeta, SkillTarget, SyncState } from './skills'

export interface PermissionRequest {
  requestId: string | number
  toolName: string
  reason: string
  riskLevel: string
  input?: unknown
  options: Array<{ optionId: string; name: string; description?: string; response: { decision: string } }>
}

export interface AgentInfo {
  id: string
  name: string
  backend: string
  model?: string
  presetId?: string
  note?: string
  color: string
  role?: string
  systemPrompt?: string
  subordinates?: string[]
}

export interface AgentModelCatalog {
  backend: string
  source: 'catalog' | 'freeform'
  default?: string
  models: string[]
}

export interface PresetInfo {
  id: string
  name: string
  backend: string
  baseURL: string
  apiKey: string
  note?: string
  createdAt: number
}

export interface TaskCreateInput {
  title: string
  prompt: string
  workdir: string
  backend?: string
  agentId?: string
  handoff?: string
  startNow?: boolean
  trigger?: RunTrigger
}

export interface IssueCreateInput {
  title: string
  description: string
  workdir: string
  agentId?: string
  backend?: string
  handoff?: string
  startNow?: boolean
  trigger?: RunTrigger
  titleAuto?: boolean
}

export interface IssueUpdatePatch {
  priority?: IssuePriority
  labels?: string[]
  dueDate?: number
  status?: IssueStatus
}

export interface GoalCreateInput {
  text: string
  /** 目标必须归属一个真实 Issue；循环在该 Issue 内自动推进（v2）。 */
  issueId: string
  completionConditions: string[]
  stopConditions: string[]
  maxRuns: number
  maxDurationMs: number
  workdir: string
  agentId?: string
  backend?: string
  startNow?: boolean
}

export interface GoalCheckpointInput {
  summary: string
  completedConditions: string[]
  incompleteConditions: string[]
  nextPlan: string
  blockers: string[]
}

export interface IpcResult {
  ok: boolean
  error?: string
}

export interface AgentDeckApi {
  tasks: {
    list: () => Promise<Task[]>
    get: (id: string) => Promise<Task | null>
    events: (id: string, afterSeq?: number) => Promise<TaskEvent[]>
    create: (input: TaskCreateInput) => Promise<Task>
    cancel: (id: string) => Promise<IpcResult>
    followUp: (id: string, content: string, opts?: { relay?: boolean }) => Promise<IpcResult>
    delete: (id: string) => Promise<IpcResult>
    retry: (id: string) => Promise<IpcResult>
    move: (id: string, status: Task['status']) => Promise<IpcResult>
    start: (id: string) => Promise<IpcResult>
    rewind: (id: string, toSeq: number) => Promise<IpcResult>
    rename: (id: string, title: string) => Promise<Task | null>
    onEventsInvalidated: (cb: (taskId: string) => void) => () => void
    onUpdated: (cb: (task: Task) => void) => () => void
    onDeleted: (cb: (id: string) => void) => () => void
    onFocusTask: (cb: (id: string) => void) => () => void
    onEvent: (cb: (taskId: string, event: TaskEvent) => void) => () => void
    onPermission: (cb: (taskId: string, request: PermissionRequest) => void) => () => void
    respondPermission: (requestId: string | number, optionId: string, decision: 'allow' | 'deny') => Promise<IpcResult>
  }
  issues: {
    list: () => Promise<Issue[]>
    get: (id: string) => Promise<Issue | null>
    create: (input: IssueCreateInput) => Promise<Issue>
    runs: (id: string) => Promise<Run[]>
    comments: (id: string) => Promise<Comment[]>
    update: (id: string, patch: IssueUpdatePatch) => Promise<Issue | null>
    addComment: (id: string, content: string) => Promise<Comment | null>
    notifications: (unreadOnly?: boolean) => Promise<Notification[]>
    markNotificationRead: (id: string) => Promise<{ ok: boolean }>
    onUpdated: (cb: (payload: { taskId: string; issueId: string; issue: Issue | null; run: Run | null }) => void) => () => void
  }
  goals: {
    list: () => Promise<Goal[]>
    get: (id: string) => Promise<Goal | null>
    create: (input: GoalCreateInput) => Promise<Goal>
    runs: (id: string) => Promise<GoalRun[]>
    checkpoints: (id: string) => Promise<GoalCheckpoint[]>
    start: (id: string) => Promise<{ ok: boolean; error?: string }>
    pause: (id: string) => Promise<{ ok: boolean; error?: string }>
    resume: (id: string) => Promise<{ ok: boolean; error?: string }>
    cancel: (id: string) => Promise<{ ok: boolean; error?: string }>
    continue: (id: string) => Promise<{ ok: boolean; error?: string }>
    checkpoint: (id: string, input: GoalCheckpointInput) => Promise<GoalCheckpoint | null>
    onUpdated: (cb: (goal: Goal) => void) => () => void
  }
  automations: {
    list: () => Promise<Automation[]>
    create: (input: Omit<Automation, 'id' | 'createdAt' | 'lastRunAt' | 'nextRunAt'>) => Promise<Automation>
    update: (id: string, patch: Partial<Automation>) => Promise<Automation | null>
    delete: (id: string) => Promise<{ ok: boolean }>
    runNow: (id: string) => Promise<{ ok: boolean; error?: string; task?: Task }>
  }
  settings: {
    get: () => Promise<AppSettings>
    set: (patch: Partial<AppSettings>) => Promise<AppSettings>
    onUpdated: (cb: (settings: AppSettings) => void) => () => void
    probe: () => Promise<{ ok: boolean; detail: string; searched: string[] }>
  }
  pickDir: () => Promise<string>
  openPath: (target: string) => Promise<void>
  notify: (title: string, body: string) => void
  agents: {
    list: () => Promise<AgentInfo[]>
    save: (list: AgentInfo[]) => Promise<AgentInfo[]>
    models: (backend: string) => Promise<AgentModelCatalog>
  }
  presets: {
    list: () => Promise<PresetInfo[]>
    save: (list: PresetInfo[]) => Promise<PresetInfo[]>
    newId: () => Promise<string>
    models: (presetId: string) => Promise<AgentModelCatalog>
  }
  runtimes: { snapshot: () => Promise<RuntimeSnapshot[]> }
  analytics: { summary: (input?: { since?: number; until?: number }) => Promise<AnalyticsSummary> }
  skills: {
    list: () => Promise<{ root: string; skills: SkillMeta[] }>
    get: (name: string) => Promise<SkillDetail | null>
    save: (name: string, input: { description: string; body: string; originName?: string }) => Promise<SkillMeta>
    delete: (name: string) => Promise<IpcResult>
    import: (sourcePath: string) => Promise<SkillMeta>
    targets: () => Promise<{ targets: SkillTarget[]; states: Record<string, Record<string, SyncState>> }>
    install: (name: string, targetId: string) => Promise<IpcResult>
    uninstall: (name: string, targetId: string) => Promise<IpcResult>
    openDir: () => Promise<void>
  }
}
