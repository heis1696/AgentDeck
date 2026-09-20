import { useLayoutEffect, useRef, type MutableRefObject, type RefObject } from 'react'
import { FOCUSABLE_SELECTOR, interactionLayers, pickRestoreTarget, trapTargetIndex, type LayerKind } from '../ui/interaction-layer'
import { isComposingKey } from '../ui/interaction-center'

export interface InteractionLayerOptions<T extends HTMLElement = HTMLElement> {
  open: boolean
  /** Escape / 外点关闭的统一回调 */
  onClose?: () => void
  kind?: LayerKind
  /** 层名：交互中心的快捷键解析据此判断「当前浮层」 */
  name?: string
  /** 模态：Tab 在层内循环（焦点陷阱） */
  trap?: boolean
  /** 层外 mousedown 关闭（下拉菜单/弹层） */
  closeOnOutside?: boolean
  /** 关闭时把焦点还给打开前的元素（默认 true） */
  restoreFocus?: boolean
  /**
   * 显式归还目标（触发元素会随打开动作被替换/卸载时兜底，
   * 例如「标题 → 就地编辑框」这种把触发按钮一起换掉的场景）。
   */
  restoreFocusRef?: RefObject<HTMLElement | null>
  /** 打开时的首焦点；缺省聚焦层内第一个可聚焦元素 */
  initialFocusRef?: RefObject<HTMLElement | null>
  /** 打开时是否搬焦点（默认 true）；下拉类浮层保持触发器焦点时传 false */
  autoFocus?: boolean
  /** 调用方自带的层根 ref；缺省用内部 ref（用返回值挂到容器上） */
  layerRef?: RefObject<T>
}

function focusableWithin(root: HTMLElement | null): HTMLElement[] {
  if (!root) return []
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
    .filter((node) => node.tabIndex >= 0 && !node.hasAttribute('disabled') && node.getAttribute('aria-hidden') !== 'true' && node.getClientRects().length > 0)
}

const isElement = (node: unknown): node is HTMLElement => node instanceof HTMLElement
/** 能当归还目标：还挂在文档里，且不是 body/html 这种「焦点无处可去」的兜底 */
const isRestorable = (node: HTMLElement): boolean =>
  node.isConnected && node !== document.body && node !== document.documentElement

/**
 * 视觉 z 轴跟随层序：把层栈算出的 z-index 写成层根的内联样式（压过样式表里的静态值）。
 * 约定：层根必须是**定位元素**（.overlay/fixed、.float-window/absolute、.menu-root/relative…），
 * 静态元素本来就不参与 z 轴排序；这里刻意不动 position，免得把样式表的 fixed/absolute 改坏。
 */
function applyLayerZIndex(root: HTMLElement | null, z: number): void {
  if (root && z > 0) root.style.zIndex = String(z)
}

/** 指针屏障要拦的事件：按下、点击、右键、双击——覆盖所有「点到背景」的路径 */
const POINTER_BARRIER_EVENTS = ['pointerdown', 'mousedown', 'click', 'dblclick', 'contextmenu'] as const

/* --------------------------------------------------- 层外焦点历史（兜底） */

/**
 * 最近一次「焦点落在所有浮层之外」的元素。
 * 渲染期快照不可用时（打开瞬间焦点已丢到 body、层由程序化状态变更打开等）用它兜底，
 * 保证关闭后仍有合理的归还目标。首个浮层挂载时绑一次 focusin 捕获监听。
 */
let outsideFocus: HTMLElement | null = null
let outsideFocusBound = false
const noteOutsideFocus = (event: FocusEvent): void => {
  const target = event.target
  if (!isElement(target)) return
  if (interactionLayers.containsNode(target)) return
  outsideFocus = target
}
function bindOutsideFocusHistory(): void {
  if (outsideFocusBound) return
  outsideFocusBound = true
  document.addEventListener('focusin', noteOutsideFocus, true)
}

/** 测试用：清掉模块级焦点历史（用例之间复位，避免相互串味） */
export function resetOutsideFocusHistory(): void {
  outsideFocus = null
}

/**
 * 渲染期抓「谁在打开浮层之前持有焦点」。
 * 跳过本层内元素：那多半是上一次打开留下的浮层内容，不是本次的触发者。
 */
function captureTrigger(layerRoot: HTMLElement | null): HTMLElement | null {
  const active = document.activeElement
  if (isElement(active) && active !== document.body && active !== document.documentElement && !layerRoot?.contains(active)) return active
  return outsideFocus && isRestorable(outsideFocus) ? outsideFocus : null
}

