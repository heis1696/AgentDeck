import type { AcceptanceCriterion, Automation, AppSettings, AnalyticsSummary, Comment, Goal, GoalApprovalSnapshot, GoalCheckpoint, GoalEvolutionPatch, GoalSpecDecision, GoalSpecSnapshot, GoalRun, Issue, IssuePriority, IssueStatus, Run, RunTrigger, RuntimeSnapshot, Task, TaskEvent } from './types'
import type { SkillDetail, SkillMeta, SkillTarget, SyncState } from './skills'
import type { AgentDraft, DraftResult, ExportResult, ImproveResult, ImportResult, EvaluateResult } from './forge'
import type { Meeting, MeetingCreateInput } from './meeting'
import type { PackAssets } from './pet'
import type { PetDragPosition, PetSayPayload, PetStateSnapshot, PetThrowVelocity, PetWindowEvent } from './pet'
export type { MeetingCreateInput } from './meeting'
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
} from './extensions'

/** Loop 4 规格进化输入：patch 为提议的规格变更，approve=true 才会应用（结果闸门结论随行记录）。 */
export interface GoalEvolveInput {
  patch?: GoalEvolutionPatch
  approve?: boolean
  outcomeGatePassed?: boolean
  ambiguityScore?: number
  /** Independent approval record; required on the production IPC path. */
  approvalSnapshot?: GoalApprovalSnapshot
}

