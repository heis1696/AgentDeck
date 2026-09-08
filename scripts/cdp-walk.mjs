// CDP 走查工具：对 --remote-debugging-port=9222 的 AgentDeck 做黑箱 GUI 走查
// 用法: node scripts/cdp-walk.mjs <cmd> [args...]
//   shot <name>              截图到 gui-test-screenshots/<name>.png
//   click <selector>         按选择器取中心坐标，用 Input 事件真实点击
//   press <combo>            组合键（如 ctrl+k、escape、enter）
//   eval <expr>              只读求值，输出 JSON
//   scroll <selector> <dy>   在元素上滚动
//   hover <selector>         悬停
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const BASE = 'http://localhost:9222'
const get = (p) => new Promise((res, rej) =>
  http.get(BASE + p, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d))) }).on('error', rej))

const targets = await get('/json')
const page = targets.find((t) => t.type === 'page')
if (!page) throw new Error('no page target')

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })

let seq = 0
const pending = new Map()
const errors = []
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args?.map((a) => a.value ?? a.description).join(' '))
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description ?? 'exception')
}
const send = (method, params = {}) => new Promise((r) => { const i = ++seq; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
await send('Runtime.enable')
await send('Page.enable')

const evalJson = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) throw new Error('eval failed: ' + JSON.stringify(r.result.exceptionDetails))
  return r.result?.result?.value
}

const realClick = async (x, y) => {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
  }
}

const [cmd, ...args] = process.argv.slice(2)
if (cmd === 'shot') {
  const dir = path.resolve('gui-test-screenshots')
  fs.mkdirSync(dir, { recursive: true })
  const r = await send('Page.captureScreenshot', { format: 'png' })
  const file = path.join(dir, args[0] + '.png')
  fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'))
  console.log('saved', file)
} else if (cmd === 'click' || cmd === 'hover') {
  const rect = await evalJson(`(() => { const el = document.querySelector(${JSON.stringify(args[0])}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height } })()`)
  if (!rect) throw new Error('element not found: ' + args[0])
  if (cmd === 'hover') {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y })
    console.log('hovered', args[0], rect)
  } else {
    await realClick(rect.x, rect.y)
    console.log('clicked', args[0], rect)
  }
} else if (cmd === 'press') {
  const combo = args[0].toLowerCase()
  const parts = combo.split('+')
  const key = parts[parts.length - 1]
  const modifiers = (parts.includes('ctrl') ? 2 : 0) | (parts.includes('shift') ? 8 : 0) | (parts.includes('alt') ? 1 : 0)
  const code = key.length === 1 ? 'Key' + key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1)
  const opts = { modifiers, key, code, windowsVirtualKeyCode: key.length === 1 ? key.charCodeAt(0) : 0 }
  await send('Input.dispatchKeyEvent', { type: 'keyDown', ...opts })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...opts })
  console.log('pressed', args[0])
} else if (cmd === 'eval') {
  console.log(JSON.stringify(await evalJson(args[0]), null, 1))
} else if (cmd === 'scroll') {
  const dy = Number(args[0] ?? 300)
  const x = Number(args[1] ?? 640)
  const y = Number(args[2] ?? 400)
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy })
  console.log('scrolled', dy, 'at', x, y)
} else if (cmd === 'clickxy') {
  await realClick(Number(args[0]), Number(args[1]))
  console.log('clicked at', args[0], args[1])
} else if (cmd === 'rect') {
  console.log(JSON.stringify(await evalJson(`(()=>{const el=[...document.querySelectorAll(${JSON.stringify(args[0])})].find(r=>${args[1]});if(!el)return null;const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)))
} else if (cmd === 'errors') {
  console.log(errors.length ? errors.join('\n') : '(no console errors)')
} else {
  throw new Error('unknown cmd: ' + cmd)
}
ws.close()
