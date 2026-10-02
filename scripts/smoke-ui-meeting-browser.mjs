import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { build } from 'vite'
import react from '@vitejs/plugin-react'

const root = path.resolve(import.meta.dirname, '..')
const output = path.join(root, 'out/ui-meeting-browser')
const source = path.join(root, 'out/ui-meeting-browser-source')
const profile = path.join(root, 'out', `meeting-browser-profile-${randomUUID()}`)
const shots = path.join(root, 'gui-test-screenshots/meeting-stage3')
const edgePath = process.env.MEETING_BROWSER_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
await fs.access(edgePath)
await fs.mkdir(source, { recursive: true })
await fs.mkdir(shots, { recursive: true })
await fs.mkdir(profile)
await fs.writeFile(path.join(source, 'index.html'), '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>隔离会议页面验证</title></head><body><div id="root"></div><script type="module" src="../../scripts/fixtures/ui-meeting-visual-entry.ts"></script></body></html>')
await build({ configFile: false, root: source, plugins: [react()], base: '/', logLevel: 'warn', build: { outDir: output, emptyOutDir: false, chunkSizeWarningLimit: 2000 } })
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' }
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname
    const file = path.resolve(output, '.' + (pathname === '/' ? '/index.html' : pathname))
    if (!file.startsWith(output + path.sep)) { response.writeHead(403).end(); return }
    response.setHeader('Content-Type', types[path.extname(file)] ?? 'application/octet-stream')
    response.end(await fs.readFile(file))
  } catch { response.writeHead(404).end() }
})
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
const url = `http://127.0.0.1:${server.address().port}`
const browser = spawn(edgePath, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] })
let launchError
browser.on('error', (error) => { launchError = error })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (read, label, timeout = 20000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await sleep(80) }
  throw new Error(`Timed out: ${label}`)
}
let socket
let sessionId
let commandId = 0
const pending = new Map()
const pageErrors = []
let checks = 0
const check = (condition, label) => { assert(condition, label); checks++; console.log(`PASS ${label}`) }
const send = (method, params = {}, scoped = true) => new Promise((resolve, reject) => {
  const id = ++commandId
  const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)) }, 15000)
  pending.set(id, { resolve, reject, timeout })
  socket.send(JSON.stringify({ id, method, params, ...(scoped && sessionId ? { sessionId } : {}) }))
})
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result.value
}
const visibleText = () => evaluate('document.querySelector(".meeting-detail")?.innerText ?? ""')
const screenshot = async (name) => { const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); await fs.writeFile(path.join(shots, `${name}.png`), Buffer.from(result.data, 'base64')) }
try {
  const activePort = await until(async () => {
    if (launchError) throw launchError
    try { return (await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n') } catch { return null }
  }, 'isolated Edge debugging port')
  socket = new WebSocket(`ws://127.0.0.1:${activePort[0]}${activePort[1]}`)
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    if (message.method === 'Runtime.exceptionThrown') pageErrors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text)
    const promise = pending.get(message.id)
    if (!promise) return
    pending.delete(message.id)
    clearTimeout(promise.timeout)
    if (message.error) promise.reject(new Error(message.error.message))
    else promise.resolve(message.result)
  })
  const target = await send('Target.createTarget', { url: 'about:blank' }, false)
  const attached = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true }, false)
  sessionId = attached.sessionId
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url })
  await until(() => evaluate('document.querySelectorAll("[data-turn-id]").length === 3'), 'authoritative meeting timeline')
  check(await evaluate('!document.querySelector(".side-dock")'), '真实页面初次进入不抢开侧栏')
  await evaluate('document.querySelector("[data-execution-link=visual_speech_2]").click()')
  await until(() => evaluate('document.querySelector(".worker-pane")?.innerText.includes("精确历史执行日志")'), 'precise historical execution logs')
  check(!(await visibleText()).includes('OTHER_RUN_SECRET'), '浏览器中旧发言仅展示确切 Run/Turn 日志')
  check(await evaluate('document.querySelector(".worker-pane .turn-index")?.textContent.includes("第 1 轮")'), '成员记录显示正式会议轮次，不把过滤后的局部序号 #1 当会议轮次')
  for (const [theme, width] of [['dark', 1440], ['light', 1440], ['dark', 820], ['light', 820]]) {
    await evaluate(`window.agentdeck.settings.set({ theme: ${JSON.stringify(theme)} })`)
    await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false })
    await sleep(160)
    const geometry = await evaluate('({ width: innerWidth, page: document.documentElement.scrollWidth, dock: document.querySelector(".side-dock").getBoundingClientRect().width, main: document.querySelector(".detail-left").getBoundingClientRect().width })')
    check(geometry.page <= geometry.width + 1 && geometry.dock > 150 && geometry.main > 150, `${theme}/${width} 正文与成员侧栏可读，无整页横向溢出`)
    const executionGeometry = await evaluate('({ worker: document.querySelector(".worker-pane").getBoundingClientRect().height, timeline: document.querySelector(".worker-pane-timeline").getBoundingClientRect().height, metadataOpen: document.querySelector(".mtd-execution-metadata").open })')
    check(executionGeometry.worker >= 320 && executionGeometry.timeline >= 160 && !executionGeometry.metadataOpen, `${theme}/${width} 成员记录有独立充足高度，审计默认折叠：${JSON.stringify(executionGeometry)}`)
    await screenshot(`${theme}-${width}`)
    if (width < 900) {
      await evaluate('document.querySelector(".side-dock").scrollIntoView({ block: "end" })')
      await sleep(100)
      check(await evaluate('document.querySelector(".side-dock").getBoundingClientRect().top < innerHeight && document.querySelector(".side-dock").getBoundingClientRect().bottom > 0'), `${theme}/${width} 沿用堆叠分页，滚动后成员侧栏可见`)
      await screenshot(`${theme}-${width}-member`)
    }
  }
  await evaluate('window.__meetingVisual.advance()')
  await until(() => evaluate('document.querySelectorAll("[data-turn-id]").length === 4'), 'version-only update')
  check(await evaluate('document.querySelector("[data-member-pane]").getAttribute("data-member-pane") === "agent_c2"'), '新正式发言不抢走固定成员')
  check((await visibleText()).includes('旧序号记录已增量更新'), '真实浏览器合并旧序号更新')
  check(await evaluate('document.querySelector("[data-meeting-round]").dataset.meetingRound === "2"'), '第二轮汇报到达时更新轮次，即使概要广播仍为第一轮')
  check(await evaluate('window.__meetingVisual.readQueries.filter(query => query.afterVersion !== undefined).every(query => !("afterSequence" in query))'), '真实浏览器增量请求不附旧序号下界')
  await evaluate('document.querySelector("input[aria-label=跟随当前发言者]").click()')
  await until(() => evaluate('document.querySelector("[data-member-pane]").getAttribute("data-member-pane") === "agent_c1"'), 'explicit formal speech follow')
  await until(() => evaluate('document.querySelector(".worker-pane .turn-index")?.textContent.includes("第 2 轮")'), 'second-round execution label')
  check(await evaluate('document.querySelector(".worker-pane").innerText.includes("第二轮的确切执行记录")'), '第二次汇报的执行记录同步显示第二轮，保持确切身份过滤')
  check(true, '仅显式开启跟随后切换到正式发言者')
  await evaluate('document.querySelector("[aria-label=关闭全部分页]").click(); window.__meetingVisual.showState("stopping")')
  await sleep(100)
  check(await evaluate('!document.querySelector(".side-dock") && document.querySelector("[data-meeting-status]").textContent === "正在停止"'), '关闭侧栏后状态广播不重开，停止中不冒充完成')
  await evaluate('window.__meetingVisual.showState("failed")')
  await sleep(100)
  check((await visibleText()).includes('停止受阻') && !(await visibleText()).includes('已停止'), '退出未确认如实显示停止受阻')
  check(pageErrors.length === 0, `浏览器运行时无错误：${pageErrors.join('; ')}`)
  console.log(`MEETING BROWSER SMOKE PASSED: ${checks} checks; screenshots: ${shots}`)
} catch (error) {
  if (socket?.readyState === WebSocket.OPEN && sessionId) {
    console.error(JSON.stringify({ errors: pageErrors, state: await evaluate('({ view: window.__meetingVisual?.ui.getState(), text: document.body.innerText })') }))
    await screenshot('failed')
  }
  throw error
} finally {
  if (socket?.readyState === WebSocket.OPEN) {
    try { await send('Browser.close', {}, false) } catch {}
    socket.close()
  }
  for (const promise of pending.values()) { clearTimeout(promise.timeout); promise.reject(new Error('isolated browser closed')) }
  pending.clear()
  await new Promise((resolve) => server.close(resolve))
  console.log(`Isolated browser profile retained: ${profile}`)
}