/**
 * 统一浮层行为：最上层 Escape、外点关闭、模态焦点陷阱、关闭后焦点归还。
 * 所有浮层（Confirm / Palette / Menu / FloatWindow / 页面内模态）共用同一套语义，
 * 叠加时只有最上层响应 Escape，Tab 循环归「最上层声明 trap 的层」。
 *
 * 层栈一致性（视觉 / Escape / 指针 / 焦点同一条序）：
 * - 视觉：入栈时把层序换算成 z-index 写进层根内联样式，后开的层一定画在先生开的之上；
 * - Escape / 外点：仍只由最上层消费；
 * - 指针 / 焦点：有模态时，落在「最上层模态及其上方浮层」之外的事件被捕获阶段截断，
 *   背景（含非模态浮窗、信息弹层）在模态开着时收不到点击，也拿不到焦点；
 * - IME：组合中的 Escape/Tab（isComposing 或 keyCode 229）一律放行给输入法。
 *
 * 触发焦点记录（本 hook 的关键约定）：
 * 1. 在**渲染期**（open 由 false→true 的那次 render）读 `document.activeElement`——
 *    React 这时还没提交 DOM、更没跑 `autoFocus`（发生在 commitMount 布局阶段），
 *    所以抓到的是**触发按钮**；用 useEffect 才记录会抓到 autoFocus 后的弹窗内部元素，
 *    关闭时该元素已随弹窗卸载（isConnected=false），焦点直接掉到 body；
 * 2. 弹窗内部元素（上一次打开留下的浮层内容）不算归还目标 → 退回「层外焦点历史」；
 * 3. 归还只在「焦点还在本层内 / 已掉到 body」时发生，绝不抢用户已移到别处的焦点；
 * 4. 触发元素本身被替换/卸载时，依次退到 restoreFocusRef → 层外焦点历史。
 */
