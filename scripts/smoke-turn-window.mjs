// 执行记录渲染工程冒烟：回合窗口化 + 跳转未渲染回合 + 超长 worklog 行上限。
// 验收口径（ZCODE-TEARDOWN §4.3 吸收模式）：长会话不全量渲染；导航到旧回合先扩窗；
// worklog 中段折叠且用户可否决展开。jsdom 无布局，断言以 DOM 结构为准。
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const root = path.resolve(import.meta.dirname, '..')
const dom = new JSDOM('<!doctype html><div id="app"></div>', { url: 'http://localhost', pretendToBeVisual: true })
const { window } = dom
for (const key of ['document', 'HTMLElement', 'HTMLInputElement', 'Node', 'Element', 'Event', 'MouseEvent', 'KeyboardEvent', 'localStorage']) globalThis[key] = window[key]
globalThis.window = window
globalThis.getComputedStyle = window.getComputedStyle.bind(window)
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window)
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window)
globalThis.IS_REACT_ACT_ENVIRONMENT = true
window.matchMedia = (media) => ({ matches: false, media, addEventListener() {}, removeEventListener() {} })
window.HTMLElement.prototype.getClientRects = function () { return [{ width: 100, height: 24 }] }
// jsdom 没有 ResizeObserver（回合索引用它量轨道高度）：桩成空观察者，生产代码不改
class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
window.ResizeObserver = ResizeObserverStub
globalThis.ResizeObserver = ResizeObserverStub

window.agentdeck = {
  settings: { get: async () => ({}), set: async (patch) => patch, onUpdated: () => () => {} },
  tasks: { fileDiff: async () => null, events: async () => [] },
  skills: { list: async () => ({ root: '', skills: [] }) },
  analytics: { summary: async () => ({ until: 0, generatedAt: 0, totals: {}, byDay: [], byBackend: [], byAgent: [], errors: [] }) },
  agents: { list: async () => [], save: async (list) => list },
  presets: { list: async () => [], save: async (list) => list, newId: async () => 'p', models: async () => ({ source: 'catalog', models: [] }) }
}

const outfile = path.join(root, 'out/smoke-turn-window.cjs')
await build({
  stdin: {
    contents: "export { act, createElement } from 'react'; export { createRoot } from 'react-dom/client'; export { TurnTimeline } from './src/renderer/src/components/task/TurnTimeline';",
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
const { act, createElement, createRoot, TurnTimeline } = await import(pathToFileURL(outfile).href)

const TOTAL_TURNS = 500
const now = Date.now()
const bigWork = (base) => Array.from({ length: 300 }, (_, i) => ({
  seq: base + i, ts: now - (TOTAL_TURNS - base / 400) * 1000 - i,
  kind: 'tool', text: `工具 ${i}`,
  data: i % 2 ? { phase: 'result', ok: true, durationMs: 5 } : { phase: 'started', args: 'x' }
}))
const turns = Array.from({ length: TOTAL_TURNS }, (_, i) => ({
  userText: `问题 ${i + 1}`, firstSeq: i * 400, sysNotes: [], usage: null,
  done: i < TOTAL_TURNS - 1, streamed: '',
  items: [
    { type: 'work', work: bigWork(i * 400 + 1) },
    { type: 'final', text: `回答 ${i + 1}` }
  ]
}))
const task = { id: 't1', title: '长会话', status: 'done', prompt: '', workdir: '', backend: 'zcode' }
const navigated = []
let logHost
const host = document.getElementById('app')
let reactRoot
await act(async () => {
  reactRoot = createRoot(host)
  reactRoot.render(createElement(TurnTimeline, {
    task, turns, activeNav: TOTAL_TURNS - 1, following: true,
    onFollowLatest: () => {}, onNavigate: (index) => navigated.push(index), onRewind: () => {},
    logRef: { current: null }, onScroll: () => {}
  }))
})
logHost = host.querySelector('.log.chat')
assert.ok(logHost, '时间线容器存在')

// 1) 窗口化：只渲染最近 30 个回合，其余不进 DOM
const renderedTurns = () => logHost.querySelectorAll('.turn')
assert.equal(renderedTurns().length, 30, `默认窗口 30 回合（got ${renderedTurns().length}）`)
assert.equal(logHost.querySelector('.log-more-btn')?.textContent, `↑ 加载更早 30 回合 · 前面还有 ${TOTAL_TURNS - 30} 回合`, '加载更早按钮文案含剩余数')
assert.equal(renderedTurns()[0].dataset.turnIdx, '470', '窗口首回合带全局索引 data-turn-idx')

// 2) 「加载更早」扩窗 + 旧回合进入 DOM
await act(async () => { logHost.querySelector('.log-more-btn').dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
assert.equal(renderedTurns().length, 60, '扩窗后 60 回合')
assert.equal(logHost.querySelectorAll('.turn').item(0).dataset.turnIdx, '440', '扩窗后窗口起点前移')

// 3) 回合索引跳到未渲染回合：先扩窗再交给宿主滚动（全局索引不变）
await act(async () => {
  const target = host.querySelectorAll('.chat-minimap-item')[5] // 第 6 回合（未渲染区）
  target.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
})
assert.ok(logHost.querySelector('#turn-5'), '跳转后目标回合 DOM 已就位')
assert.deepEqual(navigated, [5], '宿主 onNavigate 收到全局索引 5')

// 4) 超长 worklog：中段折叠（头 12 + 尾 40），显示全部是用户否决权
const worklog = logHost.querySelector('.worklog')
const lineCount = () => worklog.querySelectorAll('.log-line').length
assert.ok(worklog.querySelector('.worklog-expand'), '折叠行按钮存在')
const capped = lineCount()
assert.equal(capped, 52, `折叠后头尾共 52 行（got ${capped}）`)
await act(async () => { worklog.querySelector('.worklog-expand').dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
assert.equal(lineCount(), 300, '点开显示全部后 300 行')

// 5) 新会话窗口重置：task.id 变化回 30
await act(async () => {
  reactRoot.render(createElement(TurnTimeline, {
    task: { ...task, id: 't2' }, turns, activeNav: TOTAL_TURNS - 1, following: true,
    onFollowLatest: () => {}, onNavigate: () => {}, onRewind: () => {}, logRef: { current: null }, onScroll: () => {}
  }))
})
assert.equal(renderedTurns().length, 30, '切任务后窗口重置回 30')

await act(async () => { reactRoot.unmount() })
console.log('✅ TURN WINDOW SMOKE PASSED: 500 回合窗口化渲染 30、扩窗/跳转旧回合/长 worklog 折叠全过')
