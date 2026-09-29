#!/usr/bin/env node
/**
 * scripts/smoke-ui-workspace-path.mjs — 工作区路径等价冒烟（fix：渲染层路径等价收口）
 *
 * 只驱动真实组件与真实 shared 助手（jsdom + react-dom/client），不改写组件内部判定：
 *   shared/path-key      —— 与主进程 worktreePathKey 同语义的路径键（win32 折叠/分隔符
 *                           混用/尾随分隔符/`.` `..` 段；跨实现对拍锁死同语义）；
 *                           最近工作区上浮/并入按路径键去重（别名写法不重复展示/持久化）；
 *   WorkspaceSwitcher    —— 当前项判定按路径键折叠：别名写法指向当前目录照样高亮
 *                           current + aria-current，非当前项不得误亮。
 *
 * 运行：node scripts/smoke-ui-workspace-path.mjs（已接入 package.json smoke:ui 链）
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const root = path.resolve(import.meta.dirname, '..')
const dom = new JSDOM('<!doctype html><div id="app"></div>', { url: 'http://localhost', pretendToBeVisual: true })
const { window } = dom
for (const key of ['document', 'HTMLElement', 'Node', 'Element', 'Event', 'MouseEvent', 'FocusEvent']) globalThis[key] = window[key]
globalThis.window = window
globalThis.IS_REACT_ACT_ENVIRONMENT = true
window.matchMedia = (media) => ({ matches: false, media, addEventListener() {}, removeEventListener() {} })
window.HTMLElement.prototype.getClientRects = function () { return [{ width: 100, height: 24 }] }

const outfile = path.join(root, 'out/smoke-ui-workspace-path.cjs')
await build({
  stdin: {
    contents: [
      "export { act, createElement } from 'react'",
      "export { createRoot } from 'react-dom/client'",
      "export { WorkspaceSwitcher } from './src/renderer/src/components/WorkspaceSwitcher'",
      "export { sharedPathKey, pushRecentWorkspace, extendRecentWorkspaces } from './src/shared/path-key'"
    ].join('\n'),
    resolveDir: root,
    loader: 'tsx'
  },
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', 'lucide-react'],
  logLevel: 'silent'
})

const { act, createElement, createRoot, WorkspaceSwitcher, sharedPathKey, pushRecentWorkspace, extendRecentWorkspaces } = await import(pathToFileURL(outfile).href)

let failures = 0
const ok = (condition, label) => {
  console.log(`  ${condition ? '✓' : '✗'} ${label}`)
  if (!condition) { failures++; process.exitCode = 1 }
}
const section = (title) => console.log(`\n── ${title}`)

/* ------------------------------------------------- sharedPathKey（与主进程同语义） */

section('sharedPathKey：路径键规范化')
{
  ok(sharedPathKey('') === '' && sharedPathKey(undefined) === '', '空输入得空键')
  if (process.platform === 'win32') {
    ok(sharedPathKey('C:\\a\\b') === 'c:\\a\\b', 'win32 键折叠大小写')
    ok(sharedPathKey('c:/a/b/') === sharedPathKey('C:\\a\\b'), '分隔符混用与尾随分隔符同键')
    ok(sharedPathKey('C:\\a\\x\\..\\b') === sharedPathKey('C:\\a\\b'), '`..` 段消解后同键')
    ok(sharedPathKey('C:\\') === 'c:\\', '盘符根保留分隔符（键恰为 c:\\）')
    ok(sharedPathKey('\\\\server\\share\\ws') === '\\\\server\\share\\ws', 'UNC 路径保留双分隔符前缀')
    // `..` 弹出有根下界：UNC 的 server/share 两段属于根前缀，越过共享根的 `..` 不得弹出——
    // 键必须与主进程 resolve 派生键（共享根自带尾分隔符）逐字节一致
    ok(sharedPathKey('\\\\server\\share\\..') === '\\\\server\\share\\', 'UNC `..` 止步共享根（不弹出 share 段，键带尾分隔符）')
    ok(sharedPathKey('\\\\server\\share\\..\\..') === '\\\\server\\share\\', 'UNC 连续 `..` 同样止步共享根')
    ok(sharedPathKey('//server/share/../..') === '\\\\server\\share\\', 'UNC 混合别名形态（正斜杠 + `..`）同键')
    ok(sharedPathKey('\\\\server\\share\\..\\ws') === '\\\\server\\share\\ws', 'UNC 共享根内的 `..` 消解后正常拼接子段')
    ok(sharedPathKey('\\\\SERVER\\SHARE\\WS\\..') === '\\\\server\\share\\', 'UNC 大小写别名 + `..` 消解折叠为共享根同一键')
  } else {
    ok(sharedPathKey('/a/b') === '/a/b', 'posix 键保持精确拼写')
    ok(sharedPathKey('/a/x/../b') === '/a/b', '`..` 段消解后同键')
    ok(sharedPathKey('/') === '/', '文件系统根保留分隔符')
    ok(sharedPathKey('/A/b') !== sharedPathKey('/a/b'), 'posix 大小写敏感：不同拼写不同键')
  }
  // 与主进程实现对拍（win32 别名语义锁死）：git.ts 的 worktreePathKey 打包后逐一对照
  const gitOut = path.join(root, 'out', 'smoke-ui-workspace-path-git.cjs')
  await build({ entryPoints: [path.join(root, 'src/main/git.ts')], outfile: gitOut, bundle: true, platform: 'node', format: 'cjs', target: 'node18' })
  const { worktreePathKey } = await import(pathToFileURL(gitOut).href)
  const battery = [
    'C:\\a\\b', 'c:/a/b/', 'C:\\a\\x\\..\\b', 'C:\\', 'c:/',
    '\\\\server\\share\\ws', '//server/share/ws',
    // 越过共享根的 `..` 弹出下界：主进程 resolve 停在 `\\server\share\`，键必须同源
    '\\\\server\\share', '\\\\server\\share\\', '\\\\server\\share\\..',
    '\\\\server\\share\\..\\..', '//server/share/../..', '\\\\server\\share\\..\\ws',
    path.join(root, 'src'), path.join(root, 'src') + path.sep, root.toUpperCase()
  ]
  for (const candidate of battery) {
    ok(sharedPathKey(candidate) === worktreePathKey(candidate), `与主进程键对拍一致：${candidate}`)
  }
}

