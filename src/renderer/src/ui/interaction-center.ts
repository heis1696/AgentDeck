/**
 * 交互中心（ui/interaction-center）——渲染层**唯一**的界面交互入口。
 *
 * 设计约束（本文件即契约）：
 * 1. 无视图依赖：不 import React、不读 DOM/window；React 宿主用 hooks/useInteraction 订阅快照。
 *    → 纯函数 + 内存状态，可在 Node 里直接跑冒烟（scripts/smoke-ui-interaction-center.mjs）。
 * 2. 单一权威：navigate / openTask / closeTab / cycleTab / openSettings / palette / focusComposer /
 *    toast / confirm / dock.open·update·close 全部收敛到中心；旧模块导出（ui/Toasts、ui/Confirm、
 *    ui/SideDock、WorkspaceView.FOCUS_WORKSPACE）保留为兼容转发。
 * 3. 状态跨挂载保留：任务目录、页签、dock 分页、composer 请求、toast 队列、confirm 队列都存在中心，
 *    宿主卸载只是取消订阅，不丢状态（与「组件卸载=状态清零」的旧实现相反）。
 * 4. 任务执行不走这里：start/cancel/retry/delete/…仍由 task-service 负责，中心只做界面交互。
 */
import { interactionLayers, type LayerStack } from './interaction-layer'

export type UiView = 'issues' | 'detail' | 'usage' | 'settings' | 'automation' | 'skills' | 'board' | 'agents'
export const UI_VIEWS: readonly UiView[] = ['issues', 'detail', 'usage', 'settings', 'automation', 'skills', 'board', 'agents']
/** 顶部页签上限（超出后淘汰最旧） */
export const MAX_OPEN_TABS = 8
/** toast 存活时长与同屏上限（与旧 Toasts.tsx 行为一致） */
export const TOAST_TTL_MS = 4200
export const MAX_VISIBLE_TOASTS = 4

/** 中心只需要任务目录里的这三列（与 shared/types 的 Task 结构兼容） */
export interface CenterTask { id: string; title: string; parentTaskId?: string | null }

/* ---------------------------------------------------------------- dock */

export interface DockEditMetadata {
  file: string
  additions: number
  deletions: number
  content?: string
  oldString?: string
  newString?: string
  truncated?: boolean
}
/** file 项的 git 权威 diff 通道（tasks:fileDiff 返回；clean/失败时缺省回退参数快照） */
export interface DockFileDiff {
  diff?: string
  additions?: number
  deletions?: number
  diffNote?: string
  binary?: boolean
}
export type DockItem =
  | { id: string; kind: 'task'; title: string; payload: { taskId: string } }
  | { id: string; kind: 'file'; title: string; payload: DockEditMetadata & { taskId: string } & DockFileDiff }
export interface DockItemPatch {
  title?: string
  payload?: Partial<DockEditMetadata & DockFileDiff & { taskId: string }>
}
/** 分页项 + 打开请求标识：异步回写必须凭 token 命中同一次打开 */
export type DockEntry = DockItem & { token: number }
export interface DockBucket { items: readonly DockEntry[]; activeId: string | null }
export const EMPTY_DOCK_BUCKET: DockBucket = Object.freeze({ items: Object.freeze([]) as readonly DockEntry[], activeId: null })
/** dock.open 的返回值：异步 diff 回写时原样回传，禁止重开关闭页签 */
export interface DockHandle { id: string; token: number; rootId: string }

/* ------------------------------------------------------- toast / confirm */

export type ToastKind = 'info' | 'success' | 'error'
export interface ToastRecord { id: number; kind: ToastKind; text: string }

export interface ConfirmOptions {
  title: string
  body?: string
  /** 危险操作：确认按钮红色 */
  danger?: boolean
  confirmText?: string
  cancelText?: string
}
export interface ConfirmRequest extends ConfirmOptions { id: number }

/* ------------------------------------------------------------- shortcuts */

