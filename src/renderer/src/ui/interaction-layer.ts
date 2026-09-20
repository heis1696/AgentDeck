/**
 * 交互层（浮层）纯逻辑：无 React、无 DOM 依赖，供 useInteractionLayer 与交互中心/冒烟测试共用。
 *
 * 一个「层」= 一次浮层生命周期（Confirm / Palette / Menu / FloatWindow / 页面内模态）。
 * 约定：
 * - Escape 只由**最上层**消费（多个浮层叠加时按后进先出）；
 * - 外点关闭只作用于最上层且声明了 onOutside 的层；
 * - 焦点陷阱只由**最上层声明 trap 的层**执行（菜单浮在模态之上时，模态仍负责 Tab 循环）。
 */
export type LayerKind = 'modal' | 'popover' | 'window'

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
  /** 压入一层，返回层 id（release 用） */
  push(layer: LayerInput): number
  /** 卸载一层；不存在返回 false */
  release(id: number): boolean
  top(): LayerRecord | null
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
  let nextId = 1
  const find = (id: number) => layers.findIndex((layer) => layer.id === id)
  return {
    push(layer) {
      const record: LayerRecord = { id: nextId++, kind: layer.kind, name: layer.name, trap: layer.trap === true, onEscape: layer.onEscape, onOutside: layer.onOutside, contains: layer.contains, root: layer.root }
      layers.push(record)
      return record.id
    },
    release(id) {
      const index = find(id)
      if (index < 0) return false
      layers.splice(index, 1)
      return true
    },
    top() {
      return layers[layers.length - 1] ?? null
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
    reset() {
      layers.length = 0
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
