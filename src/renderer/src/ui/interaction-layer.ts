/**
 * 交互层（浮层）纯逻辑：无 React、无 DOM 依赖，供 useInteractionLayer 与交互中心/冒烟测试共用。
 *
 * 一个「层」= 一次浮层生命周期（Confirm / Palette / Menu / FloatWindow / 页面内模态）。
 * 约定：
 * - Escape 只由**最上层**消费（多个浮层叠加时按后进先出）；
 * - 外点关闭只作用于最上层且声明了 onOutside 的层；
 * - 焦点陷阱只由**最上层声明 trap 的层**执行（菜单浮在模态之上时，模态仍负责 Tab 循环）；
 * - 视觉 z 轴 = 层序（`layerZIndex`），模态屏障（`blocks`）挡住它下面的指针与焦点。
 */
export type LayerKind = 'modal' | 'popover' | 'window'

/* ------------------------------------------------------- 视觉 z 轴 = 层序 */

/**
 * 层序 → 视觉 z-index：**后开的层一定画在先生开的之上**。
 * 基准 70 高于页面内所有非浮层装饰（.ws-menu / .menu-panel 60、页头 2、页签 7 等），
 * 低于 .toast-host(90)——通知不是浮层，模态开着也该看得见。
 * 模态与「浮在模态之上的嵌套菜单」的相对关系因此自动成立，不需要为 kind 分档。
 */
export const LAYER_Z_BASE = 70
export const LAYER_Z_STEP = 1

export function layerZIndex(order: number): number {
  return LAYER_Z_BASE + Math.max(0, Math.trunc(order)) * LAYER_Z_STEP
}

export interface LayerRecord {
  id: number
  kind: LayerKind
  /** 层名（'palette' / 'confirm' / 'menu' / 'modal' …）：快捷键解析据此判断当前浮层 */
  name: string
  trap: boolean
  onEscape?: () => void
  onOutside?: () => void
  /** 命中判定：外点关闭用 */
  contains?: (node: unknown) => boolean
  /** 本层根节点（可空）：判断焦点是否还留在某个浮层内 */
  root?: unknown
}

export type LayerInput = Omit<LayerRecord, 'id' | 'trap'> & { trap?: boolean }

export interface LayerStack {
  subscribe(listener: () => void): () => void
  /** 压入一层，返回层 id（release 用） */
  push(layer: LayerInput): number
  /** 卸载一层；不存在返回 false */
  release(id: number): boolean
  top(): LayerRecord | null
  topModal(): LayerRecord | null
  topName(): string | null
  /** 是否有任何浮层打开（快捷键据此让路） */
  hasOpen(): boolean
  isTop(id: number): boolean
  /** 自己是不是「最上层声明 trap 的层」——决定 Tab 是否循环 */
  isTopTrap(id: number): boolean
  size(): number
  /** 把 Escape 交给最上层；无人消费返回 false */
  escape(): boolean
  /** 把外点交给最上层（node 为事件目标）；无人消费返回 false */
  outside(node: unknown): boolean
  /** node 是否落在任一浮层内（层外焦点历史、焦点归还判定用） */
  containsNode(node: unknown): boolean
  /** 层在栈里的下标（0 最底）；层不存在返回 -1 */
  orderOf(id: number): number
  /** 该层该写的视觉 z-index（层不存在返回 0 = 不接管） */
  zIndexOf(id: number): number
  /**
   * 模态屏障：node 是否被「最上层模态」挡住。
   * 有模态、且 node 既不在该模态内、也不在它**之上**的浮层内 → true（背景不可交互）。
   * 指针拦截与焦点看守共用这一条判据，保证「逻辑层序 = 视觉层序 = 可交互层序」。
   */
  blocks(node: unknown): boolean
  reset(): void
}

/**
 * 触发焦点候选挑选（纯函数）：按优先级取第一个「可用」的元素。
 * 候选顺序由调用方给定：本次打开前抓到的触发元素 → 层外焦点历史 → 显式归还目标。
 */
export function pickRestoreTarget<T>(candidates: readonly (T | null | undefined)[], usable: (node: T) => boolean): T | null {
  for (const candidate of candidates) {
    if (candidate && usable(candidate)) return candidate
  }
  return null
}

export function createLayerStack(): LayerStack {
  const layers: LayerRecord[] = []
  const listeners = new Set<() => void>()
  const notify = () => { for (const listener of listeners) listener() }
  let nextId = 1
  const find = (id: number) => layers.findIndex((layer) => layer.id === id)
  /** 最上层模态的下标（模态之上可能还压着嵌套菜单）；无模态返回 -1 */
  const findTopModal = (): number => {
    for (let i = layers.length - 1; i >= 0; i--) if (layers[i].kind === 'modal') return i
    return -1
  }
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    push(layer) {
      const record: LayerRecord = { id: nextId++, kind: layer.kind, name: layer.name, trap: layer.trap === true, onEscape: layer.onEscape, onOutside: layer.onOutside, contains: layer.contains, root: layer.root }
      layers.push(record)
      notify()
      return record.id
    },
    release(id) {
      const index = find(id)
      if (index < 0) return false
      layers.splice(index, 1)
      notify()
      return true
    },
    top() {
      return layers[layers.length - 1] ?? null
    },
    topModal() {
      const index = findTopModal()
      return index < 0 ? null : layers[index]
    },
    topName() {
      return layers[layers.length - 1]?.name ?? null
    },
    hasOpen() {
      return layers.length > 0
    },
    isTop(id) {
      return layers[layers.length - 1]?.id === id
    },
    isTopTrap(id) {
      for (let i = layers.length - 1; i >= 0; i--) {
        if (layers[i].trap) return layers[i].id === id
      }
      return false
    },
    size() {
      return layers.length
    },
    escape() {
      const top = layers[layers.length - 1]
      if (!top?.onEscape) return false
      top.onEscape()
      return true
    },
    outside(node) {
      const top = layers[layers.length - 1]
      if (!top?.onOutside) return false
      if (top.contains?.(node)) return false
      top.onOutside()
      return true
    },
    containsNode(node) {
      return layers.some((layer) => layer.root != null && layer.contains?.(node) === true)
    },
    orderOf(id) {
      return find(id)
    },
    zIndexOf(id) {
      const index = find(id)
      return index < 0 ? 0 : layerZIndex(index)
    },
    blocks(node) {
      const modal = findTopModal()
      if (modal < 0) return false
      for (let i = modal; i < layers.length; i++) {
        if (layers[i].contains?.(node) === true) return false
      }
      return true
    },
    reset() {
      layers.length = 0
      notify()
    }
  }
}

/** 全局层栈：useInteractionLayer 与交互中心共用同一份（工厂可注入自己的栈做隔离测试） */
export const interactionLayers: LayerStack = createLayerStack()

/**
 * 焦点陷阱的目标下标：返回 null = 走浏览器默认 Tab 行为。
 * count<=0（层内没有可聚焦元素）返回 null，由调用方兜底聚焦容器。
 */
export function trapTargetIndex(count: number, index: number, shift: boolean): number | null {
  if (count <= 0) return null
  if (index < 0 || index >= count) return shift ? count - 1 : 0
  if (shift && index === 0) return count - 1
  if (!shift && index === count - 1) return 0
  return null
}

/** 可聚焦元素选择器（焦点陷阱与首焦点兜底共用） */
export const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',')
