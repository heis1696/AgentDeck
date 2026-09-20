import { useEffect, useRef, type MutableRefObject, type RefObject } from 'react'
import { FOCUSABLE_SELECTOR, interactionLayers, trapTargetIndex, type LayerKind } from '../ui/interaction-layer'

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
    .filter((node) => !node.hasAttribute('disabled') && node.getAttribute('aria-hidden') !== 'true' && node.getClientRects().length > 0)
}

/**
 * 统一浮层行为：最上层 Escape、外点关闭、模态焦点陷阱、关闭后焦点归还。
 * 所有浮层（Confirm / Palette / Menu / FloatWindow / 页面内模态）共用同一套语义，
 * 叠加时只有最上层响应 Escape，Tab 循环归「最上层声明 trap 的层」。
 */
export function useInteractionLayer<T extends HTMLElement = HTMLElement>(options: InteractionLayerOptions<T>): RefObject<T> {
  const internalRef = useRef<T | null>(null) as MutableRefObject<T | null>
  const layerRef = options.layerRef ?? internalRef
  const latest = useRef(options)
  latest.current = options
  const { open } = options

  useEffect(() => {
    if (!open) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const layerId = interactionLayers.push({
      kind: latest.current.kind ?? 'popover',
      name: latest.current.name ?? 'layer',
      trap: latest.current.trap === true,
      onEscape: () => latest.current.onClose?.(),
      onOutside: latest.current.closeOnOutside ? () => latest.current.onClose?.() : undefined,
      contains: (node) => !!layerRef.current && node instanceof Node && layerRef.current.contains(node)
    })

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
      if (event.key === 'Escape') {
        if (event.isComposing) return
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
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('mousedown', onMouseDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('mousedown', onMouseDown, true)
      interactionLayers.release(layerId)
      if (latest.current.restoreFocus === false) return
      const active = document.activeElement
      const focusLeftLayer = !active || active === document.body || layerRef.current?.contains(active) === true
      if (previous?.isConnected && focusLeftLayer) previous.focus()
    }
  }, [open, layerRef])

  return layerRef
}