export interface PermissionRequest {
  requestId: string | number
  /** Snapshot of the task content this approval was issued for. */
  workVersion?: string | number
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
  /** 线协议：openai = OpenAI 兼容（OpenRouter/OneAPI 等 /chat/completions），anthropic = /messages；缺省按 baseURL 推断 */
  protocol?: 'anthropic' | 'openai'
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
  /** Stable request key for replay-safe Task creation across restarts. */
  requestId?: string
  /** Alias accepted by API clients. */
  idempotencyKey?: string
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
  requestId?: string
  idempotencyKey?: string
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
  /** Optional stable criterion list; omitted values are derived from completionConditions. */
  acceptanceCriteria?: Array<Pick<AcceptanceCriterion, 'id' | 'text'> | string>
  stopConditions: string[]
  maxRuns: number
  maxDurationMs: number
  /** Maximum consecutive checker blocks; defaults to 8. */
  blockCap?: number
  /** Maximum consecutive identical outputs; defaults to 2. */
  noProgressCap?: number
  workdir: string
  agentId?: string
  backend?: string
  startNow?: boolean
  /** Optional pre-execution ambiguity score; high values require clarification. */
  ambiguityScore?: number
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

/** 单文件未提交 diff 的失败原因码（`tasks:fileDiff`）。 */
export type FileDiffErrorCode =
  | 'bad-request'   // taskId/file 参数非法（空、绝对路径、.. 逃逸）
  | 'no-task'       // 任务不存在
  | 'no-workdir'    // 任务未绑定工作目录，或目录已不存在
  | 'not-a-repo'    // 工作目录不是 Git 仓库
  | 'file-missing'  // 文件既未被 git 跟踪，也不在工作区
  | 'git-failed'    // git 命令异常退出

/** `tasks:fileDiff` 的渲染契约：git 权威的单文件未提交改动。
 *  - diff = `git diff --unified=3`（索引→工作区）+ `git diff --cached --unified=3`（HEAD→索引）按序拼接，
 *    保留 git 原样的结尾换行；未跟踪新文件用 `--no-index` 生成「新增整文件」diff。
 *  - additions/deletions 取两段 numstat 之和，与展示文本是否截断无关。
 *  - binary=true（二进制，git 无 +/- 行数）时 diff 为空串；无改动但文件存在时 note='clean'；
 *    diff 超过 256KB 按行截断并置 truncated=true。
 *  - 失败不 reject：ok=false 且带 code（渲染层可分流提示）。 */
export interface FileDiffResult {
  ok: boolean
  /** 归一化后的仓库相对路径（与 git 一致，正斜杠）。 */
  file: string
  additions: number
  deletions: number
  diff: string
  binary: boolean
  truncated: boolean
  /** 目前只有 'clean'：无未提交改动，渲染层回退事件里的 +/- 快照。 */
  note?: 'clean'
  code?: FileDiffErrorCode
  error?: string
}

/** Renderer-safe snapshot of the optional business-brain sidecar. */
export interface SidecarSnapshot {
  protocolVersion: number
  port: number
  /** Omitted from renderer IPC responses; bearer tokens stay in main. */
  token?: string
  instanceId: string
  pid?: number
  startedAt: number
  status: 'stopped' | 'starting' | 'ready' | 'degraded' | 'reconnecting' | 'stopping'
  url: string
  orphanRuns: string[]
}

export interface AgentDeckApi {
  worktrees: {
    prune: () => Promise<{ scanned: number; removed: string[]; retained: Array<{ name: string; reason: string }>; failed: Array<{ name: string; reason: string }> }>
  }
  tasks: {
    list: () => Promise<Task[]>
    get: (id: string) => Promise<Task | null>
    events: (id: string, afterSeq?: number) => Promise<TaskEvent[]>
    create: (input: TaskCreateInput) => Promise<Task>
    cancel: (id: string) => Promise<IpcResult>
    followUp: (id: string, content: string, opts?: { relay?: boolean; collectFinal?: boolean; wait?: boolean }) => Promise<IpcResult>
    delete: (id: string) => Promise<IpcResult>
    retry: (id: string) => Promise<IpcResult>
    move: (id: string, status: Task['status']) => Promise<IpcResult>
    start: (id: string) => Promise<IpcResult>
    rewind: (id: string, toSeq: number) => Promise<IpcResult>
    rename: (id: string, title: string) => Promise<Task | null>
    /** 编辑详情：单文件的 git 权威未提交 diff（工作区 + 暂存对 HEAD），右侧只读代码分页用。 */
    fileDiff: (taskId: string, file: string) => Promise<FileDiffResult>
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
    onUpdated: (cb: (payload: { taskId: string; issueId: string; issue: Issue | null; run: Run | null }) => void) => () => void
  }
  goals: {
    list: () => Promise<Goal[]>
    get: (id: string) => Promise<Goal | null>
    create: (input: GoalCreateInput) => Promise<Goal>
    runs: (id: string) => Promise<GoalRun[]>
    checkpoints: (id: string) => Promise<GoalCheckpoint[]>
    snapshots: (id: string) => Promise<GoalSpecSnapshot[]>
    decisions: (id: string) => Promise<GoalSpecDecision[]>
    approveEvolution: (id: string, actor?: string) => Promise<GoalApprovalSnapshot | null>
    evolve: (id: string, input: GoalEvolveInput) => Promise<{ ok: boolean; error?: string; goal?: Goal; snapshot?: GoalSpecSnapshot; questions?: string[] }>
    evolveStep: (id: string, input: GoalEvolveInput) => Promise<{ ok: boolean; error?: string; goal?: Goal; snapshot?: GoalSpecSnapshot; questions?: string[] }>
    rollback: (id: string, generation: number) => Promise<{ ok: boolean; error?: string; goal?: Goal; snapshot?: GoalSpecSnapshot }>
    start: (id: string) => Promise<{ ok: boolean; error?: string }>
    pause: (id: string) => Promise<{ ok: boolean; error?: string }>
    resume: (id: string) => Promise<{ ok: boolean; error?: string }>
    cancel: (id: string) => Promise<{ ok: boolean; error?: string }>
    continue: (id: string) => Promise<{ ok: boolean; error?: string }>
    checkpoint: (id: string, input: GoalCheckpointInput) => Promise<GoalCheckpoint | null>
    delete: (id: string) => Promise<{ ok: boolean; error?: string }>
    onUpdated: (cb: (goal: Goal) => void) => () => void
    onDeleted: (cb: (goalId: string) => void) => () => void
  }
  meetings: {
    list: () => Promise<Meeting[]>
    get: (id: string) => Promise<Meeting | null>
    create: (input: MeetingCreateInput) => Promise<Meeting>
    start: (id: string) => Promise<IpcResult>
    pause: (id: string) => Promise<IpcResult>
    resume: (id: string) => Promise<IpcResult>
    interject: (id: string, note: string) => Promise<IpcResult>
    cancel: (id: string) => Promise<IpcResult>
    approveAction: (meetingId: string, itemIndex: number, verdict: 'approved' | 'rejected') => Promise<IpcResult>
    delete: (id: string) => Promise<IpcResult>
    onUpdated: (cb: (meeting: Meeting) => void) => () => void
    onDeleted: (cb: (meetingId: string) => void) => () => void
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
    /** 锻造师：一句描述 → 草稿；描述含糊时先返回澄清问题（提供 answers 即强制出稿） */
    draft: (description: string, answers?: string[]) => Promise<DraftResult>
    /** 锻造师：按反馈改进既有 agent 的定义（backend/预设/可驱使不在改进范围） */
    improve: (agentId: string, feedback: string) => Promise<ImproveResult>
    /** 锻造师：对草稿做触发评测（should/should-not 实测路由，passRate 应用侧复算） */
    evaluate: (draft: AgentDraft) => Promise<EvaluateResult>
    /** 导入 .md（Claude subagent 格式）→ 草稿（系统对话框选文件） */
    importMd: () => Promise<ImportResult>
    /** 导出 agent 为 .md（Claude subagent 格式，另存对话框） */
    exportMd: (agentId: string) => Promise<ExportResult>
  }
  presets: {
    list: () => Promise<PresetInfo[]>
    save: (list: PresetInfo[]) => Promise<PresetInfo[]>
    newId: () => Promise<string>
    models: (presetId: string) => Promise<AgentModelCatalog>
  }
  runtimes: { snapshot: () => Promise<RuntimeSnapshot[]> }
  analytics: { summary: (input?: { since?: number; until?: number }) => Promise<AnalyticsSummary> }
  sidecar: {
    status: () => Promise<SidecarSnapshot | null>
    sync: () => Promise<unknown>
    reconnect: () => Promise<SidecarSnapshot | null>
    onStatus: (cb: (snapshot: SidecarSnapshot) => void) => () => void
  }
  pet: {
    getState: () => Promise<PetStateSnapshot | null>
    setEnabled: (on: boolean) => Promise<PetStateSnapshot | null>
    setPack: (packId: string) => Promise<PetStateSnapshot | null>
    /** 用户素材包帧内容（data URL）；内置包由渲染层 vite 管线自带，不走这里 */
    getPackAssets: (packId: string) => Promise<PackAssets | null>
    /** 聊天 → 宠物脑（B 期接线；A 期渲染层用本地占位台词，不调用） */
    sendChat: (text: string) => Promise<PetSayPayload | null>
    setPersona: (text: string) => Promise<PetStateSnapshot | null>
    setAutonomy: (sec: number) => Promise<PetStateSnapshot | null>
    setPreset: (presetId: string, model?: string) => Promise<PetStateSnapshot | null>
    /** 缩放档切换（1/1.5/2）：主进程改窗体尺寸并广播快照 */
    setZoom: (zoom: number) => Promise<PetStateSnapshot | null>
    /** 投喂：好感/心情落 pet.json，返回新快照（吃动画由渲染层自播） */
    feed: (foodId: string) => Promise<PetStateSnapshot | null>
    /** 渲染层 → 主进程：窗体移动/拖拽/聊天开合/交互上报（fire-and-forget） */
    windowEvent: (event: PetWindowEvent) => void
    /** 主进程 → 渲染层：脑台词推送（自主发言/聊天回复的气泡播报） */
    onSay: (cb: (say: PetSayPayload) => void) => () => void
    /** 主进程 → 渲染层：快照广播（设置卡片与宠物窗同步） */
    onState: (cb: (snapshot: PetStateSnapshot) => void) => () => void
    /** 主进程 → 渲染层：拖拽期间窗体权威位置 */
    onDrag: (cb: (position: PetDragPosition) => void) => () => void
    /** 主进程 → 渲染层：松手抛掷初速（差分光标末速） */
    onThrown: (cb: (velocity: PetThrowVelocity) => void) => () => void
    /** 主进程 → 渲染层：素材包已切换，重载帧资源 */
    onPackChanged: (cb: () => void) => () => void
    /** 主进程 → 主窗：右键菜单「打开设置」聚焦设置页 */
    onOpenSettings: (cb: () => void) => () => void
  }
  skills: {
    list: () => Promise<{ root: string; skills: SkillMeta[] }>
    get: (name: string) => Promise<SkillDetail | null>
    save: (name: string, input: { description: string; body: string; originName?: string }) => Promise<SkillMeta>
    delete: (name: string) => Promise<IpcResult>
    import: (sourcePath: string) => Promise<SkillMeta>
    /** 从 git URL 直装：clone + 扫描 + 技能型资产全部导入共享库（入口在技能 tab） */
    installFromUrl: (ref: string) => Promise<SkillsFromUrlResult>
    /** 在线搜索 skills.sh 公共技能目录（发现区「skills.sh」来源；离线/超时返回空不报错） */
    searchOnline: (query: string, limit?: number, offset?: number) => Promise<{ entries: SkillsShEntry[]; total: number }>
    /** 从 skills.sh 条目安装：clone owner/repo 后定位 skillId 目录导入共享库 */
    installOnline: (entry: { skillId: string; owner: string; repo: string }) => Promise<{ name: string }>
    /** 浏览器打开外部链接（发现卡「查看 README」；仅允许 https） */
    openExternal: (url: string) => Promise<void>
    targets: () => Promise<{ targets: SkillTarget[]; states: Record<string, Record<string, SyncState>> }>
    install: (name: string, targetId: string) => Promise<IpcResult>
    uninstall: (name: string, targetId: string) => Promise<IpcResult>
    openDir: () => Promise<void>
  }
  mcp: {
    list: () => Promise<{ servers: McpMeta[] }>
    save: (def: { name: string; description: string; transport: McpTransport }, originName?: string) => Promise<McpMeta>
    delete: (name: string) => Promise<IpcResult>
    targets: () => Promise<{ targets: McpTarget[]; states: Record<string, Record<string, SyncState>> }>
    install: (name: string, targetId: string) => Promise<IpcResult>
    uninstall: (name: string, targetId: string) => Promise<IpcResult>
  }
  hooks: {
    list: () => Promise<{ hooks: HookMeta[] }>
    get: (name: string) => Promise<HookDetail | null>
    save: (name: string, input: { description: string; body: string; events: Record<string, HookGroup[]>; originName?: string }) => Promise<HookMeta>
    delete: (name: string) => Promise<IpcResult>
    targets: () => Promise<{ targets: HookTarget[]; states: Record<string, Record<string, SyncState>> }>
    install: (name: string, targetId: string) => Promise<IpcResult>
    uninstall: (name: string, targetId: string) => Promise<IpcResult>
  }
  plugins: {
    inventory: () => Promise<{ items: PluginInventoryItem[] }>
    setEnabled: (input: { cli: 'claude'; name: string; marketplace: string; enabled: boolean }) => Promise<IpcResult>
    openDir: (cli: 'claude' | 'zcode' | 'codex') => Promise<void>
    /** 安装插件（v1 仅 claude，借官方 CLI；spec = plugin@marketplace） */
    install: (input: { cli: 'claude'; spec: string }) => Promise<PluginCliResult>
    uninstall: (input: { cli: 'claude'; spec: string }) => Promise<PluginCliResult>
  }
  marketplaces: {
    status: () => Promise<MarketplaceStatus>
    /** 把源内发现的 marketplace.json 注册为 Claude/ZCode 市场（两侧成败独立返回） */
    register: (sourceId: string, assetPath: string) => Promise<MarketplaceRegisterResult>
    /** 读源内 marketplace.json 的插件清单（供浏览/筛选/逐项安装；installed 为 claude 侧交叉） */
    listPlugins: (sourceId: string, assetPath: string) => Promise<{ plugins: MarketplacePluginInfo[] }>
    /** 聚合已注册市场（AgentDeck 源 + claude/zcode 市场缓存）及其插件清单（入口在插件 tab） */
    listRegistered: () => Promise<{ marketplaces: RegisteredMarketplace[] }>
  }
  sources: {
    catalog: () => Promise<{ entries: CatalogEntry[] }>
    list: () => Promise<{ sources: ExtSourceMeta[] }>
    add: (ref: string, name?: string) => Promise<ExtSourceMeta>
    /** 从 URL 一键安装：addSource + 自动浏览，UI 收到后直接展开该源的资产面板 */
    quickAdd: (ref: string, name?: string) => Promise<{ source: ExtSourceMeta; assets: DiscoveredAsset[] }>
    remove: (id: string) => Promise<IpcResult>
    sync: (id: string) => Promise<ExtSourceMeta>
    browse: (id: string) => Promise<{ assets: DiscoveredAsset[] }>
    /** 聚合所有已添加源的技能资产（技能 tab「发现」区，按源分组） */
    listSkills: () => Promise<{ groups: SkillDiscoveryGroup[] }>
    importSkill: (id: string, relPath: string) => Promise<{ name: string }>
  }
  updates: {
    getState: () => Promise<UpdateStateSnapshot>
    check: () => Promise<UpdateStateSnapshot>            // 手动检查（两通道，串行）
    apply: (channel: UpdateChannel) => Promise<IpcResult>
    /** 一键更新：按 renderer→payload→shell 顺序编排（壳只 staging，确认仍走 apply('shell')） */
    applyAll: () => Promise<IpcResult>
    rollback: (channel: UpdateChannel) => Promise<IpcResult>  // 指针回退上一保留版本
    onState: (cb: (snapshot: UpdateStateSnapshot) => void) => () => void
  }
}

export type UpdateChannel = 'renderer' | 'payload' | 'shell'
export type UpdatePhase = 'idle' | 'checking' | 'downloading' | 'verifying' | 'staged' | 'applying' | 'failed'

export interface UpdateStateSnapshot {
  phase: UpdatePhase
  channel: UpdateChannel | null
  progress?: { receivedBytes: number; totalBytes: number }
  currentVersion: string          // 生效版本（载荷优先，否则壳版本）
  stagedVersion?: string          // 已就绪待应用（空闲门控挂起时）
  activeRendererVersion?: string  // L2 指针生效中的版本（诊断用）
  /** 各通道可更新到的 feed 版本（check 后填充；无则不出现）*/
  available?: { renderer?: string; payload?: string; shell?: string }
  error?: string
}
