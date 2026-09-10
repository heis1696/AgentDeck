import type { BrowserWindow } from 'electron'
import type { Agent } from '../agents'
import type { ApiPreset } from '../presets'
import type { AutomationStore } from '../automation-store'
import type { GoalController } from '../goal-controller'
import type { IssueStore } from '../issue-store'
import type { TaskRunner } from '../runner'
import type { TaskStore } from '../store'
import type { CreateTaskInput } from '../task-service'
import type { AgentBackend } from '../backends/types'
import type { AppSettings, RunTrigger, Task } from '../../shared/types'
import type { SidecarManager } from '../sidecar'

export type { CreateTaskInput } from '../task-service'

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
  /** Optional business-brain sidecar. Legacy/test contexts may omit it. */
  readonly sidecar?: SidecarManager
  get agents(): Agent[]
  set agents(value: Agent[])
  get presets(): ApiPreset[]
  set presets(value: ApiPreset[])
  createTask: (input: CreateTaskInput, trigger?: RunTrigger) => Task
  runAutomation: (id: string) => Task | null
  publishIssueUpdate: (task: Task | null) => void
}
