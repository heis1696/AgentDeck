/**
 * 动效偏好（审查项 6）：所有**显式**平滑滚动（behavior: 'smooth'）都必须经过这里，
 * 而不是在组件里硬写 'smooth'——用户在系统里开启「减弱动态效果」
 * （prefers-reduced-motion: reduce）时，统一降级为即时跳转。
 *
 * 与 tokens.css 的 `@media (prefers-reduced-motion: reduce)` 是同一份偏好：
 * CSS 管过渡/动画，这里管 JS 发起的滚动，两条通道同一判定。
 * jsdom 等没有 matchMedia 的宿主按「未开启减弱」处理，绝不抛错。
 */
export function prefersReducedMotion(): boolean {
  try {
    return typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches === true
  } catch {
    return false
  }
}

/** 本次滚动该用的 behavior：减弱动效 → 'auto'，否则 'smooth' */
export function scrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? 'auto' : 'smooth'
}

/**
 * 滚到指定纵坐标：behavior 由 reduced-motion 决定（调用点不再自己写 'smooth'）。
 * 无 scrollTo 的宿主（jsdom 等）退化为直接赋值 scrollTop，保证滚动语义仍在。
 */
export function scrollElementTo(
  element: { scrollTo?: (options: ScrollToOptions) => void; scrollTop?: number } | null | undefined,
  top: number
): void {
  if (!element) return
  if (typeof element.scrollTo === 'function') {
    element.scrollTo({ top, behavior: scrollBehavior() })
    return
  }
  element.scrollTop = top
}
