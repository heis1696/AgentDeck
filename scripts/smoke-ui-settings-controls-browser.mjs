#!/usr/bin/env node
/**
 * scripts/smoke-ui-settings-controls-browser.mjs — Settings controls, real Chromium
 * (docs/UI-DETAIL-FEEDBACK.md §B: general / runtime / updates / tuning / storage).
 *
 * 只驱动真实渲染层 + 真实样式表 + 隔离样例桥（scripts/fixtures/ui-settings-controls-browser.ts）：
 * 不起主进程、不执行 agent、不写生产设置、不落盘。
 *
 * 覆盖的验收点：
 *   1. 可见边界 = 命中区：在真实坐标上，紧贴自定义下拉/按钮可视边界之外点击不得触发，
 *      边界内（中心/左缘/右缘/下缘）必须触发。包裹式 <label> 的空白区同样不得打开菜单。
 *   2. 键盘操作：Enter/↓ 都能打开、打开态 Esc 只关菜单（不写盘、焦点留在触发器）、
 *      ↑↓ 双向移动高亮（↓ 之后 ↑ 回到原项）、Enter 选中并归还焦点。
 *   3. 普通 label 只能聚焦输入框 / 切换复选框，点击留白不得改动滑杆或复选框。
 *   4. 禁用控件不可点（保存路径、开始更新）。
 *   5. 保留既有保存队列与草稿保护：脏值、保存中、保存失败、检测前先保存、连点去重。
 *   6. 五个分区在 1440x900 / 980x560、明暗两套主题下控件几何一致且不出界。
 *
 * 运行：node scripts/smoke-ui-settings-controls-browser.mjs
 * （package scripts 属共享文件，登记由领队统一处理；本文件不自行接入。）
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { build } from 'vite'
import react from '@vitejs/plugin-react'

const root = path.resolve(import.meta.dirname, '..')
const output = path.join(root, 'out', 'ui-settings-controls-browser')
const source = path.join(root, 'out', 'ui-settings-controls-browser-source')
await fs.mkdir(source, { recursive: true })
await fs.writeFile(path.join(source, 'index.html'), '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><title>AgentDeck settings controls smoke</title></head><body><div id="root"></div><script type="module" src="../../scripts/fixtures/ui-settings-controls-browser.ts"></script></body></html>')
await build({ configFile: false, root: source, plugins: [react()], base: '/', logLevel: 'warn', build: { outDir: output, emptyOutDir: true, chunkSizeWarningLimit: 2000 } })

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }
const server = createServer(async (request, response) => {
  try {
    const requestPath = new URL(request.url ?? '/', 'http://localhost').pathname
    const file = path.resolve(output, requestPath === '/' ? 'index.html' : `.${requestPath}`)
    if (!file.startsWith(output + path.sep)) { response.writeHead(403).end(); return }
    response.setHeader('Content-Type', types[path.extname(file)] ?? 'application/octet-stream')
    response.end(await fs.readFile(file))
  } catch { response.writeHead(404).end() }
})
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
const port = server.address().port
const playwrightRoot = await fs.access(path.join(root, 'out', 'visual-tools', 'node_modules', 'playwright-core', 'index.mjs')).then(() => path.join(root, 'out', 'visual-tools', 'node_modules', 'playwright-core', 'index.mjs')).catch(() => path.join(root, '..', '..', 'out', 'visual-tools', 'node_modules', 'playwright-core', 'index.mjs'))
const { chromium } = await import(pathToFileURL(playwrightRoot).href)
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const screenshots = path.join(root, 'gui-test-screenshots', 'settings-controls')
await fs.mkdir(screenshots, { recursive: true })

const checks = []
const check = (ok, label, details) => {
  checks.push({ ok, label })
  if (!ok) console.error(`FAIL: ${label}${details === undefined ? '' : ` ${JSON.stringify(details)}`}`)
}
const CONTROL_MIN_HEIGHT = 36

const SECTIONS = ['general', 'runtime', 'updates', 'advanced', 'storage']

const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, reducedMotion: 'reduce' })
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
page.on('console', (message) => { if (message.type() === 'error') errors.push(`console: ${message.text()}`) })

/** 真实坐标点击的取点：滚动到位后返回视口坐标；margin 用于给「下方 Npx」留出视口空间 */
const pointOf = async (selector, margin = 0) => {
  const locator = page.locator(selector).first()
  await locator.scrollIntoViewIfNeeded()
  await settle()
  if (margin > 0) {
    const first = await locator.boundingBox()
    assert.ok(first, `missing bounding box for ${selector}`)
    const viewport = await page.evaluate(() => window.innerHeight)
    const deficit = Math.ceil(first.y + first.height + margin - viewport)
    if (deficit > 0) {
      await page.evaluate((dy) => { const body = document.querySelector('.settings-body'); if (body) body.scrollTop += dy }, deficit + 6)
      await settle()
    }
  }
  const box = await locator.boundingBox()
  assert.ok(box, `missing bounding box for ${selector}`)
  return box
}
const hitAt = (x, y) => page.evaluate(([px, py]) => {
  const node = document.elementFromPoint(px, py)
  if (!node) return null
  const path = []
  for (let el = node; el && path.length < 4; el = el.parentElement) path.push(`${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/).join('.')}` : ''}`)
  const trigger = node.closest('.menu-trigger')
  return { path, inTrigger: Boolean(trigger), inLabel: Boolean(node.closest('label')) }
}, [x, y])
const menuOpen = () => page.locator('.menu-panel').count()
const expanded = (selector) => page.locator(selector).first().getAttribute('aria-expanded')
const settle = () => page.waitForTimeout(60)
/** 单个行为组失败不吞掉其余用例：记录成失败检查后继续跑完整轮 */
const group = async (label, fn) => {
  try { await fn() } catch (error) { check(false, `${label}: ${error.message}`) }
}
const openSection = async (section) => {
  await page.evaluate((name) => window.__settings.ui.openSettings(name), section)
  await page.locator('.settings-card').first().waitFor()
  await settle()
}

/**
 * 自定义下拉的边界命中验收：
 * 上方 8px / 2px、下方 8px、标签文字上都不得打开；中心与左右下内缘必须打开。
 * 每个探测点都重新量一次包围盒（滚动/重渲染后旧坐标就不是用户看到的坐标了），
 * 并用 Math.floor/ceil 对齐到 Chromium 实际命中用的像素栅格，避免亚像素噪声。
 * 全部用例都记录结果（不中断），一次运行就能看到完整缺陷面。
 */
const checkDropdownBounds = async (label, selector, labelSelector) => {
  const center = (box) => [Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2)]
  const outsideCases = [
    ['8px-above', async () => { const box = await pointOf(selector); return [Math.round(box.x + box.width / 2), Math.floor(box.y) - 8] }],
    ['2px-above', async () => { const box = await pointOf(selector); return [Math.round(box.x + box.width / 2), Math.floor(box.y) - 2] }],
    ['8px-below', async () => { const box = await pointOf(selector, 8); return [Math.round(box.x + box.width / 2), Math.ceil(box.y + box.height) + 8] }],
    ['label-text', async () => { const box = await pointOf(labelSelector); return center(box) }]
  ]
  const insideCases = [
    ['center', (box) => center(box)],
    ['left-edge', (box) => [Math.round(box.x + 2), Math.round(box.y + box.height / 2)]],
    ['right-edge', (box) => [Math.round(box.x + box.width - 2), Math.round(box.y + box.height / 2)]],
    ['bottom-edge', (box) => [Math.round(box.x + box.width / 2), Math.round(box.y + box.height - 2)]]
  ]

  for (const [name, point] of outsideCases) {
    const [x, y] = await point()
    const target = await hitAt(x, y)
    assert.ok(target && !target.inTrigger, `${label}: ${name} precondition — the point must be outside the trigger (got ${JSON.stringify(target)})`)
    await page.mouse.click(x, y)
    await settle()
    check(await menuOpen() === 0, `${label}: clicking ${name} (outside the visible boundary) must not open the menu`)
    check(await expanded(selector) === 'false', `${label}: ${name} must not report aria-expanded`)
    if (await menuOpen() > 0) await page.keyboard.press('Escape')
    await settle()
  }

  for (const [name, pick] of insideCases) {
    const box = await pointOf(selector)
    const [x, y] = pick(box)
    const target = await hitAt(x, y)
    assert.ok(target?.inTrigger, `${label}: ${name} precondition — the point must hit the trigger (got ${JSON.stringify(target)})`)
    await page.mouse.click(x, y)
    await settle()
    check(await menuOpen() === 1, `${label}: clicking the visible ${name} opens the menu`)
    check(await expanded(selector) === 'true', `${label}: ${name} reports aria-expanded`)
    await page.keyboard.press('Escape')
    await settle()
    check(await menuOpen() === 0, `${label}: Escape closes the menu`)
    check(await page.evaluate(() => document.activeElement?.classList.contains('menu-trigger')), `${label}: closing returns focus to the trigger`)
  }

  // 打开状态下点击按钮左侧 4px 的卡片留白：只能关闭，不能被当成再次打开
  const box = await pointOf(selector)
  const [cx, cy] = center(box)
  await page.mouse.click(cx, cy)
  await settle()
  const reopened = await menuOpen() === 1
  check(reopened, `${label}: the trigger reopens for the outside-click check`)
  if (reopened) {
    await page.mouse.click(Math.round(box.x - 4), cy)
    await settle()
    check(await menuOpen() === 0, `${label}: clicking outside closes the open menu without reopening`)
  }
}

const checkSliderLabelSafety = async () => {
  const slider = page.locator('.settings-page input[type=range]').first()
  await slider.scrollIntoViewIfNeeded()
  const before = await slider.inputValue()
  const label = page.locator('.settings-page .field:has(input[type=range]) .field-label').first()
  const labelBox = await label.boundingBox()
  await page.mouse.click(Math.round(labelBox.x + labelBox.width / 2), Math.round(labelBox.y + labelBox.height / 2))
  await settle()
  assert.equal(await slider.inputValue(), before, 'clicking the slider label must not move the slider')
  const box = await slider.boundingBox()
  await page.mouse.click(Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2))
  await settle()
  const moved = Number(await slider.inputValue())
  assert.ok(Number.isInteger(moved) && moved >= 1 && moved <= 4, `clicking the slider track sets an in-range value (got ${moved})`)
  assert.ok(await page.evaluate(() => window.__settings.probe.saves.some((patch) => 'concurrency' in patch)), 'slider change is committed through the existing save path')
}

const checkToggleLabelSafety = async () => {
  const box = page.locator('.settings-page input[type=checkbox]').first()
  await box.scrollIntoViewIfNeeded()
  const before = await box.isChecked()
  const labelText = page.locator('.settings-page .row-field:has(input[type=checkbox]) > span').first()
  const textBox = await labelText.boundingBox()
  await page.mouse.click(Math.round(textBox.x + textBox.width / 2), Math.round(textBox.y + textBox.height / 2))
  await settle()
  assert.equal(await box.isChecked(), !before, 'clicking a checkbox label toggles it (ordinary label semantics preserved)')
  const rowBox = await page.locator('.settings-page .row-field:has(input[type=checkbox])').first().boundingBox()
  await page.mouse.click(Math.round(rowBox.x + rowBox.width / 2), Math.round(rowBox.y + rowBox.height + 14))
  await settle()
  assert.equal(await box.isChecked(), !before, 'clicking blank card space below a checkbox row leaves it unchanged')
}

const checkDisabledControls = async () => {
  await openSection('runtime')
  await page.evaluate(() => window.__settings.probe.reset())
  const save = page.locator('.settings-page .settings-card').first().getByRole('button', { name: /保存路径/ })
  assert.equal(await save.isDisabled(), true, 'clean path state keeps 保存路径 disabled')
  const box = await save.boundingBox()
  await page.mouse.click(Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2))
  await settle()
  assert.equal(await page.evaluate(() => window.__settings.probe.saves.length), 0, 'clicking a disabled button writes nothing')
  await openSection('updates')
  const apply = page.getByRole('button', { name: /开始更新/ })
  assert.equal(await apply.isDisabled(), true, '开始更新 stays disabled before a check')
  const applyBox = await apply.boundingBox()
  await page.mouse.click(Math.round(applyBox.x + applyBox.width / 2), Math.round(applyBox.y + applyBox.height / 2))
  await settle()
  assert.equal(await page.evaluate(() => window.__settings.probe.checks), 0, 'clicking the disabled apply button starts nothing')
}

/** 保留既有保存队列：保存中不改草稿、失败保留草稿、检测前先保存、连点只写一次 */
const checkWriteQueuePreserved = async () => {
  await openSection('runtime')
  await page.evaluate(() => window.__settings.probe.reset())
  const inputs = page.locator('.settings-page .settings-card').first().locator('input')
  const zcode = inputs.nth(0)
  const node = inputs.nth(1)
  const save = page.locator('.settings-page .settings-card').first().getByRole('button', { name: /保存路径/ })
  const probe = page.locator('.settings-page .settings-card').first().getByRole('button', { name: /检测路径可用性/ })

  await page.evaluate(() => { window.__settings.probe.saveDelayMs = 150 })
  await zcode.fill('D:\\Slow\\zcode.cjs')
  await save.click()
  await settle()
  assert.equal(await save.isDisabled(), true, '保存中按钮进入 pending（不可重复提交）')
  await node.fill('C:\\Program Files\\nodejs\\node.exe')
  await page.waitForTimeout(250)
  assert.equal(await node.inputValue(), 'C:\\Program Files\\nodejs\\node.exe', '保存期间继续输入的新草稿不被设置广播回写清掉')
  assert.equal(await zcode.inputValue(), 'D:\\Slow\\zcode.cjs', '已保存字段与草稿一致')

  await page.evaluate(() => { window.__settings.probe.saveDelayMs = 0 })
  await page.evaluate(() => { window.__settings.probe.saves = []; window.__settings.probe.probes = 0 })
  await probe.click()
  await page.waitForTimeout(150)
  const ordered = await page.evaluate(() => ({ saves: window.__settings.probe.saves.length, probes: window.__settings.probe.probes }))
  assert.deepEqual(ordered, { saves: 1, probes: 1 }, '检测前必须先落盘脏路径再探测（save → probe）')

  await page.evaluate(() => { window.__settings.probe.failSaves = true; window.__settings.probe.saves = []; window.__settings.probe.probes = 0 })
  await zcode.fill('D:\\Broken\\zcode.cjs')
  await save.click()
  await page.waitForTimeout(120)
  assert.equal(await zcode.inputValue(), 'D:\\Broken\\zcode.cjs', '保存失败后草稿保留在输入框')
  assert.equal(await page.locator('[data-paths-error]').count(), 1, '保存失败就地回显')
  await probe.click()
  await page.waitForTimeout(120)
  assert.equal(await page.evaluate(() => window.__settings.probe.probes), 0, '保存失败不得继续探测')
  await page.evaluate(() => { window.__settings.probe.failSaves = false })
  await zcode.fill('D:\\Good\\zcode.cjs')
  await page.evaluate(() => { window.__settings.probe.saves = [] })
  await save.click()
  await save.click({ force: true })
  await page.waitForTimeout(120)
  assert.equal(await page.evaluate(() => window.__settings.probe.saves.length), 1, '连点保存只写一次')
}

const checkUpdateOrdering = async () => {
  await openSection('updates')
  await page.evaluate(() => window.__settings.probe.reset())
  const feed = page.locator('.settings-page input').first()
  await feed.scrollIntoViewIfNeeded()
  await feed.fill('https://feed.example/new')
  const dirty = await page.locator('[data-feed-dirty]').count()
  check(dirty === 1, 'feed 草稿脏值可见')
  await page.getByRole('button', { name: /检查更新/ }).click()
  await page.waitForTimeout(150)
  const result = await page.evaluate(() => ({ saves: window.__settings.probe.saves.length, checks: window.__settings.probe.checks, first: window.__settings.probe.saves[0] }))
  assert.equal(result.saves >= 1 && result.checks === 1, true, '检查更新先落盘 feed 草稿再查询')
  assert.equal(result.first?.updateFeedUrl, 'https://feed.example/new', '保存的是输入框里的确切地址')
  assert.equal(await page.getByRole('button', { name: /开始更新/ }).isEnabled(), true, '检查到可用更新后「开始更新」开放')
}

/** 分区几何：控件高度一致、不出界、命中自身（逐个滚入视口后按真实坐标自测） */
const checkSectionGeometry = async (width, theme, section) => {
  await openSection(section)
  const geometry = await page.evaluate((minHeight) => {
    const stack = document.querySelector('.settings-stack')
    if (!stack) return null
    const body = document.querySelector('.settings-body')
    const bodyRect = body.getBoundingClientRect()
    const controls = [...stack.querySelectorAll('.btn, input:not([type=hidden]), select, textarea')]
      .filter((node) => node.getClientRects().length > 0)
    const tooShort = []
    const escaped = []
    const selfHitFailures = []
    for (const node of controls) {
      node.scrollIntoView({ block: 'center' })
      const rect = node.getBoundingClientRect()
      const style = getComputedStyle(node)
      const atomic = node.type !== 'checkbox' && node.type !== 'range' && node.tagName !== 'TEXTAREA'
      if (atomic && rect.height < minHeight - 0.5) tooShort.push({ cls: node.className, type: node.type || node.tagName, height: Math.round(rect.height) })
      if (rect.left < bodyRect.left - 1 || rect.right > bodyRect.right + 1) escaped.push({ cls: node.className, left: Math.round(rect.left), right: Math.round(rect.right), bodyRight: Math.round(bodyRect.right) })
      if (style.visibility === 'hidden' || style.display === 'none' || style.pointerEvents === 'none') escaped.push({ cls: node.className, hidden: true })
      if (node.disabled) continue
      const x = Math.round(rect.left + rect.width / 2)
      const y = Math.round(rect.top + rect.height / 2)
      const hit = document.elementFromPoint(x, y)
      if (!(hit === node || node.contains(hit))) selfHitFailures.push({ cls: node.className, type: node.type || node.tagName, hit: hit ? `${hit.tagName}.${hit.className}` : 'none' })
    }
    body.scrollTop = 0
    return { count: controls.length, tooShort, escaped, selfHitFailures, scrollOverflow: body.scrollWidth - body.clientWidth }
  }, CONTROL_MIN_HEIGHT)
  assert.ok(geometry && geometry.count > 0, `${width}/${theme}/${section}: controls rendered`)
  check(geometry.tooShort.length === 0, `${width}/${theme}/${section}: inputs/buttons/selects share the ${CONTROL_MIN_HEIGHT}px control height`, geometry.tooShort)
  check(geometry.escaped.length === 0, `${width}/${theme}/${section}: every control stays inside the settings body`, geometry.escaped)
  check(geometry.selfHitFailures.length === 0, `${width}/${theme}/${section}: each control owns its own hit area`, geometry.selfHitFailures)
  check(geometry.scrollOverflow <= 1, `${width}/${theme}/${section}: settings body has no horizontal overflow`, geometry.scrollOverflow)
  return geometry.count
}

/**
 * 键盘操作：Tab 走到触发器时必须看得见焦点环；Enter 与 ↓ 是等价的打开路径；
 * 打开态 Esc 只关菜单（不写设置、焦点留在触发器）；↑↓ 双向移动高亮；Enter 选中并归还焦点。
 */
const checkKeyboardOperation = async (label) => {
  await openSection('general')
  const trigger = page.locator('.settings-page .menu-trigger').first()
  /** 焦点是否正好落在被测触发器上（不是「某个 .menu-trigger」——同页还有第二个下拉） */
  const triggerFocused = () => page.evaluate(() => document.activeElement === document.querySelector('.settings-page .menu-trigger'))
  const activeOption = () => page.locator('.menu-panel .menu-item.active').textContent()
  await page.locator('.settings-body').click({ position: { x: 4, y: 6 } })
  let tabs = 0
  let focused = false
  for (; tabs < 40 && !focused; tabs += 1) {
    await page.keyboard.press('Tab')
    focused = await triggerFocused()
  }
  check(focused, `${label}: Tab reaches the dropdown trigger`, { tabs })
  const focusRing = await page.evaluate(() => (document.activeElement?.classList.contains('menu-trigger') ? getComputedStyle(document.activeElement).boxShadow : 'no-trigger-focus'))
  check(focusRing !== 'none' && focusRing !== '' && focusRing !== 'no-trigger-focus', `${label}: the keyboard-focused trigger renders a visible focus ring`, focusRing)

  // ↓ 打开：与 Enter 等价的第二条键盘打开路径（不必先回车）
  await page.keyboard.press('ArrowDown')
  await settle()
  check(await menuOpen() === 1, `${label}: ArrowDown opens the dropdown`)
  check(await trigger.getAttribute('aria-expanded') === 'true', `${label}: ArrowDown opening reports aria-expanded`)

  // 打开态 Esc：只关菜单，不改设置、不写盘、焦点仍在触发器上
  const beforeEscape = await page.evaluate(() => ({ theme: window.__settings.getSettings().theme, saves: window.__settings.probe.saves.length }))
  await page.keyboard.press('Escape')
  await settle()
  check(await menuOpen() === 0, `${label}: Escape closes the open dropdown`)
  check(await trigger.getAttribute('aria-expanded') === 'false', `${label}: Escape clears aria-expanded on the trigger`)
  check(await triggerFocused(), `${label}: Escape keeps focus on the trigger`)
  const afterEscape = await page.evaluate(() => ({ theme: window.__settings.getSettings().theme, saves: window.__settings.probe.saves.length }))
  check(afterEscape.theme === beforeEscape.theme && afterEscape.saves === beforeEscape.saves, `${label}: Escape writes nothing`, { beforeEscape, afterEscape })

  await page.keyboard.press('Enter')
  await settle()
  check(await menuOpen() === 1, `${label}: Enter opens the dropdown`)
  check(await trigger.getAttribute('aria-expanded') === 'true', `${label}: the open dropdown reports aria-expanded`)
  const firstActive = await activeOption()
  await page.keyboard.press('ArrowDown')
  await settle()
  const secondActive = await activeOption()
  check(firstActive !== secondActive, `${label}: ArrowDown moves the active option`, { firstActive, secondActive })
  await page.keyboard.press('ArrowUp')
  await settle()
  const backActive = await activeOption()
  check(backActive === firstActive, `${label}: ArrowUp moves the active option back up`, { firstActive, secondActive, backActive })
  await page.keyboard.press('ArrowDown')
  await settle()
  const beforeTheme = await page.evaluate(() => window.__settings.getSettings().theme)
  await page.keyboard.press('Enter')
  await settle()
  check(await menuOpen() === 0, `${label}: Enter commits and closes`)
  const afterTheme = await page.evaluate(() => window.__settings.getSettings().theme)
  check(beforeTheme !== afterTheme, `${label}: choosing an option writes the setting`, { beforeTheme, afterTheme })
  check(await triggerFocused(), `${label}: committing returns focus to the trigger`)
  await page.keyboard.press('Escape')
}

/** 调优数字字段：标签只聚焦输入框，无效值可见且保留草稿，修正后清除错误态 */
const checkTuningErrorState = async (label) => {
  await openSection('advanced')
  const tuning = page.locator('.settings-page input[type=number]').first()
  await tuning.scrollIntoViewIfNeeded()
  const tuningLabelBox = await page.locator('.settings-page .field:has(> input[type=number]) > span').first().boundingBox()
  await page.mouse.click(Math.round(tuningLabelBox.x + tuningLabelBox.width / 2), Math.round(tuningLabelBox.y + tuningLabelBox.height / 2))
  await settle()
  check(await page.evaluate(() => document.activeElement?.type === 'number'), `${label}: clicking a tuning label focuses its numeric input`)
  check(await tuning.inputValue() !== '0', `${label}: clicking a tuning label does not corrupt the value`)
  await tuning.fill('0')
  await tuning.blur()
  await settle()
  check(await tuning.getAttribute('aria-invalid') === 'true', `${label}: an invalid tuning value reports aria-invalid`)
  await page.mouse.move(4, 4) // 指针挪开：hover 不得盖住错误态配色
  await settle()
  const errorStyle = await tuning.evaluate((input) => {
    const probe = document.createElement('i')
    probe.style.color = 'var(--status-failed)'
    document.body.append(probe)
    const expected = getComputedStyle(probe).color
    probe.remove()
    const message = document.getElementById(input.getAttribute('aria-describedby') ?? '')
    return { expected, border: getComputedStyle(input).borderTopColor, text: message ? getComputedStyle(message).color : null }
  })
  check(errorStyle.border === errorStyle.expected, `${label}: the invalid field keeps the semantic error border`, errorStyle)
  check(errorStyle.text === errorStyle.expected, `${label}: the inline error uses the semantic error colour`, errorStyle)
  await tuning.fill('12')
  await tuning.blur()
  await settle()
  check(await tuning.getAttribute('aria-invalid') === null, `${label}: a corrected value clears the error state`)
}

/** 禁用态：既有语义（点不动）也有可读样式（变暗 + not-allowed） */
const checkDisabledVisualState = async (label) => {
  await openSection('runtime')
  const disabledStyle = await page.evaluate(() => {
    const button = [...document.querySelectorAll('.settings-page .btn')].find((node) => node.disabled)
    if (!button) return null
    const style = getComputedStyle(button)
    return { text: button.textContent.trim(), cursor: style.cursor, opacity: Number(style.opacity) }
  })
  check(disabledStyle !== null && disabledStyle.cursor === 'not-allowed', `${label}: disabled buttons expose the not-allowed cursor`, disabledStyle)
  check(disabledStyle !== null && disabledStyle.opacity < 1, `${label}: disabled buttons are visually dimmed`, disabledStyle)
}

try {
  await page.goto(`http://127.0.0.1:${port}`)
  await page.locator('.settings-page').waitFor()
  await page.waitForTimeout(200)

  let geometryCases = 0
  for (const width of [1440, 980]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 560 })
    for (const theme of ['dark', 'light']) {
      await page.evaluate(async (value) => { await window.__settings.probe.resetAll(); await window.agentdeck.settings.set({ theme: value }) }, theme)
      await settle()
      for (const section of SECTIONS) {
        const count = await checkSectionGeometry(width, theme, section)
        geometryCases += 1
        if (width === 1440) await page.screenshot({ path: path.join(screenshots, `${width}-${theme}-${section}.png`) })
      }
    }
    // 4 组真实坐标行为验收：两套主题 × 两个视口
    for (const theme of ['dark', 'light']) {
      const label = `${width}/${theme}`
      await page.evaluate(async (value) => { await window.__settings.probe.resetAll(); await window.agentdeck.settings.set({ theme: value }) }, theme)
      await openSection('general')
      await group(`${label}/theme`, () => checkDropdownBounds(`${label}/theme`, '.settings-page .menu-trigger >> nth=0', '.settings-page .field:has(.menu-trigger) >> nth=0 >> span >> nth=0'))
      await group(`${label}/mode`, () => checkDropdownBounds(`${label}/mode`, '.settings-page .menu-trigger >> nth=1', '.settings-page .field:has(.menu-trigger) >> nth=1 >> span >> nth=0'))
      await group(`${label}/slider`, checkSliderLabelSafety)
      await group(`${label}/toggle`, checkToggleLabelSafety)
      await group(`${label}/disabled`, checkDisabledControls)
      await group(`${label}/write-queue`, checkWriteQueuePreserved)
      await group(`${label}/updates`, checkUpdateOrdering)
      await group(`${label}/keyboard`, () => checkKeyboardOperation(label))
      await group(`${label}/tuning`, () => checkTuningErrorState(label))
      await group(`${label}/disabled-style`, () => checkDisabledVisualState(label))
    }
  }

  await page.screenshot({ path: path.join(screenshots, '1440-dark-section-geometry.png') })
  assert.deepEqual(errors, [], `renderer has no exceptions: ${JSON.stringify(errors)}`)
  console.log(JSON.stringify({ screenshots, sections: SECTIONS, geometryCases, checks: checks.length, failedChecks: checks.filter((item) => !item.ok), errors }, null, 2))
  if (checks.some((item) => !item.ok)) process.exitCode = 1
} finally {
  await browser.close()
  await new Promise((resolve) => server.close(resolve))
}
