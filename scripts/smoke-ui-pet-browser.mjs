import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { build } from 'vite'
import react from '@vitejs/plugin-react'

const root = path.resolve(import.meta.dirname, '..')
const source = path.join(root, 'out', 'ui-pet-visual-source')
const output = path.join(root, 'out', 'ui-pet-visual')
const screenshots = path.join(root, 'gui-test-screenshots', 'workflow-pet-final')
await fs.mkdir(source, { recursive: true })
await fs.mkdir(screenshots, { recursive: true })
await fs.writeFile(path.join(source, 'index.html'), '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Assistant Settings Preview</title></head><body><div id="root"></div><script type="module" src="../../scripts/fixtures/ui-pet-visual-entry.ts"></script></body></html>')
await build({ configFile: false, root: source, plugins: [react()], base: '/', logLevel: 'warn', build: { outDir: output, emptyOutDir: true, chunkSizeWarningLimit: 2000 } })
const server = createServer(async (request, response) => {
  try {
    const requested = new URL(request.url, 'http://localhost').pathname
    const file = path.resolve(output, requested === '/' ? 'index.html' : `.${requested}`)
    if (!file.startsWith(output + path.sep)) { response.writeHead(403).end(); return }
    response.setHeader('Content-Type', { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' }[path.extname(file)] ?? 'application/octet-stream')
    response.end(await fs.readFile(file))
  } catch { response.writeHead(404).end() }
})
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
let browser
try {
  const { chromium } = await import(pathToFileURL(path.join(root, 'out/visual-tools/node_modules/playwright-core/index.mjs')).href)
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage({ reducedMotion: 'reduce' })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const url = `http://127.0.0.1:${server.address().port}`
  await page.route('**/*', (route) => route.request().url().startsWith(url) ? route.continue() : route.abort())
  const metrics = []
  for (const [width, height] of [[400, 540], [640, 720]]) {
    await page.setViewportSize({ width, height })
    for (const theme of ['light', 'dark']) {
      await page.goto(`${url}/#/pet-settings`)
      await page.locator('.pet-settings-page textarea').first().waitFor()
      await page.evaluate((theme) => window.agentdeck.settings.set({ theme }), theme)
      await page.waitForTimeout(60)
      const geometry = await page.locator('.pet-settings-page').evaluate((view) => ({
        overflow: view.scrollWidth - view.clientWidth,
        clipped: [...view.querySelectorAll('button, input, textarea, select')].filter((element) => element.getClientRects().length).map((element) => ({ element, rect: element.getBoundingClientRect() })).filter(({ element, rect }) => rect.left < 0 || rect.right > innerWidth + 1 || rect.width <= 0 || (element.tagName === 'BUTTON' && element.scrollWidth > element.clientWidth + 1)).map(({ element }) => element.textContent.trim() || element.getAttribute('type')),
        theme: document.documentElement.classList.contains('light') ? 'light' : 'dark'
      }))
      await page.screenshot({ path: path.join(screenshots, `${width}-${theme}-top.png`) })
      metrics.push({ width, height, ...geometry })
      assert.equal(geometry.theme, theme)
      assert.equal(geometry.clipped.length, 0, `Settings controls must fit: ${JSON.stringify(geometry)}`)
      assert(geometry.overflow <= 1, `Settings must not overflow: ${JSON.stringify(geometry)}`)
      const persona = page.locator('textarea').first()
      await persona.fill('Browser fixture persona')
      await page.getByRole('button', { name: '保存人设', exact: true }).click()
      assert.equal(await page.evaluate(() => window.__petVisual.snapshot().personaPrompt), 'Browser fixture persona')
      await page.getByRole('button', { name: '开始生成', exact: true }).scrollIntoViewIfNeeded()
      await page.screenshot({ path: path.join(screenshots, `${width}-${theme}-generation.png`) })
      assert.equal(await page.evaluate(() => window.__petVisual.calls.genStart.length), 0, 'Geometry checks never invoke generation')
      await page.goto(`${url}/?failRead=1#/pet-settings`)
      await page.locator('[data-pet-read="error"]').waitFor()
      await page.evaluate(() => { window.agentdeck.pet.getState = async () => window.__petVisual.snapshot() })
      await page.getByRole('button', { name: '重试', exact: true }).click()
      await page.locator('.pet-settings-page textarea').first().waitFor()
    }
  }
  assert.deepEqual(errors, [], 'No renderer exceptions')
  await fs.writeFile(path.join(screenshots, 'metrics.json'), JSON.stringify(metrics, null, 2))
  console.log(JSON.stringify({ screenshots, cases: metrics.length, errors, metrics }, null, 2))
} finally {
  await browser?.close()
  await new Promise((resolve) => server.close(resolve))
}
