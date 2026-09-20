import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const root = path.resolve(import.meta.dirname, '..')
const dom = new JSDOM('<!doctype html><button id="trigger">Open</button><div id="app"></div>', { url: 'http://localhost', pretendToBeVisual: true })
const { window } = dom
for (const key of ['document', 'HTMLElement', 'HTMLInputElement', 'Node', 'Element', 'Event', 'MouseEvent', 'KeyboardEvent', 'localStorage']) globalThis[key] = window[key]
globalThis.window = window
globalThis.getComputedStyle = window.getComputedStyle.bind(window)
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window)
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window)
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const rect = (top, height = 30) => ({ x: 0, y: top, top, bottom: top + height, left: 0, right: 200, width: 200, height, toJSON() {} })
window.HTMLElement.prototype.getClientRects = function () { return [rect(0)] }
window.HTMLElement.prototype.getBoundingClientRect = function () {
  if (this.classList.contains('palette-list')) return rect(0, 100)
  if (this.classList.contains('palette-item')) {
    const list = this.closest('.palette-list')
    return rect([...list.querySelectorAll('.palette-item')].indexOf(this) * 30 - list.scrollTop)
  }
  return rect(0)
}
const outfile = path.join(root, 'out/smoke-ui-palette.cjs')
await build({ stdin: { contents: "export { act, createElement } from 'react'; export { createRoot } from 'react-dom/client'; export { Palette } from './src/renderer/src/ui/Palette';", resolveDir: root, loader: 'tsx' }, outfile, bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'], logLevel: 'silent' })
const { act, createElement, createRoot, Palette } = await import(pathToFileURL(outfile).href)
const host = document.getElementById('app')
const app = createRoot(host)
const runs = []
let closes = 0
let commands = Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, label: `Command ${i}`, group: i % 2 ? 'Actions' : 'Pages', keywords: i === 11 ? 'secret-alias' : undefined, run: () => runs.push(i) }))
const render = async (open = true) => act(async () => app.render(createElement(Palette, { open, commands, onClose: () => { closes++ } })))
const input = () => host.querySelector('input')
const items = () => [...host.querySelectorAll('.palette-item')]
const selected = () => host.querySelector('.palette-item.active')
const key = async (value, options = {}) => act(async () => input().dispatchEvent(new window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...options })))
const query = async (value) => act(async () => {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input(), value)
  input().dispatchEvent(new window.Event('input', { bubbles: true }))
})
try {
  document.getElementById('trigger').focus()
  await render()
  assert.equal(document.activeElement, input())
  assert.equal(input().getAttribute('role'), 'combobox')
  assert.equal(document.getElementById(input().getAttribute('aria-controls')).getAttribute('role'), 'listbox')
  assert(items().every((item) => item.tabIndex === -1))
  await key('Tab', { shiftKey: true })
  assert.equal(document.activeElement, input(), 'focus trap must not select tabindex=-1 options')
  await key('ArrowDown')
  assert.equal(selected(), items()[1], 'navigation follows grouped visual order')
  await key('ArrowDown', { isComposing: true })
  assert.equal(selected(), items()[1], 'composition does not change selection')
  for (let i = 0; i < 20; i++) await key('ArrowDown')
  assert.equal(selected(), items().at(-1))
  assert(selected().getBoundingClientRect().bottom <= 100, 'last option scrolls into view')
  assert.equal(input().getAttribute('aria-activedescendant'), selected().id)
  assert.equal(document.activeElement, input())
  for (let i = 0; i < 20; i++) await key('ArrowUp')
  assert.equal(selected(), items()[0])
  assert(selected().getBoundingClientRect().top >= 0, 'first option scrolls back into view')
  await query('secret-alias')
  assert.equal(items().length, 1, 'keywords can match independently of the label')
  await key('Enter')
  assert.deepEqual(runs, [11])
  assert.equal(closes, 1)
  await query('nothing-matches-this')
  await key('ArrowDown')
  await key('Enter')
  assert.equal(input().getAttribute('aria-activedescendant'), null)
  assert.deepEqual(runs, [11], 'empty results do not execute commands')
  await query('')
  for (let i = 0; i < 11; i++) await key('ArrowDown')
  commands = [commands[0]]
  await render()
  assert.equal(selected(), items()[0], 'a shorter command list has a valid selection')
  await key('Enter')
  assert.deepEqual(runs, [11, 0])
  await render(false)
  assert.equal(host.querySelector('.palette'), null)
  assert.equal(document.activeElement, document.getElementById('trigger'))
  console.log('PALETTE NAVIGATION SMOKE PASSED: grouping, scrolling, focus, ARIA, filtering, empty results and command replacement')
} finally {
  await act(async () => app.unmount())
  dom.window.close()
}
