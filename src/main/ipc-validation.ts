import { BACKEND_IDS, type AppSettings, type Automation, type IssuePriority, type IssueStatus, type RunTrigger, type TaskStatus } from '../shared/types'
import type { GoalCheckpointInput, GoalCreateInput, IssueCreateInput, IssueUpdatePatch, TaskCreateInput } from '../shared/contracts'
import type { Agent } from './agents'
import type { ApiPreset } from './presets'

const issueStatuses = new Set<IssueStatus>(['backlog', 'todo', 'in_progress', 'in_review', 'done', 'blocked', 'cancelled'])
const issuePriorities = new Set<IssuePriority>(['urgent', 'high', 'medium', 'low', 'none'])
const taskStatuses = new Set<TaskStatus>(['queued', 'running', 'done', 'failed', 'cancelled'])
const triggers = new Set<RunTrigger>(['assignment', 'mention', 'autopilot', 'manual', 'handoff'])
const backendIds = new Set<string>(BACKEND_IDS)
const settingsKeys = new Set<keyof AppSettings>(['theme', 'zcodePath', 'dshPath', 'nodePath', 'concurrency', 'notifyOnDone', 'mode', 'workerConcurrency'])

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 必须是对象`)
  return value as Record<string, unknown>
}

function assertKeys(input: Record<string, unknown>, allowed: readonly string[], label: string) {
  const keys = new Set(allowed)
  for (const key of Object.keys(input)) if (!keys.has(key)) throw new Error(`${label}包含未知字段: ${key}`)
}

function stringValue(value: unknown, label: string, required = true): string | undefined {
  if (value === undefined && !required) return undefined
  if (typeof value !== 'string') throw new Error(`${label} 必须是字符串`)
  const result = value.trim()
  if (required && !result) throw new Error(`${label} 不能为空`)
  return result
}

function optionalString(value: unknown, label: string) {
  return stringValue(value, label, false)
}

function booleanValue(value: unknown, label: string, required = true): boolean | undefined {
  if (value === undefined && !required) return undefined
  if (typeof value !== 'boolean') throw new Error(`${label} 必须是布尔值`)
  return value
}

function finiteNumber(value: unknown, label: string, required = true): number | undefined {
  if (value === undefined && !required) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} 必须是有限数字`)
  return value
}

export function parseId(value: unknown, label = 'id') {
  return stringValue(value, label)!
}

export function parseContent(value: unknown, label = '内容') {
  return stringValue(value, label)!
}

export function parseTaskCreate(value: unknown): TaskCreateInput {
  const input = record(value, '任务参数')
  assertKeys(input, ['title', 'prompt', 'workdir', 'backend', 'agentId', 'handoff', 'startNow', 'trigger'], '任务参数')
  const trigger = input.trigger
  if (trigger !== undefined && (typeof trigger !== 'string' || !triggers.has(trigger as RunTrigger))) throw new Error('trigger 无效')
  if (input.startNow !== undefined && typeof input.startNow !== 'boolean') throw new Error('startNow 必须是布尔值')
  return {
    title: stringValue(input.title, 'title')!,
    prompt: stringValue(input.prompt, 'prompt')!,
    workdir: stringValue(input.workdir, 'workdir', false) ?? '',
    backend: optionalString(input.backend, 'backend'),
    agentId: optionalString(input.agentId, 'agentId'),
    handoff: optionalString(input.handoff, 'handoff'),
    startNow: input.startNow as boolean | undefined,
    trigger: trigger as RunTrigger | undefined
  }
}

export function parseIssueCreate(value: unknown): IssueCreateInput {
  const input = record(value, 'Issue 参数')
  assertKeys(input, ['title', 'description', 'workdir', 'backend', 'agentId', 'handoff', 'startNow', 'trigger', 'titleAuto'], 'Issue 参数')
  const task = parseTaskCreate({
    title: input.title,
    prompt: input.description,
    workdir: input.workdir,
    backend: input.backend,
    agentId: input.agentId,
    handoff: input.handoff,
    startNow: input.startNow,
    trigger: input.trigger
  })
  if (input.titleAuto !== undefined && typeof input.titleAuto !== 'boolean') throw new Error('titleAuto 必须是布尔值')
  return {
    title: task.title,
    description: task.prompt,
    workdir: task.workdir,
    backend: task.backend,
    agentId: task.agentId,
    handoff: task.handoff,
    startNow: task.startNow,
    trigger: task.trigger,
    titleAuto: input.titleAuto as boolean | undefined
  }
}

