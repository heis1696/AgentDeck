// preload：向渲染层暴露类型安全的 IPC 桥
import { contextBridge, ipcRenderer } from 'electron'
import type { Task, TaskEvent, AppSettings, Issue, Run, Comment, Automation, RuntimeSnapshot, AnalyticsSummary, IssuePriority, IssueStatus, RunTrigger } from '../shared/types'
import type { SkillDetail, SkillMeta, SkillTarget, SyncState } from '../shared/skills'
import type { AgentDraft, DraftResult, ExportResult, ImproveResult, ImportResult, EvaluateResult } from '../shared/forge'
import type {
  CatalogEntry,
  DiscoveredAsset,
  ExtSourceMeta,
  HookDetail,
  HookGroup,
  HookMeta,
  HookTarget,
  MarketplacePluginInfo,
  MarketplaceRegisterResult,
  MarketplaceStatus,
  McpMeta,
  McpTarget,
  McpTransport,
  PluginCliResult,
  PluginInventoryItem,
  RegisteredMarketplace,
  SkillDiscoveryGroup,
  SkillsFromUrlResult,
  SkillsShEntry
} from '../shared/extensions'
import type { AgentDeckApi, AgentInfo, AgentModelCatalog, FileDiffResult, GoalCheckpointInput, GoalCreateInput, MeetingCreateInput, PermissionRequest, PresetInfo, SidecarSnapshot, TaskCreateInput, UpdateChannel, UpdateStateSnapshot } from '../shared/contracts'
import type { PackAssets, PetDragPosition, PetGenDone, PetGenProgress, PetGenStartInput, PetSayPayload, PetStateSnapshot, PetThrowVelocity, PetWindowEvent } from '../shared/pet'

// 就绪屏障（启动契约，与主进程 initMain 的 app:ready 对应）：窗口先出、壳先画，
// 数据面（sidecar 握手、store 水合、启动对账、IPC 注册）完成前，所有 invoke 在此
// 排队——渲染层任何组件无需感知时序。广播通道不走 invoke，不受影响。
// app:ready 是唯一先于屏障注册的 handler（主进程在 createWindow 之前注册）；
// 屏障调用失败（新旧渲染层/主进程错峰热更）或超时则放行——退化为既有行为，
// 由各调用方自身的错误处理兜底。
let readyTimeout: ReturnType<typeof setTimeout> | undefined
const readyBarrier = Promise.race([
  ipcRenderer.invoke('app:ready').catch(() => {}),
  new Promise<void>((resolve) => { readyTimeout = setTimeout(resolve, 30_000) })
]).finally(() => clearTimeout(readyTimeout))
const invoke = <T = any>(channel: string, ...args: unknown[]): Promise<T> =>
  readyBarrier.then(() => ipcRenderer.invoke(channel, ...args)) as Promise<T>

