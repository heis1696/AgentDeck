import type { BrowserWindow } from 'electron'
import type { Agent } from '../agents'
import type { ApiPreset } from '../presets'
import type { AutomationStore } from '../automation-store'
import type { GoalController } from '../goal-controller'
import type { IssueStore } from '../issue-store'
import type { TaskRunner } from '../runner'
import type { TaskStore } from '../store'
import type { AgentBackend } from '../backends/types'
import type { AppSettings, RunTrigger, Task } from '../../shared/types'

export interface CreateTaskInput {
  title: string
  prompt: string
  workdir: string
  backend?: string
  agentId?: string
  handoff?: string
  startNow?: boolean
  suppressIssue?: boolean
  issueId?: string
  titleAuto?: boolean
  continuesFrom?: string
  goalId?: string
  phaseIndex?: number
}

export interface IpcContext {
  getWindow: () => BrowserWindow | null
  get settings(): AppSettings
  setSettings: (settings: AppSettings) => void
  /** 共享目录实际路径：settings.sharedDir 非空用之，否则 home 下默认（skills IPC 全部经它取路径） */
  get sharedDir(): string
  readonly store: TaskStore
  readonly runner: TaskRunner
  readonly issueStore: IssueStore
  readonly goalController: GoalController
  readonly automationStore: AutomationStore
  readonly backends: Map<string, AgentBackend>
  readonly zcode: AgentBackend
  get agents(): Agent[]
  set agents(value: Agent[])
  get presets(): ApiPreset[]
  set presets(value: ApiPreset[])
  createTask: (input: CreateTaskInput, trigger?: RunTrigger) => Task
  runAutomation: (id: string) => Task | null
  publishIssueUpdate: (task: Task | null) => void
}
