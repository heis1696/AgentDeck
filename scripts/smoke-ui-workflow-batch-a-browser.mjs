import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { build } from 'vite'
import react from '@vitejs/plugin-react'

const root = path.resolve(import.meta.dirname, '..')
const output = path.join(root, 'out', 'ui-workflow-batch-a-browser')
const source = path.join(root, 'out', 'ui-workflow-batch-a-browser-source')
await fs.mkdir(source, { recursive: true })
await fs.writeFile(path.join(source, 'index.html'), '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AgentDeck workflow smoke</title></head><body><div id="root"></div><script type="module" src="../../scripts/fixtures/ui-workflow-batch-a-browser.ts"></script></body></html>')
await build({ configFile: false, root: source, plugins: [react()], base: '/', logLevel: 'warn', build: { outDir: output, emptyOutDir: true } })

const server = createServer(async (request, response) => {
  try {
    const requestPath = new URL(request.url ?? '/', 'http://localhost').pathname
    const file = path.resolve(output, requestPath === '/' ? 'index.html' : `.${requestPath}`)
    if (!file.startsWith(output + path.sep)) { response.writeHead(403).end(); return }
    response.setHeader('Content-Type', file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') ? 'text/javascript' : 'text/css')
    response.end(await fs.readFile(file))
  } catch { response.writeHead(404).end() }
})
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
const port = server.address().port
const playwrightRoot = await fs.access(path.join(root, 'out', 'visual-tools', 'node_modules', 'playwright-core', 'index.mjs')).then(() => path.join(root, 'out', 'visual-tools', 'node_modules', 'playwright-core', 'index.mjs')).catch(() => path.join(root, '..', '..', 'out', 'visual-tools', 'node_modules', 'playwright-core', 'index.mjs'))
const { chromium } = await import(pathToFileURL(playwrightRoot).href)
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await browser.newPage({ viewport: { width: 980, height: 560 }, deviceScaleFactor: 1, reducedMotion: 'reduce' })
const screenshots = path.join(root, 'gui-test-screenshots', 'workflow-batch-a-browser')
await fs.mkdir(screenshots, { recursive: true })
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
try {
  await page.goto(`http://127.0.0.1:${port}`)
  await page.locator('.agent-picker-trigger').waitFor()
  const home = await page.evaluate(() => {
    const prompt = document.querySelector('.workspace-prompt').getBoundingClientRect()
    const workspace = document.querySelector('.workspace').getBoundingClientRect()
    const recent = document.querySelector('.issue-recent').getBoundingClientRect()
    return { prompt, workspace, recent, viewport: { width: innerWidth, height: innerHeight } }
  })
  assert.ok(home.prompt.top >= home.workspace.top - 1 && home.prompt.bottom <= home.viewport.height + 1, `composer is reachable at 980x560: ${JSON.stringify(home)}`)
  assert.ok(home.recent.top > home.prompt.bottom, `recent tasks follow the composer: ${JSON.stringify(home)}`)
  await page.screenshot({ path: path.join(screenshots, '980-dark-issue-home.png') })

  const trigger = page.locator('.agent-picker-trigger')
  await trigger.click()
  await page.locator('.agent-picker-search input').waitFor()
  assert.equal(await page.locator('.agent-picker-option').count(), 20, 'browser picker keeps all 20 non-Forge Agents')
  const firstMenu = await page.locator('.agent-picker-menu').evaluate((menu) => {
    const popup = menu.getBoundingClientRect()
    const selected = menu.querySelector('[aria-selected="true"]')
    const selectedRect = selected.getBoundingClientRect()
    const options = menu.querySelector('.agent-picker-options').getBoundingClientRect()
    return { popup, selectedRect, options, viewport: { width: innerWidth, height: innerHeight }, selectedVisible: selectedRect.top >= options.top - 1 && selectedRect.bottom <= options.bottom + 1 }
  })
  assert.ok(firstMenu.popup.left >= 0 && firstMenu.popup.right <= 980 && firstMenu.popup.top >= 0 && firstMenu.popup.bottom <= 560, `picker stays inside 980x560: ${JSON.stringify(firstMenu)}`)
  assert.ok(firstMenu.selectedVisible, `selected Agent opens in view: ${JSON.stringify(firstMenu)}`)
  for (let i = 0; i < 19; i++) await page.locator('.agent-picker-search input').press('ArrowDown')
  const activeMenu = await page.locator('.agent-picker-menu').evaluate((menu) => {
    const item = menu.querySelector('.agent-picker-option.active').getBoundingClientRect()
    const options = menu.querySelector('.agent-picker-options')
    const bounds = options.getBoundingClientRect()
    return { item, bounds, scrollTop: options.scrollTop, visible: item.top >= bounds.top - 1 && item.bottom <= bounds.bottom + 1 }
  })
  assert.ok(activeMenu.scrollTop > 0 && activeMenu.visible, `active Agent stays visible while navigating: ${JSON.stringify(activeMenu)}`)
  await page.locator('.agent-picker-search input').press('Enter')
  await page.waitForTimeout(50)
  assert.strictEqual(await page.evaluate(() => document.activeElement?.classList.contains('agent-picker-trigger')), true, 'picker returns focus to trigger')
  await trigger.click()
  const selectedAfter = await page.locator('.agent-picker-option[aria-selected="true"]').evaluate((item) => {
    const optionList = item.closest('.agent-picker-options').getBoundingClientRect()
    const selected = item.getBoundingClientRect()
    return { optionList, selected, visible: selected.top >= optionList.top - 1 && selected.bottom <= optionList.bottom + 1, active: item.classList.contains('active') }
  })
  assert.ok(selectedAfter.visible && selectedAfter.active, `reopened picker tracks current selection: ${JSON.stringify(selectedAfter)}`)
  await page.keyboard.press('Escape')

  await page.setViewportSize({ width: 360, height: 360 })
  await trigger.click()
  const narrow = await page.locator('.agent-picker-menu').evaluate((menu) => { const r = menu.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: innerWidth, height: innerHeight } })
  assert.ok(narrow.left >= 0 && narrow.right <= narrow.width && narrow.top >= 0 && narrow.bottom <= narrow.height, `picker stays inside narrow viewport: ${JSON.stringify(narrow)}`)
  await page.screenshot({ path: path.join(screenshots, '360-dark-agent-picker.png') })
  await page.keyboard.press('Escape')
  assert.deepEqual(errors, [], `browser renderer has no exceptions: ${JSON.stringify(errors)}`)
  console.log(JSON.stringify({ screenshots, checks: 9, errors }, null, 2))
} finally {
  await browser.close()
  await new Promise((resolve) => server.close(resolve))
}