export function useInteractionLayer<T extends HTMLElement = HTMLElement>(options: InteractionLayerOptions<T>): RefObject<T> {
  const internalRef = useRef<T | null>(null) as MutableRefObject<T | null>
  const layerRef = options.layerRef ?? internalRef
  const latest = useRef(options)
  latest.current = options
  const { open } = options

  const triggerRef = useRef<HTMLElement | null>(null)
  const capturedRef = useRef(false)
  // 渲染期快照：早于 React autoFocus（commitMount），也早于任何 effect
  if (open) {
    if (!capturedRef.current) {
      capturedRef.current = true
      triggerRef.current = captureTrigger(layerRef.current)
    }
  } else if (capturedRef.current) {
    // 关闭：只复位「是否抓过」；trigger 保留到 effect 清理归还焦点，下次打开再覆盖
    capturedRef.current = false
  }

  useLayoutEffect(() => {
    if (!open) return
    bindOutsideFocusHistory()
    const layerId = interactionLayers.push({
      kind: latest.current.kind ?? 'popover',
      name: latest.current.name ?? 'layer',
      trap: latest.current.trap === true,
      root: layerRef.current,
      onEscape: () => latest.current.onClose?.(),
      onOutside: latest.current.closeOnOutside ? () => latest.current.onClose?.() : undefined,
      contains: (node) => !!layerRef.current && node instanceof Node && layerRef.current.contains(node)
    })
    // 视觉层序 = 逻辑层序：后开的层画在先生开的之上（模态自然压住浮窗/信息弹层）
    const root = layerRef.current
    const previousZ = root?.style.zIndex ?? ''
    let zIndex = 0
    const updateZ = () => {
      zIndex = interactionLayers.zIndexOf(layerId)
      applyLayerZIndex(root, zIndex)
    }
    const unsubscribe = interactionLayers.subscribe(updateZ)
    updateZ()

    // 首焦点：显式指定优先，否则层内第一个可聚焦元素
    if (latest.current.autoFocus !== false) {
      const explicit = latest.current.initialFocusRef?.current
      if (explicit) explicit.focus()
      else {
        const first = focusableWithin(layerRef.current)[0]
        if (first) first.focus()
        else (layerRef.current as (HTMLElement & { focus?: () => void }) | null)?.focus?.()
      }
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      // IME 组合中（isComposing / keyCode 229）：Escape 用于取消候选、Tab 用于上屏，都不该被浮层抢走
      if (isComposingKey(event)) return
      if (event.key === 'Escape') {
        if (!interactionLayers.isTop(layerId) || !latest.current.onClose) return
        event.preventDefault()
        event.stopPropagation()
        latest.current.onClose()
        return
      }
      if (event.key !== 'Tab' || !latest.current.trap || !interactionLayers.isTopTrap(layerId)) return
      const nodes = focusableWithin(layerRef.current)
      if (!nodes.length) {
        event.preventDefault()
        ;(layerRef.current as (HTMLElement & { focus?: () => void }) | null)?.focus?.()
        return
      }
      const target = trapTargetIndex(nodes.length, nodes.indexOf(document.activeElement as HTMLElement), event.shiftKey)
      if (target == null) return
      event.preventDefault()
      nodes[target].focus()
    }
    const onMouseDown = (event: MouseEvent) => {
      if (!latest.current.closeOnOutside || !interactionLayers.isTop(layerId)) return
      const target = event.target
      if (layerRef.current && target instanceof Node && layerRef.current.contains(target)) return
      latest.current.onClose?.()
    }
    /**
     * 模态屏障（指针）：真正模态必须阻断背景操作。
     * 视觉 z 轴已经把模态压在最上面，但浏览器命中测试只认绘制结果；
     * 这里在捕获阶段把「落在最上层模态及其上方浮层之外」的指针事件截断，
     * 背景的按钮/浮窗拖拽/右键菜单在模态开着时一律收不到事件。
     */
    const onPointerBarrier = (event: Event) => {
      if (!interactionLayers.blocks(event.target)) return
      event.preventDefault()
      event.stopPropagation()
    }
    /**
     * 模态屏障（焦点）：背景元素不得在模态开着时拿到焦点。
     * 点击已被指针屏障挡下；这里兜住程序化 focus / 遗留的焦点迁移，
     * 把焦点拉回最上层模态内的第一个可聚焦元素。
     */
    const onFocusBarrier = (event: FocusEvent) => {
      if (!interactionLayers.blocks(event.target)) return
      const root = interactionLayers.topModal()?.root
      if (!(root instanceof HTMLElement)) return
      focusableWithin(root)[0]?.focus()
    }
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('mousedown', onMouseDown, true)
    for (const type of POINTER_BARRIER_EVENTS) document.addEventListener(type, onPointerBarrier, true)
    document.addEventListener('focusin', onFocusBarrier, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('mousedown', onMouseDown, true)
      for (const type of POINTER_BARRIER_EVENTS) document.removeEventListener(type, onPointerBarrier, true)
      document.removeEventListener('focusin', onFocusBarrier, true)
      unsubscribe()
      interactionLayers.release(layerId)
      // 归还 z 轴：只在还是本层写下的值时才清，避免抹掉调用方自己的内联样式
      if (root && zIndex > 0 && root.style.zIndex === String(zIndex)) root.style.zIndex = previousZ
      if (latest.current.restoreFocus === false) return
      restore()
    }
  }, [open, layerRef])

  /**
   * 归还焦点：
   * - 焦点已被用户移到本层之外（例如打开了另一层）→ 不抢；
   * - 触发元素仍在文档里 → 还给触发元素（最常见：模态/菜单的触发按钮）；
   * - 触发元素已随打开动作卸载 → 退到显式归还目标 → 层外焦点历史；
   *   显式归还目标也可能「本轮提交才挂载」（ref 在 layout 阶段才赋值）→ 微任务里再试一次；
   * - 都没有 → 什么都不做（不把焦点硬塞给 body，也不抢用户已经移走的焦点）。
   */
  function restore(): void {
    const layerRoot = layerRef.current
    const active = document.activeElement
    const focusInsideLayer = !!layerRoot && active instanceof Node && layerRoot.contains(active)
    const focusNowhere = !active || active === document.body || active === document.documentElement
    if (!focusInsideLayer && !focusNowhere) return
    const usable = (node: HTMLElement): boolean => isRestorable(node) && !(!!layerRoot && layerRoot.contains(node))
    const target = pickRestoreTarget<HTMLElement>([triggerRef.current, latest.current.restoreFocusRef?.current, outsideFocus], usable)
    if (target) {
      target.focus()
      return
    }
    const deferred = latest.current.restoreFocusRef
    if (!deferred) return
    queueMicrotask(() => {
      const node = deferred.current
      if (!node || !isRestorable(node)) return
      const current = document.activeElement
      if (current && current !== document.body && current !== document.documentElement) return
      node.focus()
    })
  }

  return layerRef
}
