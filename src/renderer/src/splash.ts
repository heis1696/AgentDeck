/** 开机动画层（index.html 静态 #splash）的收场控制。
 *  两条触发路径共用一个幂等 dismiss：React 侧数据就绪快路径（App.tsx）与
 *  bundle 顶层兜底（main.tsx，10s）——后者必须在 React 树之外：渲染崩溃
 *  （如桥接缺失导致整树 throw）时 effect 不会执行，兜底不能跟着陪葬 */
const SPLASH_ID = 'splash'
const DISMISSED_FLAG = 'done'
const DISMISSED_CLASS = 'splash-done'

export function dismissSplash(): void {
  const el = document.getElementById(SPLASH_ID)
  if (!el || el.dataset[DISMISSED_FLAG]) return
  el.dataset[DISMISSED_FLAG] = '1'
  el.classList.add(DISMISSED_CLASS)
  // 过渡 600ms（index.html 内联样式），留一拍再摘除节点
  window.setTimeout(() => el.remove(), 700)
}
