#!/usr/bin/env node
/**
 * scripts/smoke-ui-workspace-path.mjs — 工作区路径等价冒烟（fix：渲染层路径等价收口）
 *
 * 只驱动真实组件与真实 shared 助手（jsdom + react-dom/client），不改写组件内部判定：
 *   shared/path-key      —— 与主进程 worktreePathKey 同语义的路径键（win32 折叠/分隔符
 *                           混用/尾随分隔符/`.` `..` 段/UNC 根；跨实现对拍锁死同语义）；
 *                           平台分支不读渲染页 process：preload 白名单注入
 *                           （setSharedPathKeyPlatform）驱动的等价渲染环境另行专测；
 *                           最近工作区上浮/并入按路径键去重（别名写法不重复展示/持久化）；
 *   WorkspaceSwitcher    —— 当前项判定按路径键折叠：别名写法指向当前目录照样高亮
 *                           current + aria-current，非当前项不得误亮。
 *
 * 运行：node scripts/smoke-ui-workspace-path.mjs（已接入 package.json smoke:ui 链）
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const root = path.resolve(import.meta.dirname, '..')
const dom = new JSDOM('<!doctype html><div id="app"></div>', { url: 'http://localhost', pretendToBeVisual: true, runScripts: 'outside-only' })
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
      "export { sharedPathKey, pushRecentWorkspace, extendRecentWorkspaces, setSharedPathKeyPlatform } from './src/shared/path-key'"
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

const { act, createElement, createRoot, WorkspaceSwitcher, sharedPathKey, pushRecentWorkspace, extendRecentWorkspaces, setSharedPathKeyPlatform } = await import(pathToFileURL(outfile).href)

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
    ok(sharedPathKey('\\\\server\\share') === '\\\\server\\share\\', 'UNC 根自带尾分隔符（与主进程 resolve 派生键一致）')
    ok(sharedPathKey('\\\\server\\share\\') === sharedPathKey('\\\\server\\share'), 'UNC 根尾随分隔符可省（同键）')
    ok(sharedPathKey('\\\\SERVER\\SHARE\\WS\\..') === sharedPathKey('\\\\server\\share'), 'UNC 段消解到根：键回到根形态')
  } else {
    ok(sharedPathKey('/a/b') === '/a/b', 'posix 键保持精确拼写')
    ok(sharedPathKey('/a/x/../b') === '/a/b', '`..` 段消解后同键')
    ok(sharedPathKey('/') === '/', '文件系统根保留分隔符')
    ok(sharedPathKey('/A/b') !== sharedPathKey('/a/b'), 'posix 大小写敏感：不同拼写不同键')
  }
  // 与主进程实现对拍（路径键别名语义锁死）：git.ts 的 worktreePathKey 打包后逐一对照。
  // 对拍键必须取宿主平台的绝对形态——共享键规则是平台语义，跨平台形态不构成契约
  //（win32 裸 `/` 依赖 CWD 盘符、posix 的 `C:\` 是相对段，两侧纯字符串规范化无从对齐）
  const gitOut = path.join(root, 'out', 'smoke-ui-workspace-path-git.cjs')
  await build({ entryPoints: [path.join(root, 'src/main/git.ts')], outfile: gitOut, bundle: true, platform: 'node', format: 'cjs', target: 'node18' })
  const { worktreePathKey } = await import(pathToFileURL(gitOut).href)
  const win32Battery = [
    'C:\\a\\b', 'c:/a/b/', 'C:\\a\\x\\..\\b', 'C:\\', 'c:/',
    '\\\\server\\share\\ws', '//server/share/ws',
    // 越过共享根的 `..` 弹出下界：主进程 resolve 停在 `\\server\share\`，键必须同源
    '\\\\server\\share', '\\\\server\\share\\', '\\\\server\\share\\..',
    '\\\\server\\share\\..\\..', '//server/share/../..', '\\\\server\\share\\..\\ws',
    '\\\\server\\share\\WS\\..', '//server/share',
    path.join(root, 'src'), path.join(root, 'src') + path.sep, root.toUpperCase()
  ]
  const posixBattery = [
    '/a/b', '/a/b/', '/a/x/../b', '/', '/SERVER/share', '//server/share',
    path.join(root, 'src'), path.join(root, 'src') + path.sep, root.toUpperCase()
  ]
  const battery = process.platform === 'win32' ? win32Battery : posixBattery
  for (const candidate of battery) {
    ok(sharedPathKey(candidate) === worktreePathKey(candidate), `与主进程键对拍一致：${candidate}`)
  }
}

/* ------------------------------- 平台注入分支（preload 白名单通道驱动的语义选择） */