const api: AgentDeckApi = {
  // 平台白名单注入：只交平台字面量，不暴露 process 对象——渲染层路径语义
  // （sharedPathKey 的 win32 折叠/posix 精确分支）据此选择，渲染页里没有 process
  platform: process.platform,
  worktrees: {
    prune: () => invoke('worktrees:prune')
  },
  tasks: {
    list: (): Promise<Task[]> => invoke('tasks:list'),
    get: (id: string): Promise<Task | null> => invoke('tasks:get', id),
    events: (id: string, afterSeq = 0): Promise<TaskEvent[]> => invoke('tasks:events', id, afterSeq),
    create: (input: TaskCreateInput) =>
      invoke('tasks:create', input) as Promise<Task>,
    cancel: (id: string, reason?: string) => invoke('tasks:cancel', id, reason) as Promise<{ ok: boolean; error?: string; warning?: string }>,
    followUp: (id: string, content: string, opts?: { relay?: boolean; collectFinal?: boolean; wait?: boolean }) =>
      invoke('tasks:followup', id, content, opts) as Promise<{ ok: boolean; error?: string }>,
    delete: (id: string) => invoke('tasks:delete', id) as Promise<{ ok: boolean; error?: string }>,
    retry: (id: string) => invoke('tasks:retry', id) as Promise<{ ok: boolean; error?: string }>,
    move: (id: string, status: Task['status']) => invoke('tasks:move', id, status) as Promise<{ ok: boolean; error?: string }>,
    start: (id: string) => invoke('tasks:start', id) as Promise<{ ok: boolean; error?: string }>,
    rewind: (id: string, toSeq: number): Promise<{ ok: boolean; error?: string }> =>
      invoke('tasks:rewind', id, toSeq),
    rename: (id: string, title: string): Promise<Task | null> =>
      invoke('tasks:rename', id, title),
    /** 编辑详情：单文件的 git 权威未提交 diff（工作区 + 暂存对 HEAD） */
    fileDiff: (taskId: string, file: string): Promise<FileDiffResult> =>
      invoke('tasks:fileDiff', taskId, file),
    onEventsInvalidated: (cb: (taskId: string) => void) => {
      const h = (_e: unknown, payload: { taskId: string }) => cb(payload.taskId)
      ipcRenderer.on('task:events-invalidated', h)
      return () => ipcRenderer.removeListener('task:events-invalidated', h)
    },
    onUpdated: (cb: (t: Task) => void) => {
      const h = (_e: unknown, t: Task) => cb(t)
      ipcRenderer.on('task:updated', h)
      return () => ipcRenderer.removeListener('task:updated', h)
    },
    onDeleted: (cb: (id: string) => void) => {
      const h = (_e: unknown, id: string) => cb(id)
      ipcRenderer.on('task:deleted', h)
      return () => ipcRenderer.removeListener('task:deleted', h)
    },
    onFocusTask: (cb: (id: string) => void) => {
      const h = (_e: unknown, id: string) => cb(id)
      ipcRenderer.on('task:focus', h)
      return () => ipcRenderer.removeListener('task:focus', h)
    },
    onEvent: (cb: (taskId: string, e: TaskEvent) => void) => {
      const h = (_e: unknown, payload: { taskId: string; event: TaskEvent }) => cb(payload.taskId, payload.event)
      ipcRenderer.on('task:event', h)
      return () => ipcRenderer.removeListener('task:event', h)
    },
    onPermission: (cb: (taskId: string, req: PermissionRequest) => void) => {
      const h = (_e: unknown, payload: { taskId: string; request: PermissionRequest }) => cb(payload.taskId, payload.request)
      ipcRenderer.on('task:permission', h)
      return () => ipcRenderer.removeListener('task:permission', h)
    },
    pendingPermissions: (taskId: string): Promise<PermissionRequest[]> => invoke('tasks:permission-pending', taskId),
    respondPermission: (requestId: string | number, optionId: string, decision: 'allow' | 'deny', requestToken?: string) =>
      invoke('tasks:permission-respond', String(requestId), optionId, decision, requestToken) as Promise<{ ok: boolean; error?: string }>
  },
  issues: {
    list: (): Promise<Issue[]> => invoke('issues:list'),
    get: (id: string): Promise<Issue | null> => invoke('issues:get', id),
    create: (input: { title: string; description: string; workdir: string; agentId?: string; backend?: string; handoff?: string; startNow?: boolean; trigger?: RunTrigger; titleAuto?: boolean }): Promise<Issue> => invoke('issues:create', input),
    runs: (id: string): Promise<Run[]> => invoke('issues:runs', id),
    comments: (id: string): Promise<Comment[]> => invoke('issues:comments', id),
    update: (id: string, patch: { priority?: IssuePriority; labels?: string[]; dueDate?: number; status?: IssueStatus }): Promise<Issue | null> => invoke('issues:update', id, patch),
    addComment: (id: string, content: string): Promise<Comment | null> => invoke('issues:add-comment', id, content),
    onUpdated: (cb: (payload: { taskId: string; issueId: string; issue: Issue | null; run: Run | null }) => void) => {
      const h = (_e: unknown, payload: { taskId: string; issueId: string; issue: Issue | null; run: Run | null }) => cb(payload)
      ipcRenderer.on('issues:updated', h)
      return () => ipcRenderer.removeListener('issues:updated', h)
    }
  },
  goals: {
    list: (): Promise<import('../shared/types').Goal[]> => invoke('goals:list'),
    get: (id: string): Promise<import('../shared/types').Goal | null> => invoke('goals:get', id),
    create: (input: GoalCreateInput): Promise<import('../shared/types').Goal> => invoke('goals:create', input),
    runs: (id: string): Promise<import('../shared/types').GoalRun[]> => invoke('goals:runs', id),
    checkpoints: (id: string): Promise<import('../shared/types').GoalCheckpoint[]> => invoke('goals:checkpoints', id),
    snapshots: (id: string): Promise<import('../shared/types').GoalSpecSnapshot[]> => invoke('goals:snapshots', id),
    decisions: (id: string): Promise<import('../shared/types').GoalSpecDecision[]> => invoke('goals:decisions', id),
    approveEvolution: (id: string, actor?: string) => invoke('goals:approve-evolution', id, actor) as Promise<import('../shared/types').GoalApprovalSnapshot | null>,
    evolve: (id: string, input: import('../shared/contracts').GoalEvolveInput) => invoke('goals:evolve', id, input) as Promise<{ ok: boolean; error?: string; goal?: import('../shared/types').Goal; snapshot?: import('../shared/types').GoalSpecSnapshot; questions?: string[] }>,
    evolveStep: (id: string, input: import('../shared/contracts').GoalEvolveInput) => invoke('goals:evolve-step', id, input) as Promise<{ ok: boolean; error?: string; goal?: import('../shared/types').Goal; snapshot?: import('../shared/types').GoalSpecSnapshot; questions?: string[] }>,
    rollback: (id: string, generation: number) => invoke('goals:rollback', id, generation) as Promise<{ ok: boolean; error?: string; goal?: import('../shared/types').Goal; snapshot?: import('../shared/types').GoalSpecSnapshot }>,
    start: (id: string) => invoke('goals:start', id) as Promise<{ ok: boolean; error?: string }>,
    pause: (id: string) => invoke('goals:pause', id) as Promise<{ ok: boolean; error?: string }>,
    resume: (id: string) => invoke('goals:resume', id) as Promise<{ ok: boolean; error?: string }>,
    cancel: (id: string) => invoke('goals:cancel', id) as Promise<{ ok: boolean; error?: string }>,
    continue: (id: string) => invoke('goals:continue', id) as Promise<{ ok: boolean; error?: string }>,
    checkpoint: (id: string, input: GoalCheckpointInput) => invoke('goals:checkpoint', id, input) as Promise<import('../shared/types').GoalCheckpoint | null>,
    delete: (id: string) => invoke('goals:delete', id) as Promise<{ ok: boolean; error?: string }>,
    onUpdated: (cb: (goal: import('../shared/types').Goal) => void) => {
      const h = (_e: unknown, goal: import('../shared/types').Goal) => cb(goal)
      ipcRenderer.on('goals:updated', h)
      return () => ipcRenderer.removeListener('goals:updated', h)
    },
    onDeleted: (cb: (goalId: string) => void) => {
      const h = (_e: unknown, goalId: string) => cb(goalId)
      ipcRenderer.on('goals:deleted', h)
      return () => ipcRenderer.removeListener('goals:deleted', h)
    }
  },
  meetings: {
    list: (): Promise<import('../shared/meeting').Meeting[]> => invoke('meetings:list'),
    get: (id: string): Promise<import('../shared/meeting').Meeting | null> => invoke('meetings:get', id),
    readTurns: (id, query) => invoke('meetings:read-turns', id, query),
    getTurn: (id, turnId) => invoke('meetings:get-turn', id, turnId),
    memberExecutions: (id, agentId) => invoke('meetings:member-executions', id, agentId),
    retryMirrors: (id) => invoke('meetings:retry-mirrors', id),
    create: (input: MeetingCreateInput): Promise<import('../shared/meeting').Meeting> => invoke('meetings:create', input),
    start: (id: string) => invoke('meetings:start', id) as Promise<{ ok: boolean; error?: string }>,
    pause: (id: string) => invoke('meetings:pause', id) as Promise<{ ok: boolean; error?: string }>,
    resume: (id: string) => invoke('meetings:resume', id) as Promise<{ ok: boolean; error?: string }>,
    interject: (id: string, note: string) => invoke('meetings:interject', id, note) as Promise<{ ok: boolean; error?: string }>,
    cancel: (id: string) => invoke('meetings:cancel', id) as Promise<{ ok: boolean; error?: string }>,
    approveAction: (id: string, index: number, verdict: 'approved' | 'rejected') => invoke('meetings:approve-action', id, index, verdict) as Promise<{ ok: boolean; error?: string }>,
    delete: (id: string) => invoke('meetings:delete', id) as Promise<{ ok: boolean; error?: string }>,
    onUpdated: (cb: (meeting: import('../shared/meeting').Meeting) => void) => {
      const h = (_e: unknown, meeting: import('../shared/meeting').Meeting) => cb(meeting)
      ipcRenderer.on('meetings:updated', h)
      return () => ipcRenderer.removeListener('meetings:updated', h)
    },
    onDeleted: (cb: (meetingId: string) => void) => {
      const h = (_e: unknown, meetingId: string) => cb(meetingId)
      ipcRenderer.on('meetings:deleted', h)
      return () => ipcRenderer.removeListener('meetings:deleted', h)
    }
  },
  automations: {
    list: (): Promise<Automation[]> => invoke('automations:list'),
    create: (input: Omit<Automation, 'id' | 'createdAt' | 'lastRunAt' | 'nextRunAt'>): Promise<Automation> => invoke('automations:create', input),
    update: (id: string, patch: Partial<Automation>): Promise<Automation | null> => invoke('automations:update', id, patch),
    delete: (id: string): Promise<{ ok: boolean }> => invoke('automations:delete', id),
    runNow: (id: string): Promise<{ ok: boolean; error?: string; task?: Task }> => invoke('automations:run-now', id)
  },
  settings: {
    get: (): Promise<AppSettings> => invoke('settings:get'),
    set: (patch: Partial<AppSettings>): Promise<AppSettings> => invoke('settings:set', patch),
    onUpdated: (cb: (s: AppSettings) => void): (() => void) => {
      const listener = (_e: unknown, s: AppSettings) => cb(s)
      ipcRenderer.on('settings:updated', listener)
      return () => ipcRenderer.removeListener('settings:updated', listener)
    },
    probe: (): Promise<{ ok: boolean; detail: string; searched: string[] }> => invoke('settings:probe')
  },
  pickDir: (): Promise<string> => invoke('dialog:pick-dir'),
  openPath: (target: string): Promise<void> => invoke('shell:open', target),
  notify: (title: string, body: string): void => ipcRenderer.send('notify', { title, body }),
  agents: {
    list: (): Promise<Array<AgentInfo>> =>
      invoke('agents:list'),
    save: (list: Array<AgentInfo>) =>
      invoke('agents:save', list) as Promise<Array<AgentInfo>>,
    models: (backend: string): Promise<AgentModelCatalog> =>
      invoke('agents:models', backend),
    draft: (description: string, answers?: string[]): Promise<DraftResult> => invoke('agents:draft', description, answers ?? null),
    improve: (agentId: string, feedback: string): Promise<ImproveResult> => invoke('agents:improve', agentId, feedback),
    evaluate: (draft: AgentDraft): Promise<EvaluateResult> => invoke('agents:evaluate', draft),
    importMd: (): Promise<ImportResult> => invoke('agents:import-md'),
    exportMd: (agentId: string): Promise<ExportResult> => invoke('agents:export-md', agentId)
  },
  presets: {
    list: (): Promise<Array<PresetInfo>> => invoke('presets:list'),
    save: (list: Array<PresetInfo>) => invoke('presets:save', list) as Promise<Array<PresetInfo>>,
    newId: (): Promise<string> => invoke('presets:new-id'),
    models: (presetId: string): Promise<AgentModelCatalog> => invoke('presets:models', presetId)
  },
  runtimes: {
    snapshot: (): Promise<RuntimeSnapshot[]> => invoke('runtime:snapshot')
  },
  analytics: {
    summary: (input?: { since?: number; until?: number }): Promise<AnalyticsSummary> => invoke('analytics:summary', input)
  },
  sidecar: {
    status: (): Promise<SidecarSnapshot | null> => invoke('sidecar:status'),
    sync: (): Promise<unknown> => invoke('sidecar:sync'),
    reconnect: (): Promise<SidecarSnapshot | null> => invoke('sidecar:reconnect'),
    onStatus: (cb: (snapshot: SidecarSnapshot) => void) => {
      const h = (_e: unknown, snapshot: SidecarSnapshot) => cb(snapshot)
      ipcRenderer.on('sidecar:status', h)
      return () => ipcRenderer.removeListener('sidecar:status', h)
    }
  },
  pet: {
    getState: (): Promise<PetStateSnapshot | null> => invoke('pet:get-state'),
    setEnabled: (on: boolean): Promise<PetStateSnapshot | null> => invoke('pet:set-enabled', on),
    setPack: (packId: string): Promise<PetStateSnapshot | null> => invoke('pet:set-pack', packId),
    getPackAssets: (packId: string): Promise<PackAssets | null> => invoke('pet:get-pack-assets', packId),
    sendChat: (text: string): Promise<PetSayPayload | null> => invoke('pet:send-chat', text),
    setPersona: (text: string): Promise<PetStateSnapshot | null> => invoke('pet:set-persona', text),
    setAutonomy: (sec: number): Promise<PetStateSnapshot | null> => invoke('pet:set-autonomy', sec),
    setPreset: (presetId: string, model?: string): Promise<PetStateSnapshot | null> => invoke('pet:set-preset', presetId, model),
    setZoom: (zoom: number): Promise<PetStateSnapshot | null> => invoke('pet:set-zoom', zoom),
    feed: (foodId: string): Promise<PetStateSnapshot | null> => invoke('pet:feed', foodId),
    openSettingsWindow: (): Promise<void> => invoke('pet:open-settings-window'),
    genStart: (input: PetGenStartInput): Promise<{ ok: boolean; error?: string }> => invoke('pet:gen-start', input),
    genCancel: (): Promise<{ ok: boolean }> => invoke('pet:gen-cancel'),
    windowEvent: (event: PetWindowEvent): void => ipcRenderer.send('pet:window-event', event),
    onSay: (cb: (say: PetSayPayload) => void) => {
      const h = (_e: unknown, say: PetSayPayload) => cb(say)
      ipcRenderer.on('pet:say', h)
      return () => ipcRenderer.removeListener('pet:say', h)
    },
    onState: (cb: (snapshot: PetStateSnapshot) => void) => {
      const h = (_e: unknown, snapshot: PetStateSnapshot) => cb(snapshot)
      ipcRenderer.on('pet:state', h)
      return () => ipcRenderer.removeListener('pet:state', h)
    },
    onDrag: (cb: (position: PetDragPosition) => void) => {
      const h = (_e: unknown, position: PetDragPosition) => cb(position)
      ipcRenderer.on('pet:drag', h)
      return () => ipcRenderer.removeListener('pet:drag', h)
    },
    onThrown: (cb: (velocity: PetThrowVelocity) => void) => {
      const h = (_e: unknown, velocity: PetThrowVelocity) => cb(velocity)
      ipcRenderer.on('pet:thrown', h)
      return () => ipcRenderer.removeListener('pet:thrown', h)
    },
    onPackChanged: (cb: () => void) => {
      const h = () => cb()
      ipcRenderer.on('pet:pack-changed', h)
      return () => ipcRenderer.removeListener('pet:pack-changed', h)
    },
    onMenuClosed: (cb: () => void) => {
      const h = () => cb()
      ipcRenderer.on('pet:menu-closed', h)
      return () => ipcRenderer.removeListener('pet:menu-closed', h)
    },
    onGenProgress: (cb: (progress: PetGenProgress) => void) => {
      const h = (_e: unknown, progress: PetGenProgress) => cb(progress)
      ipcRenderer.on('pet:gen-progress', h)
      return () => ipcRenderer.removeListener('pet:gen-progress', h)
    },
    onGenDone: (cb: (result: PetGenDone) => void) => {
      const h = (_e: unknown, result: PetGenDone) => cb(result)
      ipcRenderer.on('pet:gen-done', h)
      return () => ipcRenderer.removeListener('pet:gen-done', h)
    },
    onGenError: (cb: (result: { packId: string; reason: string }) => void) => {
      const h = (_e: unknown, result: { packId: string; reason: string }) => cb(result)
      ipcRenderer.on('pet:gen-error', h)
      return () => ipcRenderer.removeListener('pet:gen-error', h)
    }
  },
  updates: {
    getState: (): Promise<UpdateStateSnapshot> => invoke('updates:get-state'),
    check: (): Promise<UpdateStateSnapshot> => invoke('updates:check'),
    apply: (channel: UpdateChannel): Promise<{ ok: boolean; error?: string }> => invoke('updates:apply', channel),
    applyAll: (): Promise<{ ok: boolean; error?: string }> => invoke('updates:apply-all'),
    rollback: (channel: UpdateChannel): Promise<{ ok: boolean; error?: string }> => invoke('updates:rollback', channel),
    onState: (cb: (snapshot: UpdateStateSnapshot) => void) => {
      const h = (_e: unknown, snapshot: UpdateStateSnapshot) => cb(snapshot)
      ipcRenderer.on('updates:state', h)
      return () => ipcRenderer.removeListener('updates:state', h)
    }
  },
  skills: {
    list: (): Promise<{ root: string; skills: SkillMeta[] }> => invoke('skills:list'),
    get: (name: string): Promise<SkillDetail | null> => invoke('skills:get', name),
    save: (name: string, input: { description: string; body: string; originName?: string }): Promise<SkillMeta> =>
      invoke('skills:save', name, input),
    delete: (name: string): Promise<{ ok: boolean }> => invoke('skills:delete', name),
    import: (sourcePath: string): Promise<SkillMeta> => invoke('skills:import', sourcePath),
    installFromUrl: (ref: string): Promise<SkillsFromUrlResult> => invoke('skills:install-from-url', ref),
    searchOnline: (query: string, limit?: number, offset?: number): Promise<{ entries: SkillsShEntry[]; total: number }> =>
      invoke('skills:search-online', query, limit, offset),
    installOnline: (entry: { skillId: string; owner: string; repo: string }): Promise<{ name: string }> =>
      invoke('skills:install-online', entry),
    openExternal: (url: string): Promise<void> => invoke('skills:open-external', url),
    targets: (): Promise<{ targets: SkillTarget[]; states: Record<string, Record<string, SyncState>> }> => invoke('skills:targets'),
    install: (name: string, targetId: string): Promise<{ ok: boolean }> => invoke('skills:install', name, targetId),
    uninstall: (name: string, targetId: string): Promise<{ ok: boolean }> => invoke('skills:uninstall', name, targetId),
    openDir: (): Promise<void> => invoke('skills:open-dir')
  },
  mcp: {
    list: (): Promise<{ servers: McpMeta[] }> => invoke('mcp:list'),
    save: (def: { name: string; description: string; transport: McpTransport }, originName?: string): Promise<McpMeta> =>
      invoke('mcp:save', def, originName),
    delete: (name: string): Promise<{ ok: boolean }> => invoke('mcp:delete', name),
    targets: (): Promise<{ targets: McpTarget[]; states: Record<string, Record<string, SyncState>> }> => invoke('mcp:targets'),
    install: (name: string, targetId: string): Promise<{ ok: boolean }> => invoke('mcp:install', name, targetId),
    uninstall: (name: string, targetId: string): Promise<{ ok: boolean }> => invoke('mcp:uninstall', name, targetId)
  },
  hooks: {
    list: (): Promise<{ hooks: HookMeta[] }> => invoke('hooks:list'),
    get: (name: string): Promise<HookDetail | null> => invoke('hooks:get', name),
    save: (
      name: string,
      input: { description: string; body: string; events: Record<string, HookGroup[]>; originName?: string }
    ): Promise<HookMeta> => invoke('hooks:save', name, input),
    delete: (name: string): Promise<{ ok: boolean }> => invoke('hooks:delete', name),
    targets: (): Promise<{ targets: HookTarget[]; states: Record<string, Record<string, SyncState>> }> => invoke('hooks:targets'),
    install: (name: string, targetId: string): Promise<{ ok: boolean }> => invoke('hooks:install', name, targetId),
    uninstall: (name: string, targetId: string): Promise<{ ok: boolean }> => invoke('hooks:uninstall', name, targetId)
  },
  plugins: {
    inventory: (): Promise<{ items: PluginInventoryItem[] }> => invoke('plugins:inventory'),
    setEnabled: (input: { cli: 'claude'; name: string; marketplace: string; enabled: boolean }): Promise<{ ok: boolean }> =>
      invoke('plugins:set-enabled', input),
    openDir: (cli: 'claude' | 'zcode' | 'codex'): Promise<void> => invoke('plugins:open-dir', cli),
    install: (input: { cli: 'claude'; spec: string }): Promise<PluginCliResult> => invoke('plugins:install', input),
    uninstall: (input: { cli: 'claude'; spec: string }): Promise<PluginCliResult> => invoke('plugins:uninstall', input)
  },
  marketplaces: {
    status: (): Promise<MarketplaceStatus> => invoke('marketplaces:status'),
    register: (sourceId: string, assetPath: string): Promise<MarketplaceRegisterResult> =>
      invoke('marketplaces:register', sourceId, assetPath),
    listPlugins: (sourceId: string, assetPath: string): Promise<{ plugins: MarketplacePluginInfo[] }> =>
      invoke('marketplaces:list-plugins', sourceId, assetPath),
    listRegistered: (): Promise<{ marketplaces: RegisteredMarketplace[] }> => invoke('marketplaces:list-registered')
  },
  sources: {
    catalog: (): Promise<{ entries: CatalogEntry[] }> => invoke('sources:catalog'),
    list: (): Promise<{ sources: ExtSourceMeta[] }> => invoke('sources:list'),
    add: (ref: string, name?: string): Promise<ExtSourceMeta> => invoke('sources:add', ref, name),
    quickAdd: (ref: string, name?: string): Promise<{ source: ExtSourceMeta; assets: DiscoveredAsset[] }> =>
      invoke('sources:quick-add', ref, name),
    remove: (id: string): Promise<{ ok: boolean }> => invoke('sources:remove', id),
    sync: (id: string): Promise<ExtSourceMeta> => invoke('sources:sync', id),
    browse: (id: string): Promise<{ assets: DiscoveredAsset[] }> => invoke('sources:browse', id),
    listSkills: (): Promise<{ groups: SkillDiscoveryGroup[] }> => invoke('sources:list-skills'),
    importSkill: (id: string, relPath: string): Promise<{ name: string }> => invoke('sources:import-skill', id, relPath)
  }
}

contextBridge.exposeInMainWorld('agentdeck', api)