export type ShortcutAction = 'palette-toggle' | 'new-task' | 'close-tab' | 'cycle-tab-next' | 'cycle-tab-prev' | 'focus-composer'
export interface ShortcutTarget { tagName?: string; isContentEditable?: boolean }
export interface ShortcutInput {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  /** 输入法组合中（IME）：一律不抢键 */
  isComposing?: boolean
  /** 部分输入法只给 keyCode=229 */
  keyCode?: number
  target?: ShortcutTarget | null
}
export interface ShortcutContext {
  /** 当前最上层**模态**名（null = 无模态；菜单/浮窗等非模态层不算）：模态打开时快捷键让路 */
  overlay: string | null
}

export function isComposingKey(input: Pick<ShortcutInput, 'isComposing' | 'keyCode'>): boolean {
  return input.isComposing === true || input.keyCode === 229
}

/** 可编辑元素：标签是输入类或 contenteditable（IME 场景也不抢键） */
export function isEditableTarget(target: ShortcutTarget | null | undefined): boolean {
  if (!target) return false
  if (target.isContentEditable) return true
  const tag = (target.tagName ?? '').toUpperCase()
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

/**
 * 快捷键解析（纯函数）：
 * - IME 组合中 / keyCode 229 → 不处理；
 * - 有**模态**浮层（context.overlay = 最上层模态名，来自 layers.topModal()）：只允许
 *   「Ctrl+K 收起命令面板」，其余让给模态（Escape 由层栈处理）。非模态的浮窗/菜单
 *   （popover / window 层）不进 overlay——不能封锁页面快捷键；
 * - 焦点在可编辑元素：只保留全局命令面板 Ctrl+K，其余不抢键（Ctrl+N/W/Tab 与裸键都不抢）；
 * - 无模态、非可编辑：Ctrl+K 面板、Ctrl+N 新建（聚焦输入框）、Ctrl+W 关闭当前页签、
 *   Ctrl(+Shift)+Tab 循环页签、裸 c 聚焦输入框。
 */
export function resolveShortcut(input: ShortcutInput, context: ShortcutContext): ShortcutAction | null {
  if (isComposingKey(input)) return null
  const key = (input.key ?? '').toLowerCase()
  const mod = input.ctrlKey === true || input.metaKey === true
  const paletteKey = mod && !input.altKey && key === 'k'
  if (context.overlay) return context.overlay === 'palette' && paletteKey ? 'palette-toggle' : null
  if (paletteKey) return 'palette-toggle'
  if (isEditableTarget(input.target)) return null
  if (mod && !input.altKey && key === 'n') return 'new-task'
  if (mod && !input.altKey && key === 'w') return 'close-tab'
  if (mod && key === 'tab') return input.shiftKey ? 'cycle-tab-prev' : 'cycle-tab-next'
  if (!mod && !input.altKey && key === 'c') return 'focus-composer'
  return null
}

/* ---------------------------------------------------------------- state */

export interface InteractionSnapshot {
  view: UiView
  activeId: string | null
  tabs: readonly string[]
  paletteOpen: boolean
  settingsSection: string
  /** 单调递增的「聚焦输入框」请求号：宿主挂载后对比已处理值即可消费，跨挂载不丢 */
  composerTick: number
  /** rootTaskId → 分页桶（按根任务隔离，跨挂载保留） */
  docks: Readonly<Record<string, DockBucket>>
  toasts: readonly ToastRecord[]
  /** 当前展示的确认框（FIFO 队首） */
  confirm: ConfirmRequest | null
  /** 排队等待的确认框数量（不含当前） */
  confirmPending: number
}

export const EMPTY_SNAPSHOT: InteractionSnapshot = Object.freeze({
  view: 'board' as UiView,
  activeId: null,
  tabs: Object.freeze([]) as readonly string[],
  paletteOpen: false,
  settingsSection: 'general',
  composerTick: 0,
  docks: Object.freeze({}) as Readonly<Record<string, DockBucket>>,
  toasts: Object.freeze([]) as readonly ToastRecord[],
  confirm: null,
  confirmPending: 0
})

export interface CenterTimers {
  set: (fn: () => void, ms: number) => unknown
  clear: (handle: unknown) => void
}

export interface InteractionCenterOptions {
  layers?: LayerStack
  timers?: CenterTimers
  toastTtlMs?: number
  now?: () => number
}

/** 根任务解析结果：broken=祖先链有环或缺节点（调用方按「普通任务」兜底） */
export interface RootResolution { rootId: string; isRoot: boolean; broken: boolean; depth: number }

export type OpenTaskRoute = 'tab' | 'dock' | 'ignored'

/* ------------------------------------------------- 祖先链解析（纯函数） */

/** 任务目录 → 查找表 */
export function taskCatalogOf(tasks: readonly CenterTask[]): Map<string, CenterTask> {
  return new Map(tasks.map((task) => [task.id, task]))
}

/** 沿 parentTaskId 上溯到根；缺节点或成环时 broken=true 并停在断点 */
export function resolveRootIn(catalog: ReadonlyMap<string, CenterTask>, id: string): RootResolution {
  const first = catalog.get(id)
  if (!first) return { rootId: id, isRoot: true, broken: false, depth: 0 }
  const seen = new Set<string>()
  let current = first
  let depth = 0
  while (current.parentTaskId) {
    if (seen.has(current.id)) return { rootId: current.id, isRoot: false, broken: true, depth }
    seen.add(current.id)
    const parent = catalog.get(current.parentTaskId)
    if (!parent) return { rootId: current.id, isRoot: false, broken: true, depth }
    current = parent
    depth++
  }
  return { rootId: current.id, isRoot: true, broken: false, depth }
}

/**
 * 该任务是否要「路由到领队详情 + dock 分页」（是则返回根任务 id，否则 null = 开普通顶部页签）。
 * 祖先链断裂（缺节点/成环）时返回 null：没有可路由的领队，只能按普通页签兜底。
 */
function dockRouteRootIdIn(catalog: ReadonlyMap<string, CenterTask>, id: string): string | null {
  if (!catalog.get(id)?.parentTaskId) return null
  const resolution = resolveRootIn(catalog, id)
  return !resolution.broken && resolution.isRoot && resolution.rootId !== id ? resolution.rootId : null
}

/**
 * 顶部页签条要显示的子集（纯函数，与 openTask 的路由判定同源）。
 * 只有「子任务且祖先链完整」的页签该隐藏（它们在领队详情的右侧分页里）；
 * 祖先链断裂（缺节点/成环）的任务走普通页签，必须照常显示。
 * 入参用界面侧**当前**的任务目录，避免依赖交互中心 effect 里的快照差一帧。
 */
export function rootTabsOf(tasks: readonly CenterTask[], tabs: readonly string[]): string[] {
  const catalog = taskCatalogOf(tasks)
  return tabs.filter((id) => dockRouteRootIdIn(catalog, id) === null)
}

export interface InteractionCenter {
  subscribe(listener: () => void): () => void
  getState(): InteractionSnapshot
  /** 最新任务目录（祖先链解析、删除清理的唯一依据） */
  setTasks(tasks: readonly CenterTask[]): void
  tasks(): readonly CenterTask[]
  /** 目录是否已就绪（宿主首次 setTasks 前，openTask/dock 只能乐观兜底并记待决） */
  isCatalogReady(): boolean
  rootTaskId(id: string): string
  resolveRoot(id: string): RootResolution
  /**
   * 顶部页签条是否显示该任务（与 openTask 的路由判定同源）：
   * 只有「子任务且祖先链完整」的页签该隐藏（它们在领队详情的 dock 里）；
   * 祖先链断裂（缺节点/成环）的任务走普通页签，必须显示。
   */
  isRootTab(id: string): boolean
  activeRootId(): string | null
  navigate(view: UiView): void
  openTask(id: string): OpenTaskRoute
  closeTab(id: string): void
  cycleTab(step: number): string | null
  openSettings(section?: string): void
  focusComposer(): void
  palette: { open(): void; close(): void; toggle(): void; set(open: boolean): void }
  toast: { info(text: string): number; success(text: string): number; error(text: string): number; dismiss(id: number): void; attach(): void; detach(): void; clear(): void }
  confirm(options: ConfirmOptions): Promise<boolean>
  confirmHost: { respond(value: boolean): boolean; cancelAll(): void }
  dock: {
    open(item: DockItem, opts?: { rootId?: string }): DockHandle
    /** 仅切换激活项（不改打开请求标识：进行中的异步回写仍然有效） */
    activate(id: string, opts?: { rootId?: string }): boolean
    /** 异步回写：仅当同一打开请求的同一项仍存在时生效；绝不重开关闭的页签 */
    update(handle: DockHandle, patch: DockItemPatch): boolean
    close(id: string, opts?: { rootId?: string }): boolean
    clear(rootId?: string): void
    state(rootId: string): DockBucket
  }
  /** 解析并执行快捷键；返回已执行的动作用于 preventDefault（未处理返回 null） */
  handleKey(input: ShortcutInput): ShortcutAction | null
  /** 测试/热重置用：清空状态与队列 */
  reset(): void
}

export function createInteractionCenter(options: InteractionCenterOptions = {}): InteractionCenter {
  const layers = options.layers ?? interactionLayers
  const timers: CenterTimers = options.timers ?? {
    set: (fn, ms) => globalThis.setTimeout(fn, ms),
    clear: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>)
  }
  const toastTtlMs = options.toastTtlMs ?? TOAST_TTL_MS

  let state: InteractionSnapshot = EMPTY_SNAPSHOT
  const listeners = new Set<() => void>()
  let catalog = new Map<string, CenterTask>()
  /** 目录是否已就绪：宿主第一次 setTasks 前，渲染层没有任何任务信息（区分「目录未加载」与「已加载缺失」） */
  let catalogReady = false
  /**
   * 待决路由：openTask 时目录里还查不到的任务 id（乐观按普通页签兜底）。
   * 目录到达后由 setTasks 重路由——存在且祖先链完整 → 根详情 + dock 桶；仍缺失 → 页签随剪枝摘掉。
   * 用户主动关掉的待决页签从这里除名，目录到达后绝不借重定向复活。
   */
  const pendingOpens = new Set<string>()

  const emit = (patch: Partial<InteractionSnapshot>): void => {
    state = { ...state, ...patch }
    for (const listener of listeners) listener()
  }

  /* ------------------------------------------------------------ toast */
  let toastAttached = false
  let nextToastId = 1
  const toastTimers = new Map<number, unknown>()

  const clearToastTimer = (id: number): void => {
    const handle = toastTimers.get(id)
    if (handle === undefined) return
    toastTimers.delete(id)
    timers.clear(handle)
  }
  const dropToast = (id: number): void => {
    clearToastTimer(id)
    if (!state.toasts.some((item) => item.id === id)) return
    emit({ toasts: state.toasts.filter((item) => item.id !== id) })
  }
  const armToastTimer = (id: number): void => {
    if (!toastAttached || toastTimers.has(id)) return
    toastTimers.set(id, timers.set(() => dropToast(id), toastTtlMs))
  }
  const pushToast = (kind: ToastKind, text: string): number => {
    const record: ToastRecord = { id: nextToastId++, kind, text }
    const toasts = [...state.toasts, record].slice(-MAX_VISIBLE_TOASTS)
    const evicted = state.toasts.filter((item) => !toasts.includes(item))
    emit({ toasts })
    for (const item of evicted) clearToastTimer(item.id)
    armToastTimer(record.id)
    return record.id
  }

  /* ---------------------------------------------------------- confirm */
  let nextConfirmId = 1
  const confirmQueue: ConfirmRequest[] = []
  const confirmResolvers = new Map<number, (value: boolean) => void>()

  const settleConfirm = (request: ConfirmRequest | null, value: boolean): void => {
    if (!request) return
    const resolve = confirmResolvers.get(request.id)
    confirmResolvers.delete(request.id)
    resolve?.(value)
  }

  /* --------------------------------------------------------------- dock */
  let nextDockToken = 1

  const bucketOf = (rootId: string): DockBucket => state.docks[rootId] ?? EMPTY_DOCK_BUCKET
  const findBucketId = (id: string): string | null => {
    for (const [rootId, bucket] of Object.entries(state.docks)) {
      if (bucket.items.some((item) => item.id === id)) return rootId
    }
    return null
  }

  /* -------------------------------------------------------- navigation */
  const resolveRoot = (id: string): RootResolution => resolveRootIn(catalog, id)

  const activateTab = (id: string): void => {
    const tabs = state.tabs.includes(id) ? state.tabs : [...state.tabs, id].slice(-MAX_OPEN_TABS)
    emit({ tabs, activeId: id })
  }

  /** 与 ui/isRootTab 同源：见 dockRouteRootIdIn（祖先链断裂 → 普通页签兜底） */
  const dockRouteRootId = (id: string): string | null => dockRouteRootIdIn(catalog, id)

  const openTask = (id: string): OpenTaskRoute => {
    if (!id) return 'ignored'
    const routeRootId = dockRouteRootId(id)
    if (routeRootId) {
      // 祖先链完整且根不是自己 → 子任务不开顶部页签：路由到根详情并在其 dock 桶里打开
      pendingOpens.delete(id)
      activateTab(routeRootId)
      emit({ view: 'detail' })
      api.dock.open({ id: `task:${id}`, kind: 'task', title: catalog.get(id)?.title ?? id, payload: { taskId: id } }, { rootId: routeRootId })
      return 'dock'
    }
    activateTab(id)
    emit({ view: 'detail' })
    // 目录里还没有的 id：祖先链与存在性都未知（目录未加载，或已加载但这份快照还没有它——
    // 刚创建的任务/主进程刚派发的 focus 事件）。先按普通页签兜底让导航成立，并记为待决；
    // 目录到达后 setTasks 按真实祖先链重定向，或确认缺失后摘除。
    if (catalog.has(id)) pendingOpens.delete(id)
    else pendingOpens.add(id)
    return 'tab'
  }

  const closeTab = (id: string): void => {
    if (!state.tabs.includes(id)) return
    // 用户关掉的待决页签先除名：目录到达后不得借重定向复活（与 dock 项「关闭不复活」同纪律）
    pendingOpens.delete(id)
    const tabs = state.tabs.filter((tab) => tab !== id)
    const activeId = state.activeId === id ? tabs[tabs.length - 1] ?? null : state.activeId
    const view = state.view === 'detail' && !activeId ? 'issues' : state.view
    emit({ tabs, activeId, view })
  }

  const cycleTab = (step: number): string | null => {
    const tabs = state.tabs
    if (tabs.length < 2) return state.activeId
    const index = tabs.indexOf(state.activeId ?? '')
    const delta = step < 0 ? -1 : 1
    const next = tabs[((index + delta) + tabs.length) % tabs.length]
    emit({ activeId: next })
    return next
  }

  /**
   * 目录到达：三步收敛——
   * 1. 迁移键错了的 dock 桶（目录未加载时的自键兜底）；
   * 2. 重路由待决的 openTask（乐观普通页签 → 真实祖先链路由）；
   * 3. 按目录剪枝页签/活动项/dock 桶（删除的任务不保留）。
   */
  const setTasks = (tasks: readonly CenterTask[]): void => {
    catalog = new Map(tasks.map((task) => [task.id, task]))
    catalogReady = true
    migrateDockBuckets()
    reconcilePendingOpens()
    pruneByCatalog()
  }

  /**
   * 目录未加载时 dock.open 只能按 payload.taskId 自键兜底；目录到达后发现该任务其实是
   * 「祖先链完整的子任务」时，整桶并入真正根任务的桶。存活项原样搬家（token 不变 →
   * 旧 handle 凭 id 重新定位后仍可回写）；同 id 冲突保留根桶现存项；已关闭的项不在任何
   * 桶里，绝不因此复活。
   */
  const migrateDockBuckets = (): void => {
    const moves = new Map<string, string>()
    for (const key of Object.keys(state.docks)) {
      const routeRootId = dockRouteRootIdIn(catalog, key)
      if (routeRootId) moves.set(key, routeRootId)
    }
    if (!moves.size) return
    const docks: Record<string, DockBucket> = { ...state.docks }
    for (const [wrongKey, rightRoot] of moves) {
      const source = docks[wrongKey]
      if (!source) continue
      const target = docks[rightRoot] ?? { items: [] as readonly DockEntry[], activeId: null }
      const items = [...target.items]
      for (const item of source.items) {
        if (!items.some((current) => current.id === item.id)) items.push(item)
      }
      const activeId = target.activeId && items.some((item) => item.id === target.activeId)
        ? target.activeId
        : source.activeId && items.some((item) => item.id === source.activeId)
          ? source.activeId
          : items[0]?.id ?? null
      docks[rightRoot] = { items, activeId }
      delete docks[wrongKey]
    }
    emit({ docks })
  }

  /**
   * 待决路由收敛：openTask 时目录里查不到的任务，按目录到达后的真实祖先链重定向——
   * 存在且祖先链完整 → 撤掉乐观页签，路由到根详情 + dock 桶（桶里已有同 id 项——例如
   * 自键兜底刚迁移过来的——只激活不重开，保留原打开请求标识，旧 handle 继续有效）；
   * 是根任务/断链祖先 → 普通页签即终态；仍缺失 → 待决解除，乐观页签交给剪枝摘掉
   * （一份快照内没能确认存在的乐观页签不留）。
   */
  const reconcilePendingOpens = (): void => {
    if (!pendingOpens.size) return
    for (const id of [...pendingOpens]) {
      pendingOpens.delete(id)
      if (!catalog.has(id)) continue
      const routeRootId = dockRouteRootIdIn(catalog, id)
      if (!routeRootId) continue
      const dockId = `task:${id}`
      // 撤掉乐观页签，换成根任务页签并激活（子任务不再占顶部页签条）
      emit({ tabs: state.tabs.filter((tab) => tab !== id) })
      activateTab(routeRootId)
      emit({ view: 'detail' })
      // 根桶里已有同 id 项（自键兜底刚迁移过来的）只激活不重开：保留原打开请求标识，旧 handle 继续有效
      if (state.docks[routeRootId]?.items.some((item) => item.id === dockId)) api.dock.activate(dockId, { rootId: routeRootId })
      else api.dock.open({ id: dockId, kind: 'task', title: catalog.get(id)?.title ?? id, payload: { taskId: id } }, { rootId: routeRootId })
    }
  }

  /** 按目录剪枝：删除的任务连页签/活动项/dock 桶一起收掉（原 setTasks 尾部语义不变） */
  const pruneByCatalog = (): void => {
    const tabs = state.tabs.filter((id) => catalog.has(id))
    let activeId = state.activeId
    if (activeId && !catalog.has(activeId)) activeId = tabs[tabs.length - 1] ?? null
    // 分页桶按根任务存放：根任务没了整桶清掉；桶内项指向的任务没了则剪掉
    let docksChanged = false
    const docks: Record<string, DockBucket> = {}
    for (const [rootId, bucket] of Object.entries(state.docks)) {
      if (!catalog.has(rootId)) { docksChanged = true; continue }
      const items = bucket.items.filter((item) => catalog.has(item.payload.taskId))
      if (items.length !== bucket.items.length) {
        docksChanged = true
        const active = items.some((item) => item.id === bucket.activeId) ? bucket.activeId : items[0]?.id ?? null
        docks[rootId] = { items, activeId: active }
      } else {
        docks[rootId] = bucket
      }
    }
    const patch: Partial<InteractionSnapshot> = {}
    if (tabs.length !== state.tabs.length || tabs.some((id, index) => state.tabs[index] !== id)) patch.tabs = tabs
    if (activeId !== state.activeId) patch.activeId = activeId
    if (state.view === 'detail' && !activeId) patch.view = 'issues'
    if (docksChanged) patch.docks = docks
    if (Object.keys(patch).length) emit(patch)
  }

  const api: InteractionCenter = {
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getState: () => state,
    setTasks,
    tasks: () => [...catalog.values()],
    isCatalogReady: () => catalogReady,
    rootTaskId: (id) => resolveRoot(id).rootId,
    resolveRoot,
    isRootTab: (id) => dockRouteRootId(id) === null,
    activeRootId: () => (state.activeId ? resolveRoot(state.activeId).rootId : null),
    navigate: (view) => { if (UI_VIEWS.includes(view)) emit({ view }) },
    openTask,
    closeTab,
    cycleTab,
    openSettings: (section) => emit(section ? { view: 'settings', settingsSection: section } : { view: 'settings' }),
    focusComposer: () => emit({ view: 'issues', composerTick: state.composerTick + 1 }),
    palette: {
      open: () => emit({ paletteOpen: true }),
      close: () => emit({ paletteOpen: false }),
      toggle: () => emit({ paletteOpen: !state.paletteOpen }),
      set: (open) => emit({ paletteOpen: open })
    },
    toast: {
      info: (text) => pushToast('info', text),
      success: (text) => pushToast('success', text),
      error: (text) => pushToast('error', text),
      dismiss: dropToast,
      /** 宿主挂载：给排队中的 toast 补上定时器 */
      attach: () => {
        toastAttached = true
        for (const item of state.toasts) armToastTimer(item.id)
      },
      /** 宿主卸载：清掉全部定时器（条目留在队列里，重挂载后重新计时） */
      detach: () => {
        toastAttached = false
        for (const id of [...toastTimers.keys()]) clearToastTimer(id)
      },
      clear: () => {
        for (const id of [...toastTimers.keys()]) clearToastTimer(id)
        if (state.toasts.length) emit({ toasts: [] })
      }
    },
    confirm: (confirmOptions) => {
      const request: ConfirmRequest = { id: nextConfirmId++, ...confirmOptions }
      return new Promise<boolean>((resolve) => {
        confirmResolvers.set(request.id, resolve)
        if (!state.confirm) emit({ confirm: request })
        else { confirmQueue.push(request); emit({ confirmPending: confirmQueue.length }) }
      })
    },
    confirmHost: {
      respond: (value) => {
        const active = state.confirm
        if (!active) return false
        settleConfirm(active, value)
        const next = confirmQueue.shift() ?? null
        emit({ confirm: next, confirmPending: confirmQueue.length })
        return true
      },
      /** 宿主卸载：当前 + 排队的全部按「取消」结算，不留悬空 Promise */
      cancelAll: () => {
        settleConfirm(state.confirm, false)
        for (const request of confirmQueue.splice(0, confirmQueue.length)) settleConfirm(request, false)
        if (state.confirm || state.confirmPending) emit({ confirm: null, confirmPending: 0 })
      }
    },
    dock: {
      open: (item, opts) => {
        const rootId = opts?.rootId ?? resolveRoot(item.payload.taskId).rootId
        const entry: DockEntry = { ...item, token: nextDockToken++ }
        const bucket = bucketOf(rootId)
        const exists = bucket.items.some((current) => current.id === item.id)
        const items = exists
          ? bucket.items.map((current) => (current.id === item.id ? entry : current))
          : [...bucket.items, entry]
        emit({ docks: { ...state.docks, [rootId]: { items, activeId: item.id } } })
        return { id: item.id, token: entry.token, rootId }
      },
      activate: (id, opts) => {
        const rootId = opts?.rootId ?? findBucketId(id)
        const bucket = rootId ? state.docks[rootId] : undefined
        if (!rootId || !bucket || !bucket.items.some((item) => item.id === id)) return false
        if (bucket.activeId === id) return true
        emit({ docks: { ...state.docks, [rootId]: { items: bucket.items, activeId: id } } })
        return true
      },
      update: (handle, patch) => {
        // 先按 handle.rootId 定位；桶可能已被目录到达后的迁移搬到别的根桶——按 id 全局找，
        // 找到后把 handle 重定向到新桶（旧 handle 继续有效）。找不到 = 项已关闭：绝不复活。
        const pinned = state.docks[handle.rootId]
        let rootId = handle.rootId
        let index = pinned?.items.findIndex((item) => item.id === handle.id) ?? -1
        if (index < 0) {
          for (const [candidateRootId, bucket] of Object.entries(state.docks)) {
            const candidateIndex = bucket.items.findIndex((item) => item.id === handle.id)
            if (candidateIndex >= 0) {
              rootId = candidateRootId
              handle.rootId = candidateRootId
              index = candidateIndex
              break
            }
          }
        }
        if (index < 0) return false
        const bucket = state.docks[rootId]
        if (!bucket) return false
        const current = bucket.items[index]
        // 打开请求标识不一致 = 该项已被关闭后重新打开（或来自更早的打开），旧异步结果作废
        if (current.token !== handle.token) return false
        const items = bucket.items.slice()
        items[index] = {
          ...current,
          title: patch.title ?? current.title,
          payload: { ...current.payload, ...(patch.payload ?? {}) }
        } as DockEntry
        emit({ docks: { ...state.docks, [rootId]: { items, activeId: bucket.activeId } } })
        return true
      },
      close: (id, opts) => {
        const rootId = opts?.rootId ?? findBucketId(id)
        if (!rootId) return false
        const bucket = state.docks[rootId]
        if (!bucket) return false
        const index = bucket.items.findIndex((item) => item.id === id)
        if (index < 0) return false
        const items = bucket.items.filter((item) => item.id !== id)
        const activeId = bucket.activeId === id ? items[Math.min(index, items.length - 1)]?.id ?? null : bucket.activeId
        emit({ docks: { ...state.docks, [rootId]: { items, activeId } } })
        return true
      },
      clear: (rootId) => {
        if (!rootId) {
          if (!Object.keys(state.docks).length) return
          emit({ docks: {} })
          return
        }
        if (!state.docks[rootId]) return
        const docks = { ...state.docks }
        delete docks[rootId]
        emit({ docks })
      },
      state: (rootId) => bucketOf(rootId)
    },
    handleKey: (input) => {
      // 只看最上层**模态**（layers.topModal）：菜单/浮窗等非模态层不封锁页面快捷键，
      // 模态（面板/确认框/各页表单）打开时才整体让路。
      const action = resolveShortcut(input, { overlay: layers.topModal()?.name ?? null })
      if (!action) return null
      switch (action) {
        case 'palette-toggle': api.palette.toggle(); return action
        case 'new-task':
        case 'focus-composer': api.focusComposer(); return action
        case 'close-tab': {
          const active = state.activeId
          if (!active) return null
          api.closeTab(active)
          return action
        }
        case 'cycle-tab-next': {
          if (state.tabs.length < 2) return null
          api.cycleTab(1)
          return action
        }
        case 'cycle-tab-prev': {
          if (state.tabs.length < 2) return null
          api.cycleTab(-1)
          return action
        }
        default: return null
      }
    },
    reset: () => {
      for (const id of [...toastTimers.keys()]) clearToastTimer(id)
      toastAttached = false
      nextToastId = 1
      for (const request of confirmQueue.splice(0, confirmQueue.length)) settleConfirm(request, false)
      settleConfirm(state.confirm, false)
      confirmResolvers.clear()
      nextConfirmId = 1
      nextDockToken = 1
      catalog = new Map()
      catalogReady = false
      pendingOpens.clear()
      state = EMPTY_SNAPSHOT
      for (const listener of listeners) listener()
    }
  }
  return api
}

/** 应用单例：所有业务调用与旧导出转发都指向它 */
export const ui: InteractionCenter = createInteractionCenter()
