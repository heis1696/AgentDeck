// 桌宠窗体事件与生成入参解析冒烟：esbuild 直连 src/main/ipc/pet.ts（electron external——
// 只测纯解析函数 parsePetWindowEvent / parsePetGenStartInput，不触 IPC 注册）。
// 覆盖：新增 hover/menu 事件、drag-start 新旧渲染层互发容错、非法形状丢弃、gen 入参白名单校验。
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const outfile = path.join(root, 'out', 'smoke-pet-events.cjs')
await build({ entryPoints: [path.join(root, 'src/main/ipc/pet.ts')], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node18', external: ['electron'] })
const mod = await import(pathToFileURL(outfile).href)
const { parsePetWindowEvent, parsePetGenStartInput } = mod

let failed = 0
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗'} ${msg}`); if (!cond) failed++ }

console.log('—— parsePetWindowEvent：新增 hover / menu 事件（A1 穿透重构契约）——')
ok(JSON.stringify(parsePetWindowEvent({ type: 'hover', inside: true })) === JSON.stringify({ type: 'hover', inside: true }), 'hover inside:true 解析')
ok(JSON.stringify(parsePetWindowEvent({ type: 'hover', inside: false })) === JSON.stringify({ type: 'hover', inside: false }), 'hover inside:false 解析')
ok(parsePetWindowEvent({ type: 'hover', inside: 'yes' }) === null, 'hover inside 非布尔丢弃')
ok(parsePetWindowEvent({ type: 'hover' }) === null, 'hover 缺 inside 丢弃')
ok(JSON.stringify(parsePetWindowEvent({ type: 'menu', open: true })) === JSON.stringify({ type: 'menu', open: true }), 'menu open:true 解析')
ok(parsePetWindowEvent({ type: 'menu', open: 1 }) === null, 'menu open 非布尔丢弃')

console.log('—— parsePetWindowEvent：既有事件回归 ——')
ok(JSON.stringify(parsePetWindowEvent({ type: 'drag-start', offsetX: 10, offsetY: 20 })) === JSON.stringify({ type: 'drag-start', offsetX: 10, offsetY: 20 }), 'drag-start 全字段解析')
// 热更错峰：新渲染层（增量拖拽后不再携带 offset）对旧主进程、旧渲染层对新主进程都不炸
ok(JSON.stringify(parsePetWindowEvent({ type: 'drag-start' })) === JSON.stringify({ type: 'drag-start', offsetX: 0, offsetY: 0 }), 'drag-start 缺 offset 容错补 0')
ok(parsePetWindowEvent({ type: 'drag-start', offsetX: 'x' }) !== null, 'drag-start offset 类型错也放行（主进程不消费该值）')
ok(JSON.stringify(parsePetWindowEvent({ type: 'move', x: 1.2, y: -3 })) === JSON.stringify({ type: 'move', x: 1.2, y: -3 }), 'move 浮点坐标解析')
ok(parsePetWindowEvent({ type: 'move', x: NaN }) === null, 'move 非法坐标丢弃')
ok(parsePetWindowEvent({ type: 'chat', open: false }) !== null, 'chat 事件解析')
ok(parsePetWindowEvent({ type: 'interact', kind: 'click' }) !== null, 'interact click 解析')
ok(parsePetWindowEvent({ type: 'interact', kind: 'poke' }) === null, 'interact 未知 kind 丢弃')
ok(parsePetWindowEvent({ type: 'open-settings' }) !== null, 'open-settings 解析')
ok(parsePetWindowEvent({ type: 'frobnicate' }) === null, '未知 type 丢弃')
ok(parsePetWindowEvent(null) === null && parsePetWindowEvent('x') === null, '非对象丢弃')

console.log('—— parsePetGenStartInput：生成入参白名单校验（C7）——')
const valid = {
  packId: 'my-pet',
  presetId: 'p1',
  model: 'gpt-image-1',
  params: { size: '1024x1024', quality: 'high', n: 1, background: 'transparent' },
  stylePrompt: 'cute mascot',
  states: { idle: 1, eat: 2 },
  mode: 'per-frame'
}
{
  const r = parsePetGenStartInput(valid)
  ok(r.ok === true, '合法入参放行')
  if (r.ok) {
    ok(r.input.packId === 'my-pet' && r.input.params.size === '1024x1024', '字段透传')
    ok(r.input.params.background === 'transparent' && r.input.params.n === 1, 'params 归一化')
  }
  const bad = (mutate, needle) => {
    const cfg = JSON.parse(JSON.stringify(valid))
    mutate(cfg)
    const r2 = parsePetGenStartInput(cfg)
    return r2.ok === false && r2.error.includes(needle)
  }
  ok(bad((c) => { c.packId = 'default' }, '保留名'), "packId=default 拒收")
  ok(bad((c) => { c.packId = 'bad id!' }, '非法'), 'packId 非法字符拒收')
  ok(bad((c) => { c.presetId = '' }, '预设'), '空 presetId 拒收')
  ok(bad((c) => { c.stylePrompt = '  ' }, '风格提示词'), '空 stylePrompt 拒收')
  ok(bad((c) => { c.states = { dance: 3 } }, '白名单'), '帧数表白名单外状态拒收')
  ok(bad((c) => { c.states = { idle: 0 } }, '帧数'), '帧数 0 拒收')
  ok(bad((c) => { c.states = {} }, '至少'), '空帧数表拒收')
  ok(bad((c) => { c.states = { idle: 99 } }, '1–32'), '帧数越界拒收')
  ok(bad((c) => { c.mode = 'sheet'; c.sheet = { cols: 1, rows: 2 } }, '放不下'), 'sheet 网格小于帧数拒收')
  const sheet = JSON.parse(JSON.stringify(valid))
  sheet.mode = 'sheet'
  sheet.states = { idle: 1, walk: 1, fall: 1, dragged: 1, sleep: 1, happy: 1, think: 1 }
  sheet.sheet = { cols: 4, rows: 2 }
  const rs = parsePetGenStartInput(sheet)
  ok(rs.ok === true && rs.input.sheet.cols === 4, 'sheet 模式网格合法放行')
  const defaults = parsePetGenStartInput({ ...JSON.parse(JSON.stringify(valid)), params: {} })
  ok(defaults.ok === true && defaults.input.params.size === '1024x1024' && defaults.input.params.background === 'transparent', 'params 缺省走默认值')
  ok(parsePetGenStartInput(null).ok === false, 'null 入参拒收')
}

if (failed) { console.error(`\n❌ PET EVENTS SMOKE FAILED (${failed})`); process.exit(1) }
console.log('\n✅ PET EVENTS SMOKE PASSED')
