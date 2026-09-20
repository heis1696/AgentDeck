// Electron 真实重叠点击回归：**不做 z-index 数字比较**，而是用 CDP 在真实 Chromium 里
// 按真实鼠标坐标点击「非模态浮窗 / 信息弹层」所在的像素，看事件到底被谁接走。
//
// 复现路径（本轮修复的根因）：.float-window z=38、.meta-info-pop z=40 都压在 .overlay z=10 之上，
// 于是模态开着时，这两个浮层所在的位置仍能被点到（创建/确认模态下方仍可点击）。
//
// 夹具：scripts/fixtures/ui-overlap-electron.tsx（真实组件 + 真实样式表）+ ui-overlap-electron-main.cjs
// （隔离 userData 的离屏窗口）。断言：
//   1. 无模态：同一坐标真实命中浮窗按钮，真实点击计数 +1（证明坐标本身是可点的背景）；
//   2. 有模态：同一坐标命中模态 overlay 本身；真实点击不落到背景浮层，只触发背景遮罩关闭；
//   3. 有模态：信息弹层同理不可点；模态自己的按钮、模态内嵌套菜单（层序在模态之上）照常可点；
//   4. 模态关闭后：背景浮层恢复可点，浮窗拖拽（非模态定位）仍然生效。
//
// 运行：node scripts/smoke-ui-electron-overlap.mjs（需要本机可起 Electron；用隔离的临时 userData）。
import { spawn } from 'node:child_process'
import { build } from 'esbuild'
import electronPath from 'electron'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const outDir = path.join(root, 'out')
const port = Number(process.env.OVERLAP_DEBUG_PORT || 9333)
const width = Number(process.env.OVERLAP_WIDTH || 1000)
const height = Number(process.env.OVERLAP_HEIGHT || 720)

let failures = 0
const ok = (condition, label) => {
  console.log(`  ${condition ? '✓' : '✗'} ${label}`)
  if (!condition) { failures++; process.exitCode = 1 }
}
const section = (title) => console.log(`\n── ${title}`)

/* ---------------------------------------------------------------- 打包夹具 */

fs.mkdirSync(outDir, { recursive: true })
const bundle = path.join(outDir, 'ui-overlap.js')
await build({
  entryPoints: [path.join(root, 'scripts', 'fixtures', 'ui-overlap-electron.tsx')],
  outfile: bundle,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome120',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning'
})
const css = path.join(outDir, 'ui-overlap.css')
if (!fs.existsSync(css)) throw new Error('esbuild 未产出 out/ui-overlap.css（夹具的样式表没被打进去）')
fs.writeFileSync(path.join(outDir, 'ui-overlap.html'), `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>overlap</title>
<link rel="stylesheet" href="./ui-overlap.css"></head>
<body><div id="root"></div><script src="./ui-overlap.js"></script></body></html>
`)

/* ------------------------------------------------------- 起 Electron（隔离） */

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-overlap-'))
const child = spawn(electronPath, [path.join(root, 'scripts', 'fixtures', 'ui-overlap-electron-main.cjs')], {
  cwd: root,
  env: { ...process.env, AGENTDECK_USER_DATA_DIR: userDataDir, OVERLAP_DEBUG_PORT: String(port), OVERLAP_WIDTH: String(width), OVERLAP_HEIGHT: String(height) },
  stdio: ['ignore', 'pipe', 'pipe']
})
let childLog = ''
child.stdout.on('data', (chunk) => { childLog += chunk })
child.stderr.on('data', (chunk) => { childLog += chunk })

const getJson = (p) => new Promise((resolve, reject) => {
  http.get(`http://127.0.0.1:${port}${p}`, (res) => { let data = ''; res.on('data', (c) => (data += c)); res.on('end', () => { try { resolve(JSON.parse(data)) } catch (error) { reject(error) } }) }).on('error', reject)
})