section('平台注入：win32 折叠 / posix 精确两分支各自对应用例（不依赖宿主平台）')
{
  // win32 注入：别名折叠生效——任何宿主平台上注入 win32 后都必须走折叠语义
  setSharedPathKeyPlatform('win32')
  ok(sharedPathKey('C:\\REPOS\\Alpha') === sharedPathKey('c:/repos/alpha'), '注入 win32：大小写/分隔符别名折叠同键')
  ok(sharedPathKey('\\\\Server\\Share') === '\\\\server\\share\\', '注入 win32：UNC 根折叠大小写并自带尾分隔符')
  ok(sharedPathKey('//server/share/ws') === '\\\\server\\share\\ws', '注入 win32：正斜杠 UNC 折叠为反斜杠双分隔符形态')
  // posix 注入：精确拼写——别名写法即不同键，任何宿主平台上都不得折叠
  setSharedPathKeyPlatform('linux')
  ok(sharedPathKey('/A/b') !== sharedPathKey('/a/b'), '注入 posix：大小写精确（别名拼写是不同键）')
  ok(sharedPathKey('/a/b/') === '/a/b' && sharedPathKey('/a/x/../b') === '/a/b', '注入 posix：尾随分隔符剥离与 `..` 段消解照常')
  ok(sharedPathKey('\\\\server\\share') === '\\\\server\\share', '注入 posix：反斜杠按普通字符参与段名（不产生 UNC 语义）')
  // 空注入 = 未注入：回退宿主 process.platform（主进程/Node 冒烟环境），行为与回退分支一致
  setSharedPathKeyPlatform(undefined)
  ok(sharedPathKey(process.platform === 'win32' ? 'C:\\A' : '/a/b') === sharedPathKey(process.platform === 'win32' ? 'c:\\a' : '/a/b'), '空注入回退宿主平台分支')
  // 还原为宿主平台等价注入：后续段落在确定语义下运行
  setSharedPathKeyPlatform(process.platform)
}

/* ----------------------- 渲染层真实环境等价：无 process + preload 通道注入 + 对拍 */