export function parseIssuePatch(value: unknown): IssueUpdatePatch {
  const input = record(value, 'Issue 更新')
  assertKeys(input, ['priority', 'status', 'labels', 'dueDate'], 'Issue 更新')
  if (input.priority !== undefined && (typeof input.priority !== 'string' || !issuePriorities.has(input.priority as IssuePriority))) throw new Error('priority 无效')
  if (input.status !== undefined && (typeof input.status !== 'string' || !issueStatuses.has(input.status as IssueStatus))) throw new Error('status 无效')
  if (input.labels !== undefined && (!Array.isArray(input.labels) || input.labels.some((label) => typeof label !== 'string'))) throw new Error('labels 必须是字符串数组')
  if (input.dueDate !== undefined && (typeof input.dueDate !== 'number' || !Number.isFinite(input.dueDate))) throw new Error('dueDate 必须是数字')
  return {
    priority: input.priority as IssuePriority | undefined,
    status: input.status as IssueStatus | undefined,
    labels: input.labels as string[] | undefined,
    dueDate: input.dueDate as number | undefined
  }
}

function stringArrayValue(value: unknown, label: string, required = false): string[] {
  if (value === undefined && !required) return []
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  if (value.length > 100) throw new Error(`${label} has too many entries`)
  const result = value.map((item) => {
    if (typeof item !== 'string') throw new Error(`${label} entries must be strings`)
    return item.trim()
  }).filter(Boolean)
  if (required && result.length === 0) throw new Error(`${label} cannot be empty`)
  return result
}

/** Validate Goal IPC input at the main-process boundary. */
export function parseGoalCreate(value: unknown): GoalCreateInput {
  const input = record(value, 'Goal parameters')
  assertKeys(input, ['text', 'completionConditions', 'stopConditions', 'maxRuns', 'maxDurationMs', 'workdir', 'agentId', 'backend', 'startNow'], 'Goal parameters')
  if (input.startNow !== undefined && typeof input.startNow !== 'boolean') throw new Error('startNow must be boolean')
  if (input.maxRuns === undefined || typeof input.maxRuns !== 'number' || !Number.isInteger(input.maxRuns) || input.maxRuns < 1 || input.maxRuns > 10000) throw new Error('maxRuns must be an integer between 1 and 10000')
  const maxDurationMs = input.maxDurationMs
  if (typeof maxDurationMs !== 'number' || !Number.isFinite(maxDurationMs) || maxDurationMs < 1 || maxDurationMs > 365 * 24 * 60 * 60 * 1000) throw new Error('maxDurationMs must be between 1ms and 365 days')
  return {
    text: stringValue(input.text, 'text')!,
    completionConditions: stringArrayValue(input.completionConditions, 'completionConditions', true),
    stopConditions: stringArrayValue(input.stopConditions, 'stopConditions'),
    maxRuns: input.maxRuns,
    maxDurationMs,
    workdir: stringValue(input.workdir, 'workdir', false) ?? '',
    agentId: optionalString(input.agentId, 'agentId'),
    backend: optionalString(input.backend, 'backend'),
    startNow: input.startNow as boolean | undefined
  }
}

export function parseGoalCheckpoint(value: unknown): GoalCheckpointInput {
  const input = record(value, 'Goal checkpoint')
  assertKeys(input, ['summary', 'completedConditions', 'incompleteConditions', 'nextPlan', 'blockers'], 'Goal checkpoint')
  return {
    summary: stringValue(input.summary, 'summary')!,
    completedConditions: stringArrayValue(input.completedConditions, 'completedConditions'),
    incompleteConditions: stringArrayValue(input.incompleteConditions, 'incompleteConditions'),
    nextPlan: stringValue(input.nextPlan, 'nextPlan', false) ?? '',
    blockers: stringArrayValue(input.blockers, 'blockers')
  }
}

export function parseTaskStatus(value: unknown): TaskStatus {
  if (typeof value !== 'string' || !taskStatuses.has(value as TaskStatus)) throw new Error('任务状态无效')
  return value as TaskStatus
}