const waitForPage = async (timeoutMs = 40000) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const targets = await getJson('/json/list')
      const page = targets.find((target) => target.type === 'page')
      if (page?.webSocketDebuggerUrl) return page
    } catch { /* 端口还没起来 */ }
    if (Date.now() > deadline) throw new Error(`Electron CDP 端口 ${port} 未就绪（child exited=${child.exitCode}）\n${childLog.slice(-2000)}`)
    await new Promise((r) => setTimeout(r, 250))
  }
}

let ws = null
const cleanup = () => {
  try { ws?.close() } catch { /* ignore */ }
  try { child.kill() } catch { /* ignore */ }
  try { fs.rmSync(userDataDir, { recursive: true, force: true }) } catch { /* ignore */ }
}

try {
  const page = await waitForPage()
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('CDP WebSocket 连接失败')) })

  let seq = 0
  const pending = new Map()
  const pageErrors = []
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id) }
    if (message.method === 'Runtime.exceptionThrown') pageErrors.push(message.params.exceptionDetails?.exception?.description ?? 'exception')
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') pageErrors.push(message.params.args?.map((a) => a.value ?? a.description).join(' '))
  }
  const send = (method, params = {}) => new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })) })
  await send('Runtime.enable')
  await send('Page.enable')

  const evaluate = async (expression) => {
    const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (response.result?.exceptionDetails) throw new Error(`eval 失败: ${JSON.stringify(response.result.exceptionDetails)}\n${expression}`)
    return response.result?.result?.value
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  // 等页面渲染完（真实窗口尺寸下才有真实命中测试）
  for (let i = 0; i < 80; i++) {
    const ready = await evaluate('document.readyState === "complete" && !!document.querySelector("[data-testid=float-btn]") && window.innerWidth > 0')
    if (ready) break
    if (i === 79) throw new Error('夹具页面未渲染完成')
    await sleep(100)
  }
  await evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))')

  const rectOf = (selector) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) } })()`)
  const hits = () => evaluate('JSON.parse(JSON.stringify(window.__overlapHits))')
  const hitAt = (x, y) => evaluate(`(() => { const el = document.elementFromPoint(${x}, ${y}); if (!el) return null; return { testid: el.getAttribute("data-testid"), inModal: !!el.closest('[data-testid="modal-root"]'), inMenu: !!el.closest(".menu-panel"), cls: String(el.className).slice(0, 80) } })()`)
  const clickAt = async (x, y) => {
    for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
    await sleep(60)
  }
  const clickSelector = async (selector) => {
    const rect = await rectOf(selector)
    if (!rect) throw new Error(`找不到元素: ${selector}`)
    await clickAt(rect.x, rect.y)
    return rect
  }
  const modalOpen = () => evaluate('!!document.querySelector("[data-testid=modal-root]")')
  const zIndexOf = (selector) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? getComputedStyle(el).zIndex : null })()`)

  /* ------------------------------------------------ 1. 基线：背景浮层真的可点 */

  section('基线（无模态）：重叠坐标真实命中非模态浮窗/信息弹层，真实点击计数 +1')
  const floatRect = await rectOf('[data-testid=float-btn]')
  ok(!!floatRect && floatRect.w > 0 && floatRect.h > 0, `浮窗按钮有真实尺寸（${floatRect?.w}×${floatRect?.h} @ ${floatRect?.x},${floatRect?.y}）`)
  const baseHit = await hitAt(floatRect.x, floatRect.y)
  ok(baseHit?.testid === 'float-btn', `同一坐标真实命中浮窗按钮（elementFromPoint → ${baseHit?.testid ?? 'null'}）`)
  const infoRect = await rectOf('[data-testid=info-btn]')
  const infoBaseHit = await hitAt(infoRect.x, infoRect.y)
  ok(infoBaseHit?.testid === 'info-btn', `信息弹层按钮同样真实命中（elementFromPoint → ${infoBaseHit?.testid ?? 'null'}）`)
  await clickAt(infoRect.x, infoRect.y)
  ok((await hits()).info === 1, '无模态时真实点击落到信息弹层按钮（计数 1）')
  await clickAt(floatRect.x, floatRect.y)
  ok((await hits()).float === 1, '无模态时真实点击落到浮窗按钮（计数 1，同时按外点语义收起信息弹层）')
  // 信息弹层被上一点击按外点关闭：程序化重开，供「模态之下不可点」这段使用
  await evaluate('window.__overlap.openInfo()')
  await sleep(80)
  ok(await evaluate('!!document.querySelector(".meta-info-pop")'), '信息弹层已重开（准备验证它在模态之下）')

  /* ------------------------------- 2. 模态开着：同一坐标被 overlay 接走 */

  section('有模态：同一坐标不再命中背景浮窗/信息弹层，真实点击到不了它们')
  // 走程序化打开（异步确认框的真实路径）：不会像点击那样把已开的信息弹层按外点关掉
  await evaluate('window.__overlap.openModal()')
  await sleep(80)
  ok(await modalOpen(), '模态已打开（程序化路径），两个非模态浮层仍在')
  ok((await evaluate('!!document.querySelector(".meta-info-pop")')), '信息弹层保持打开（可见层栈中它排在模态之下）')
  const floatZ = await zIndexOf('.float-window')
  const modalZ = await zIndexOf('[data-testid=modal-root]')
  ok(Number(modalZ) > Number(floatZ), `视觉层序：模态 z(${modalZ}) > 非模态浮窗 z(${floatZ})`)

  const blockedHit = await hitAt(floatRect.x, floatRect.y)
  ok(blockedHit?.inModal === true && blockedHit?.testid !== 'float-btn', `浮窗坐标的最上层元素已变成模态自身（elementFromPoint → ${blockedHit?.testid ?? blockedHit?.cls ?? 'null'}）`)
  const infoBlockedHit = await hitAt(infoRect.x, infoRect.y)
  ok(infoBlockedHit?.inModal === true && infoBlockedHit?.testid !== 'info-btn', `信息弹层坐标的最上层元素也变成模态自身（elementFromPoint → ${infoBlockedHit?.testid ?? infoBlockedHit?.cls ?? 'null'}）`)
  await clickAt(floatRect.x, floatRect.y)
  ok((await hits()).float === 1, '真实点击没有落到模态下方的浮窗按钮（计数仍为 1）')
  // 上面这一击落在遮罩上会按语义关闭模态：重新程序化打开，再验证信息弹层
  if (!(await modalOpen())) await evaluate('window.__overlap.openModal()')
  await sleep(80)
  ok(await modalOpen(), '模态已重开，继续验证信息弹层')
  await clickAt(infoRect.x, infoRect.y)
  ok((await hits()).info === 1, '真实点击没有落到模态下方的信息弹层按钮（计数仍为 1）')
  // 落在遮罩上的点击会按语义关闭模态：重新程序化打开，再验证拖拽拦截
  if (!(await modalOpen())) await evaluate('window.__overlap.openModal()')
  await sleep(80)
  ok(await modalOpen(), '模态保持在最上层，继续验证拖拽拦截')
  // 非模态浮窗的拖拽同样不该在模态开着时生效
  const headRectBlocked = await rectOf('.float-window-head')
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: headRectBlocked.x, y: headRectBlocked.y, button: 'left', clickCount: 1 })
  await sleep(60)
  ok(!(await evaluate('document.body.classList.contains("float-dragging")')), '模态开着时浮窗拖拽被拦下（body 不进拖拽态）')
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: headRectBlocked.x, y: headRectBlocked.y, button: 'left', clickCount: 1 })
  ok(pageErrors.length === 0, `渲染进程无 console 错误 / 异常${pageErrors.length ? `：${pageErrors.join(' | ')}` : ''}`)
  await sleep(60)

  /* --------------------------- 3. 模态自身与模态之上的嵌套菜单仍然可交互 */

  section('有模态：模态按钮与「浮在模态之上」的嵌套菜单照常可点')
  // 上一段的「按下-抬起」落在遮罩上会按语义关闭模态，这里重新打开（程序化路径）
  if (!(await modalOpen())) { await evaluate('window.__overlap.openModal()'); await sleep(80) }
  ok(await modalOpen(), '模态打开，开始这一段断言')
  await clickSelector('[data-testid=modal-ok]')
  ok((await hits()).modal === 1, '模态自己的按钮可点（计数 1）')
  ok(await modalOpen(), '模态按钮不关闭模态（仍在最上层）')
  await clickSelector('[data-testid=modal-menu-trigger]')
  ok(await evaluate('!!document.querySelector(".menu-panel")'), '模态内菜单已展开')
  const menuRect = await rectOf('.menu-panel .menu-item')
  const menuHit = await hitAt(menuRect.x, menuRect.y)
  ok(menuHit?.inMenu === true, `菜单浮在模态之上（elementFromPoint → ${menuHit?.testid ?? menuHit?.cls ?? 'null'}）`)
  await clickAt(menuRect.x, menuRect.y)
  const picked = await hits()
  ok(picked.menu === 1 && picked.pick === 'branch', `嵌套菜单真实选中生效（pick=${picked.pick}）`)

  // 遮罩空白处关闭模态（左下角，离模态与浮层都远；用真实视口尺寸，别用窗口外坐标）
  const viewport = await evaluate('({ w: innerWidth, h: innerHeight })')
  const backdropBeforeClose = (await hits()).backdrop
  await clickAt(12, viewport.h - 12)
  ok((await hits()).backdrop === backdropBeforeClose + 1 && !(await modalOpen()), `遮罩空白处点击关闭模态（外点关闭语义保留，视口 ${viewport.w}×${viewport.h}）`)

  /* ------------------------------------------ 4. 模态关闭后背景恢复 + 拖拽 */

  section('模态关闭后：背景恢复可点，非模态浮窗拖拽仍然生效')
  await clickAt(floatRect.x, floatRect.y)
  ok((await hits()).float === 2, '模态关闭后浮窗按钮恢复可点（计数 2）')

  const headRect = await rectOf('.float-window-head')
  const beforeLeft = await evaluate('document.querySelector(".float-window").style.left')
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: headRect.x, y: headRect.y, button: 'left', clickCount: 1 })
  const dragging = await evaluate('document.body.classList.contains("float-dragging")')
  // 水平拖：指针必须始终留在头部内（onPointerMove/onPointerLeave 都挂在头部）
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: headRect.x - 60, y: headRect.y, button: 'left', buttons: 1 })
  await sleep(80)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: headRect.x - 60, y: headRect.y, button: 'left', clickCount: 1 })
  await sleep(60)
  const afterLeft = await evaluate('document.querySelector(".float-window").style.left')
  ok(dragging, '按住浮窗头部进入拖拽态（body.float-dragging）')
  ok(afterLeft !== beforeLeft && afterLeft !== '', `拖拽真的改变了浮窗定位（left: ${beforeLeft || '空'} → ${afterLeft}）`)
  ok(!(await evaluate('document.body.classList.contains("float-dragging")')), '松开后退出拖拽态')

  console.log(`\n${failures === 0 ? '✅ ELECTRON OVERLAP CLICK SMOKE PASSED' : `❌ ${failures} 项断言失败`}`)
} catch (error) {
  console.error(`\n❌ ELECTRON OVERLAP CLICK SMOKE ERROR: ${error?.message ?? error}`)
  if (childLog.trim()) console.error(`--- electron 输出 ---\n${childLog.slice(-2000)}`)
  process.exitCode = 1
} finally {
  cleanup()
}