section('渲染层平台感知：无 process 环境经注入通道取得正确平台（preload 等价路径）')
{
  // preload 白名单通道静态证据：preload 显式交出平台字面量（而非暴露 process）
  const preloadSource = fs.readFileSync(path.join(root, 'src/preload/index.ts'), 'utf8')
  ok(/^\s*platform: process\.platform,/m.test(preloadSource), 'preload 白名单通道注入平台字面量（platform: process.platform）')
  const entrySource = fs.readFileSync(path.join(root, 'src/renderer/src/main.tsx'), 'utf8')
  ok(entrySource.includes('setSharedPathKeyPlatform(bridge?.platform)'), '渲染层入口在首次渲染前落位注入平台')
  // shared/path-key 源头不读渲染页全局 process 之外的宿主痕迹：平台分支只有注入点
  // 与 process 回退两条路（bundle 进渲染层后回退不可达，分支选择完全由注入决定）
  const keySource = fs.readFileSync(path.join(root, 'src/shared/path-key.ts'), 'utf8')
  ok(keySource.includes('typeof process !== \'undefined\' && process.platform === \'win32\''), '平台回退只认 process.platform（渲染页无 process 时依赖注入）')
  // 真实渲染环境等价：platform:'browser' 打包 + jsdom 上下文执行——该上下文没有
  // Node 的 process（先证环境确实无 process，防用例退化为 Node 回退分支虚过），
  // 平台信息只经注入函数进入，键值与主进程实现对拍
  const browserOut = path.join(root, 'out', 'smoke-ui-workspace-path-browser.cjs')
  await build({ entryPoints: [path.join(root, 'src/shared/path-key.ts')], outfile: browserOut, bundle: true, platform: 'browser', format: 'cjs', logLevel: 'silent' })
  const browserCode = fs.readFileSync(browserOut, 'utf8')
  window.eval(`var __pathKeyModule = { exports: {} };\n(function (module, exports) {\n${browserCode}\n})(__pathKeyModule, __pathKeyModule.exports);`)
  const rendererApi = window.__pathKeyModule.exports
  ok(window.eval('typeof process') === 'undefined', '渲染等价环境确实没有 process（jsdom 上下文）')
  ok(rendererApi.sharedPathKey(process.platform === 'win32' ? 'C:\\A\\b' : '/a/b') !== '', '无注入时渲染层键规范化不抛（回退分支）')
  const win32Expected = [
    ['C:\\a\\b', 'c:\\a\\b'], ['c:/a/b/', 'c:\\a\\b'], ['C:\\', 'c:\\'],
    ['\\\\server\\share', '\\\\server\\share\\'], ['\\\\server\\share\\ws', '\\\\server\\share\\ws']
  ]
  const posixExpected = [['/a/b', '/a/b'], ['/a/b/', '/a/b'], ['/', '/'], ['/A/b', '/A/b']]
  if (process.platform === 'win32') {
    rendererApi.setSharedPathKeyPlatform('win32')
    const gitOut = path.join(root, 'out', 'smoke-ui-workspace-path-git.cjs')
    const { worktreePathKey } = await import(pathToFileURL(gitOut).href)
    for (const [candidate] of win32Expected) {
      ok(rendererApi.sharedPathKey(candidate) === worktreePathKey(candidate), `渲染层（无 process+注入 win32）与主进程键对拍一致：${candidate}`)
    }
    ok(rendererApi.sharedPathKey('C:\\REPOS\\Alpha') === 'c:\\repos\\alpha', '渲染层注入 win32 后别名折叠生效（不依赖 process）')
    rendererApi.setSharedPathKeyPlatform('linux')
    ok(rendererApi.sharedPathKey('C:\\A') !== rendererApi.sharedPathKey('c:\\a'), '渲染层注入 posix 后恢复精确拼写（分支随注入切换）')
  } else {
    rendererApi.setSharedPathKeyPlatform('linux')
    for (const [candidate, expected] of posixExpected) {
      ok(rendererApi.sharedPathKey(candidate) === expected, `渲染层（无 process+注入 posix）键正确：${candidate}`)
    }
    rendererApi.setSharedPathKeyPlatform('win32')
    ok(rendererApi.sharedPathKey('C:\\REPOS\\Alpha') === 'c:\\repos\\alpha', '渲染层注入 win32 后折叠生效（分支随注入切换）')
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
  // 委派 worktree 目录（机器生成）不进「最近工作区」：自动收录拒绝 + 存量载入清洗；显式选择不拦
  ok(extendRecentWorkspaces(['C:\\repos\\alpha'], ['C:\\repos\\alpha\\.agentdeck-worktrees\\task-x_c1', 'C:\\repos\\beta'], cap).join(',') === 'C:\\repos\\alpha,C:\\repos\\beta', '并入：委派 worktree 目录不收录')
  ok(extendRecentWorkspaces(['C:\\repos\\alpha', 'D:\\agentdeck\\.agentdeck-worktrees\\t_abc_c2', '/x/.agentdeck-worktrees/t_y'], ['C:\\repos\\beta'], cap).length === 2, '载入清洗：存量中已收录的 worktree 一并剔除')
  ok(pushRecentWorkspace(['C:\\repos\\alpha'], 'C:\\repos\\alpha\\.agentdeck-worktrees\\task-x_c1', cap).length === 2, '显式选择（pushRecentWorkspace）不受 worktree 过滤拦截')
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
  console.log('  SKIP WorkspaceSwitcher 当前项折叠用例（非 win32 平台，路径等价判定退化为字面量比较；注入分支语义已在上方专测）')
}

if (failures) {
  console.error(`\n${failures} 项未过`)
  process.exit(1)
}
console.log('\n✅ WORKSPACE PATH SMOKE PASSED')
