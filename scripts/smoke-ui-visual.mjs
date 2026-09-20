// Real renderer and CSS, isolated sample data, no main-process or agent execution.
import { build } from 'vite'
import react from '@vitejs/plugin-react'
import { createServer } from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const output = path.join(root, 'out', 'ui-visual')
const source = path.join(root, 'out', 'ui-visual-source')
await fs.mkdir(source, { recursive: true })
await fs.writeFile(path.join(source, 'index.html'), '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AgentDeck Preview</title></head><body><div id="root"></div><script type="module" src="../../scripts/fixtures/ui-visual-entry.ts"></script></body></html>')
await build({ configFile: false, root: source, plugins: [react()], base: '/', logLevel: 'warn', build: { outDir: output, emptyOutDir: false, chunkSizeWarningLimit: 2000 } })
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' }
const server = createServer(async (req, res) => {
  try {
    const file = path.resolve(output, '.' + (new URL(req.url, 'http://localhost').pathname === '/' ? '/index.html' : new URL(req.url, 'http://localhost').pathname))
    if (!file.startsWith(output + path.sep)) { res.writeHead(403).end(); return }
    res.setHeader('Content-Type', types[path.extname(file)] ?? 'application/octet-stream')
    res.end(await fs.readFile(file))
  } catch { res.writeHead(404).end() }
})
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(process.argv.includes('--serve') ? Number(process.env.VISUAL_PORT ?? 4173) : 0, '127.0.0.1', resolve) })
const url = `http://127.0.0.1:${server.address().port}`
console.log(`Isolated renderer preview: ${url}`)
if (process.argv.includes('--serve')) {
  console.log('Sample data only; agent execution and filesystem operations are stubbed.')
} else {
  let browser
  try {
    const { chromium } = await import(pathToFileURL(path.join(root, 'out/visual-tools/node_modules/playwright-core/index.mjs')).href)
    browser = await chromium.launch({ channel: 'msedge', headless: true })
    const shots = path.join(root, 'gui-test-screenshots', process.env.VISUAL_RUN ?? 'visual-repair')
    await fs.mkdir(shots, { recursive: true })
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, reducedMotion: 'reduce' })
    const errors = []
    page.on('pageerror', (error) => { errors.push(error.message); console.error(error.message) })
    await page.goto(url)
    await page.waitForSelector('.view-header', { state: 'attached' })
    const pages = [['issues', 'Issue'], ['board', '看板'], ['agents', 'Agent'], ['automation', '自动化'], ['skills', '扩展'], ['usage', '用量'], ['settings', '设置']]
    const metrics = []
    const images = []
    const checks = []
    const check = (ok, label, details) => { checks.push({ ok, label, ...(details ? { details } : {}) }); if (!ok) console.error(`FAIL: ${label}${details ? ` ${JSON.stringify(details)}` : ''}`) }
    const checkPopover = async (label) => {
      const geometry = await page.locator('.meta-info-pop').evaluate((el) => {
        const pop = el.getBoundingClientRect()
        const detail = el.closest('.detail-left').getBoundingClientRect()
        const sidebar = document.querySelector('.sidebar').getBoundingClientRect()
        const visible = el.contains(document.elementFromPoint(pop.x + pop.width / 2, pop.y + Math.min(40, pop.height / 2)))
        const blocked = [...document.querySelectorAll('.sidebar .nav button')].filter((button) => {
          const r = button.getBoundingClientRect()
          return !button.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
        }).map((button) => button.textContent.trim())
        return { left: pop.left, right: pop.right, top: pop.top, bottom: pop.bottom, detailLeft: detail.left, detailRight: detail.right, sidebarRight: sidebar.right, viewportHeight: innerHeight, visible, blocked }
      })
      check(geometry.left >= geometry.detailLeft + 7 && geometry.right <= geometry.detailRight - 7, `${label}: information popover stays inside detail column`, geometry)
      check(geometry.left >= geometry.sidebarRight && geometry.blocked.length === 0, `${label}: information popover leaves sidebar navigation clickable`, geometry)
      check(geometry.visible && geometry.top >= 0 && geometry.bottom <= geometry.viewportHeight + 1, `${label}: information popover is visible within viewport`, geometry)
    }
    const checkDockRow = async (label, parentTop) => {
      const geometry = await page.locator('.dock-tab-row.is-active').evaluate((el) => {
        const row = el.getBoundingClientRect()
        const strip = el.closest('.dock-tabs')
        const bounds = strip.getBoundingClientRect()
        const close = el.querySelector('.dock-tab-close').getBoundingClientRect()
        return { rowLeft: row.left, rowRight: row.right, stripLeft: bounds.left, stripRight: bounds.right, closeLeft: close.left, closeRight: close.right, closeWidth: close.width, overflowing: strip.scrollWidth > strip.clientWidth, parentTop: el.closest('.detail').scrollTop }
      })
      check(geometry.overflowing, `${label}: fixture has genuine tab overflow`)
      check(geometry.rowLeft >= geometry.stripLeft - 1 && geometry.rowRight <= geometry.stripRight + 1, `${label}: entire active tab row is visible`, geometry)
      check(geometry.closeWidth > 0 && geometry.closeLeft >= geometry.stripLeft - 1 && geometry.closeRight <= geometry.stripRight + 1, `${label}: active tab close button is fully visible`, geometry)
      check(geometry.parentTop === parentTop, `${label}: parent task scroll position is preserved`, geometry)
    }
    for (const width of [1440, 980]) {
      await page.setViewportSize({ width, height: width === 1440 ? 900 : 560 })
      for (const theme of ['light', 'dark']) {
        for (const [view, title] of pages) {
          await page.evaluate(async ({ view, theme }) => { await window.agentdeck.settings.set({ theme }); window.__visual.ui.navigate(view) }, { view, theme })
          await page.locator('.view-header-title').filter({ hasText: title }).waitFor()
          await page.waitForTimeout(300)
          const info = await page.evaluate((view) => {
            const header = document.querySelector('.view-header')
            const title = header.querySelector('h1')
            const rect = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } }
            const s = getComputedStyle(title)
            const selectors = { issues: '.workspace-card', agents: '.tm-section-head', usage: '.us-hero', skills: '.ext-tabs', board: '.board-toolbar', automation: '.automation-content', settings: '.settings-layout' }
            const content = document.querySelector(selectors[view])
            const preceding = view === 'issues' ? document.querySelector('.issue-open-strip') ?? header : header
            return { h1s: [...document.querySelectorAll('main h1')].filter((el) => el.getClientRects().length).length, font: s.fontSize, weight: s.fontWeight, leading: s.lineHeight, header: rect(header), title: rect(title), main: rect(document.querySelector('main')), contentGap: content ? rect(content).y - (rect(preceding).y + rect(preceding).h) : null, texture: getComputedStyle(document.querySelector('main > :last-child')).backgroundImage !== 'none', overflow: document.querySelector('main').scrollWidth - document.querySelector('main').clientWidth, clipped: [...header.querySelectorAll('button')].filter((el) => el.getClientRects().length && !el.disabled).filter((el) => { const r = el.getBoundingClientRect(); return r.right > innerWidth + 1 || r.left < 0 || r.bottom > innerHeight }).map((el) => el.textContent.trim()) }
          }, view)
          check(info.header.h === 72, `${width}/${theme}/${view}: 72px page header`)
          check(Math.abs(info.title.x - info.main.x - (width === 1440 ? 52 : 44)) < 1, `${width}/${theme}/${view}: aligned title`)
          check(info.contentGap !== null && info.contentGap >= 0 && info.contentGap <= 40, `${width}/${theme}/${view}: content begins beneath header, no decorative spacer`)
          check(info.texture, `${width}/${theme}/${view}: background texture rendered`)
          metrics.push({ width, theme, view, ...info })
          const name = `${width}-${theme}-${view}.png`
          await page.screenshot({ path: path.join(shots, name) })
          await page.locator('.view-header').screenshot({ path: path.join(shots, `header-${name}`) })
          images.push({ width, theme, view, name })
        }
        await page.evaluate(() => { const { ui, mock } = window.__visual; ui.setTasks(mock.store.tasks); ui.openTask('visual-0') })
        await page.waitForSelector('.detail-left > .view-header')
        await page.locator('#detail-tab-log').click()
        check(await page.locator('.title-edit').evaluate((el) => getComputedStyle(el).opacity === '1'), `${width}/${theme}: rename button visible`)
        const scrollBefore = await page.locator('.detail').evaluate((el) => el.scrollTop)
        await page.screenshot({ path: path.join(shots, `${width}-${theme}-detail.png`) })
        await page.locator('.meta-info-btn').click()
        await checkPopover(`${width}/${theme}/without-dock`)
        await page.screenshot({ path: path.join(shots, `${width}-${theme}-information.png`) })
        await page.keyboard.press('Escape')
        await page.evaluate(() => window.__visual.ui.dock.open({ id: 'preview-file', kind: 'file', title: 'PageHeader.tsx', payload: { taskId: 'visual-0', file: 'src/renderer/src/ui/PageHeader.tsx', diff: '@@ -100,2 +100,2 @@\n-old heading\n+shared heading\n context', additions: 1, deletions: 1 } }))
        await page.waitForSelector('.side-dock')
        await page.waitForTimeout(100)
        check(await page.locator('.detail').evaluate((el, top) => el.scrollTop === top, scrollBefore), `${width}/${theme}: opening dock preserves task header position`)
        await page.screenshot({ path: path.join(shots, `${width}-${theme}-dock.png`) })
        await page.locator('.meta-info-btn').click()
        await checkPopover(`${width}/${theme}/with-dock`)
        await page.keyboard.press('Escape')
        const parentTop = await page.locator('.detail').evaluate((el) => el.scrollTop)
        await page.evaluate(() => {
          for (let i = 0; i < 8; i++) window.__visual.ui.dock.open({ id: `overflow-${i}`, kind: 'file', title: `LongFileNameForTabOverflow-${i}.tsx`, payload: { taskId: 'visual-0', file: `src/LongFileNameForTabOverflow-${i}.tsx`, content: 'export const ready = true' } })
        })
        await page.waitForTimeout(100)
        await checkDockRow(`${width}/${theme}/last-tab`, parentTop)
        await page.locator('.dock-tab[aria-selected=true]').evaluate((el) => el.focus({ preventScroll: true }))
        await page.keyboard.press('Home')
        await page.waitForTimeout(100)
        await checkDockRow(`${width}/${theme}/first-tab`, parentTop)
        await page.keyboard.press('End')
        await page.waitForTimeout(100)
        await checkDockRow(`${width}/${theme}/keyboard-last-tab`, parentTop)
        // After asserting scroll preservation, reveal the stacked Dock for its evidence screenshot.
        await page.locator('.dock-tabs').scrollIntoViewIfNeeded()
        await page.screenshot({ path: path.join(shots, `${width}-${theme}-many-tabs.png`) })
        await page.locator('.detail').evaluate((el, top) => { el.scrollTop = top }, parentTop)
        await page.evaluate(() => { for (let i = 0; i < 8; i++) window.__visual.ui.dock.close(`overflow-${i}`, { rootId: 'visual-0' }) })
        await page.evaluate(() => window.__visual.ui.dock.close('preview-file', { rootId: 'visual-0' }))
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.locator('.meta-info-btn').click()
    await page.setViewportSize({ width: 980, height: 560 })
    await page.waitForTimeout(150)
    await checkPopover('resize-while-open/980')
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.waitForTimeout(150)
    const hit = await page.locator('.meta-info-pop').evaluate((el) => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + Math.min(60, r.height / 2))) })
    check(hit, 'Task information popover is painted above content and is not clipped')
    await page.keyboard.press('Escape')
    await page.locator('.title-edit').click()
    await page.locator('.title-edit-input').fill('验证超长任务标题：统一页面布局、视觉层级、背景纹理以及侧边预览开启后的标题和操作可达性')
    await page.locator('.title-edit-input').press('Enter')
    await page.evaluate(() => window.__visual.mock.fireTaskUpdated('visual-0'))
    await page.locator('.task-title-text').filter({ hasText: '验证超长任务标题' }).waitFor()
    await page.setViewportSize({ width: 980, height: 560 })
    await page.waitForTimeout(150)
    const longTitle = await page.locator('.task-title-text').evaluate((el) => { const r = el.getBoundingClientRect(); return r.right <= innerWidth && el.scrollWidth <= el.clientWidth + 1 })
    check(longTitle, 'Long task title wraps without clipping or horizontal overflow')
    await page.screenshot({ path: path.join(shots, '980-dark-long-title.png') })
    await fs.writeFile(path.join(shots, 'metrics.json'), JSON.stringify({ metrics, checks, errors }, null, 2))
    const ordered = pages.flatMap(([view]) => images.filter((item) => item.width === 1440 && item.view === view))
    const cells = await Promise.all(ordered.map(async (item) => `<figure><figcaption>${item.theme} / ${item.view}</figcaption><img src="data:image/png;base64,${(await fs.readFile(path.join(shots, item.name))).toString('base64')}"></figure>`))
    await page.setViewportSize({ width: 1440, height: 900 })
    const sheet = (cells) => `<html><head><style>body{margin:0;padding:16px;background:#242629;color:#e9eaec;font:14px system-ui}main{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}figure{margin:0}figcaption{padding:8px 0}img{width:100%;display:block}</style></head><body><main>${cells.join('')}</main></body></html>`
    await page.setContent(sheet(cells))
    await page.screenshot({ path: path.join(shots, 'overview.png'), fullPage: true })
    const headerCells = await Promise.all(ordered.map(async (item) => `<figure><figcaption>${item.theme} / ${item.view}</figcaption><img src="data:image/png;base64,${(await fs.readFile(path.join(shots, `header-${item.name}`))).toString('base64')}"></figure>`))
    await page.setContent(sheet(headerCells))
    await page.screenshot({ path: path.join(shots, 'headers.png'), fullPage: true })
    const bad = metrics.filter((m) => m.h1s !== 1 || m.font !== '20px' || m.weight !== '600' || m.leading !== '28px' || m.overflow > 1 || m.clipped.length)
    console.log(JSON.stringify({ screenshots: shots, cases: metrics.length, checks: checks.length, failedChecks: checks.filter((c) => !c.ok), failures: bad, errors }, null, 2))
    if (bad.length || errors.length || checks.some((c) => !c.ok)) process.exitCode = 1
  } finally {
    await browser?.close()
    await new Promise((resolve) => server.close(resolve))
  }
}