export function parseSettingsPatch(value: unknown): Partial<AppSettings> {
  const input = record(value, '设置')
  for (const key of Object.keys(input)) if (!settingsKeys.has(key as keyof AppSettings)) throw new Error(`未知设置项: ${key}`)
  if (input.theme !== undefined && !['dark', 'light', 'system'].includes(String(input.theme))) throw new Error('theme 无效')
  if (input.mode !== undefined && !['yolo', 'build', 'edit', 'plan'].includes(String(input.mode))) throw new Error('mode 无效')
  for (const key of ['concurrency', 'workerConcurrency'] as const) {
    if (input[key] !== undefined && (typeof input[key] !== 'number' || !Number.isInteger(input[key]) || input[key] < 1 || input[key] > 32)) throw new Error(`${key} 必须是 1-32 的整数`)
  }
  for (const key of ['zcodePath', 'dshPath', 'nodePath'] as const) if (input[key] !== undefined && typeof input[key] !== 'string') throw new Error(`${key} 必须是字符串`)
  if (input.notifyOnDone !== undefined && typeof input.notifyOnDone !== 'boolean') throw new Error('notifyOnDone 必须是布尔值')
  return input as Partial<AppSettings>
}

export type AutomationCreateInput = Pick<Automation, 'name' | 'prompt' | 'workdir' | 'scheduleMinutes' | 'output'> & Partial<Pick<Automation, 'agentId' | 'enabled'>>
export type AutomationUpdateInput = Partial<Pick<Automation, 'name' | 'prompt' | 'workdir' | 'agentId' | 'scheduleMinutes' | 'output' | 'enabled'>>

function parseAutomationFields(value: unknown, partial: boolean): AutomationCreateInput | AutomationUpdateInput {
  const input = record(value, partial ? 'Automation 更新' : 'Automation 参数')
  assertKeys(input, ['name', 'prompt', 'workdir', 'agentId', 'scheduleMinutes', 'output', 'enabled'], partial ? 'Automation 更新' : 'Automation 参数')
  const schedule = finiteNumber(input.scheduleMinutes, 'scheduleMinutes', !partial)
  if (schedule !== undefined && (!Number.isInteger(schedule) || schedule < 1 || schedule > 525_600)) throw new Error('scheduleMinutes 必须是 1-525600 的整数')
  if (!partial && input.output === undefined) throw new Error('output 不能为空')
  if (input.output !== undefined && input.output !== 'issue' && input.output !== 'run_only') throw new Error('output 无效')
  const result: AutomationUpdateInput = {}
  if (!partial || input.name !== undefined) result.name = stringValue(input.name, 'name', !partial) ?? ''
  if (!partial || input.prompt !== undefined) result.prompt = stringValue(input.prompt, 'prompt', !partial) ?? ''
  if (!partial || input.workdir !== undefined) result.workdir = stringValue(input.workdir, 'workdir', false) ?? ''
  if (input.agentId !== undefined) result.agentId = optionalString(input.agentId, 'agentId')
  if (schedule !== undefined) result.scheduleMinutes = schedule
  if (input.output !== undefined) result.output = input.output
  if (input.enabled !== undefined) result.enabled = booleanValue(input.enabled, 'enabled')
  return result
}

export function parseAutomationCreate(value: unknown): AutomationCreateInput {
  return parseAutomationFields(value, false) as AutomationCreateInput
}

export function parseAutomationUpdate(value: unknown): AutomationUpdateInput {
  return parseAutomationFields(value, true)
}