/* ------------------------------------- 最近工作区去重（别名不重复展示/持久化） */

section('最近工作区：按路径键去重')
{
  const cap = 8
  if (process.platform === 'win32') {
    const pushed = pushRecentWorkspace(['C:\\repos\\alpha', 'C:\\repos\\beta'], 'c:\\REPOS\\alpha', cap)
    ok(pushed.length === 2 && pushed[0] === 'c:\\REPOS\\alpha' && pushed[1] === 'C:\\repos\\beta', '上浮：别名写法置顶且不重复（同键旧条目被折叠）')
    const extended = extendRecentWorkspaces(['C:\\repos\\alpha'], ['C:\\repos\\beta', 'c:\\repos\\BETA'.toLowerCase()], cap)
    ok(extended.length === 2, '并入：别名写法不重复并入已有条目')
    ok(extended[0] === 'C:\\repos\\alpha' && extended[1] === 'C:\\repos\\beta', '并入保持原顺序')
    ok(extendRecentWorkspaces([], Array.from({ length: 12 }, (_, index) => `C:\\r\\w${index}`), cap).length === cap, '并入超限截断到上限')
  } else {
    const pushed = pushRecentWorkspace(['/repos/alpha', '/repos/beta'], '/repos/gamma', cap)
    ok(pushed.length === 3 && pushed[0] === '/repos/gamma', '上浮：新条目置顶')
    ok(extendRecentWorkspaces(['/repos/alpha'], ['/repos/alpha'], cap).length === 1, '并入：同一写法不重复并入')
  }
  ok(pushRecentWorkspace(['C:\\keep'], '', cap).join(',') === 'C:\\keep', '空目录不上浮')
}

/* --------------------------------------------- WorkspaceSwitcher 当前项判定 */

section('WorkspaceSwitcher：当前项按路径键折叠')
if (process.platform === 'win32') {
  const host = document.getElementById('app')
  let reactRoot
  const mount = async (props) => {
    await act(async () => {
      reactRoot = createRoot(host)
      reactRoot.render(createElement(WorkspaceSwitcher, props))
    })
  }
  const unmount = async () => {
    await act(async () => { reactRoot.render(null); reactRoot.unmount() })
  }
  const items = () => [...host.querySelectorAll('.ws-menu-item')]
  try {
    const current = 'C:\\repos\\alpha'
    const recent = ['C:\\repos\\alpha', 'C:\\repos\\beta']
    let chosen = ''
    await mount({ dir: current, recent, onChoose: (dir) => { chosen = dir }, onPick: () => {} })
    await act(async () => { host.querySelector('.workspace-switcher').dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
    const marked = items().filter((node) => node.classList.contains('current'))
    ok(marked.length === 1 && marked[0].title === current, '字面量写法是当前项：唯一高亮')
    // 别名写法指向当前目录：照样 current + aria-current（字面量 === 判定会漏亮）
    await unmount()
    await mount({ dir: 'c:\\REPOS\\ALPHA', recent, onChoose: (dir) => { chosen = dir }, onPick: () => {} })
    await act(async () => { host.querySelector('.workspace-switcher').dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
    const aliasMarked = items().filter((node) => node.classList.contains('current'))
    ok(aliasMarked.length === 1 && aliasMarked[0].title === current, '别名写法指向当前目录：照样高亮 current')
    ok(aliasMarked[0].getAttribute('aria-current') === 'true', '别名当前项带 aria-current')
    const betaItem = items().find((node) => node.title === 'C:\\repos\\beta')
    ok(betaItem && !betaItem.classList.contains('current'), '非当前项不误亮')
    await act(async () => { betaItem.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
    ok(chosen === 'C:\\repos\\beta', '点击回调拿到原始写法')
    await unmount()
  } finally {
    host.innerHTML = ''
  }
} else {
  console.log('  SKIP WorkspaceSwitcher 当前项折叠用例（非 win32 平台，路径等价判定退化为字面量比较）')
}

if (failures) {
  console.error(`\n${failures} 项未过`)
  process.exit(1)
}
console.log('\n✅ WORKSPACE PATH SMOKE PASSED')