export function parseAgents(value: unknown): Agent[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error('agents 必须是最多 100 项的数组')
  const ids = new Set<string>()
  return value.map((item, index) => {
    const input = record(item, `agent[${index}]`)
    assertKeys(input, ['id', 'name', 'backend', 'role', 'systemPrompt', 'subordinates', 'model', 'presetId', 'note', 'color'], `agent[${index}]`)
    const id = stringValue(input.id, `agent[${index}].id`)!
    const backend = stringValue(input.backend, `agent[${index}].backend`)!
    if (ids.has(id)) throw new Error(`agent id 重复: ${id}`)
    if (!backendIds.has(backend)) throw new Error(`agent backend 无效: ${backend}`)
    ids.add(id)
    const subordinates = input.subordinates === undefined ? undefined : stringArrayValue(input.subordinates, `agent[${index}].subordinates`)
    return {
      id,
      name: stringValue(input.name, `agent[${index}].name`)! ,
      backend,
      color: stringValue(input.color, `agent[${index}].color`)! ,
      ...(optionalString(input.role, `agent[${index}].role`) ? { role: optionalString(input.role, `agent[${index}].role`) } : {}),
      ...(optionalString(input.systemPrompt, `agent[${index}].systemPrompt`) ? { systemPrompt: optionalString(input.systemPrompt, `agent[${index}].systemPrompt`) } : {}),
      ...(subordinates ? { subordinates } : {}),
      ...(optionalString(input.model, `agent[${index}].model`) ? { model: optionalString(input.model, `agent[${index}].model`) } : {}),
      ...(optionalString(input.presetId, `agent[${index}].presetId`) ? { presetId: optionalString(input.presetId, `agent[${index}].presetId`) } : {}),
      ...(optionalString(input.note, `agent[${index}].note`) ? { note: optionalString(input.note, `agent[${index}].note`) } : {})
    }
  })
}

export function parsePresets(value: unknown): ApiPreset[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error('presets 必须是最多 100 项的数组')
  const ids = new Set<string>()
  return value.map((item, index) => {
    const input = record(item, `preset[${index}]`)
    assertKeys(input, ['id', 'name', 'backend', 'baseURL', 'apiKey', 'note', 'createdAt'], `preset[${index}]`)
    const id = stringValue(input.id, `preset[${index}].id`)!
    const backend = stringValue(input.backend, `preset[${index}].backend`)!
    if (ids.has(id)) throw new Error(`preset id 重复: ${id}`)
    if (!backendIds.has(backend)) throw new Error(`preset backend 无效: ${backend}`)
    ids.add(id)
    return {
      id,
      name: stringValue(input.name, `preset[${index}].name`)! ,
      backend,
      baseURL: stringValue(input.baseURL, `preset[${index}].baseURL`)! ,
      apiKey: stringValue(input.apiKey, `preset[${index}].apiKey`)! ,
      createdAt: finiteNumber(input.createdAt, `preset[${index}].createdAt`)! ,
      ...(optionalString(input.note, `preset[${index}].note`) ? { note: optionalString(input.note, `preset[${index}].note`) } : {})
    }
  })
}

export function parseFollowUpOptions(value: unknown): { relay?: boolean } {
  if (value === undefined) return {}
  const input = record(value, '追问选项')
  assertKeys(input, ['relay'], '追问选项')
  return input.relay === undefined ? {} : { relay: booleanValue(input.relay, 'relay') }
}

export function parsePermissionDecision(value: unknown): 'allow' | 'deny' {
  if (value !== 'allow' && value !== 'deny') throw new Error('decision 无效')
  return value
}

export function parseNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new Error(`${label} 必须是非负整数`)
  return value
}

export function parseOptionalBoolean(value: unknown, label: string): boolean {
  return booleanValue(value, label)!
}

export function parseBackendId(value: unknown): string {
  const id = parseId(value, 'backendId')
  if (!backendIds.has(id)) throw new Error(`backendId 无效: ${id}`)
  return id
}

export function parseAnalyticsRange(value: unknown): { since?: number; until?: number } {
  if (value === undefined) return {}
  const input = record(value, 'analytics range')
  assertKeys(input, ['since', 'until'], 'analytics range')
  const since = finiteNumber(input.since, 'since', false)
  const until = finiteNumber(input.until, 'until', false)
  if (since !== undefined && since < 0) throw new Error('since 必须是非负数')
  if (until !== undefined && until < 0) throw new Error('until 必须是非负数')
  if (since !== undefined && until !== undefined && since > until) throw new Error('since 不能晚于 until')
  return { ...(since !== undefined ? { since } : {}), ...(until !== undefined ? { until } : {}) }
}

export function parseNotification(value: unknown): { title: string; body: string } {
  const input = record(value, '通知参数')
  assertKeys(input, ['title', 'body'], '通知参数')
  return { title: stringValue(input.title, 'title')!, body: stringValue(input.body, 'body', false) ?? '' }
}
