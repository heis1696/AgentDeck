// 桌宠行为状态机冒烟：esbuild 直连 src/shared/pet.ts（纯函数即公共 API）。
// 覆盖：真实 pet.json 校验 + 帧文件在库、事件转移表、加权分布 ±3%、
// 重力/落底/边界折返/抛掷滑行、非 loop 帧钳制、afterSec 自主转移。
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const root = path.resolve(import.meta.dirname, '..')
const outfile = path.join(root, 'out', 'smoke-pet-behavior.cjs')
await build({
  entryPoints: [path.join(root, 'src/shared/pet.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18'
})
const pet = await import(pathToFileURL(outfile).href)

let failed = 0
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗'} ${msg}`); if (!cond) failed++ }

// —— 真实 pet.json 驱动 + 帧文件在库 ——
const assetsDir = path.join(root, 'src/renderer/src/pet/assets/default')
const raw = JSON.parse(fs.readFileSync(path.join(assetsDir, 'pet.json'), 'utf8'))
const m = pet.validatePetManifest(raw)
ok(m !== null, '内置 pet.json 通过 validatePetManifest')
ok(Object.keys(m.states).length === 8, `七态 + eat 扩展态齐备（got ${Object.keys(m.states).length}）`)
const totalFrames = Object.values(m.states).reduce((sum, def) => sum + def.frames.length, 0)
ok(totalFrames === 19, `总帧数 19（16 + eat 3；got ${totalFrames}）`)
const missing = []
for (const def of Object.values(m.states)) {
  for (const frame of def.frames) if (!fs.existsSync(path.join(assetsDir, frame))) missing.push(frame)
}
ok(missing.length === 0, `帧文件全部在库${missing.length ? `：缺 ${missing.join(', ')}` : ''}`)
ok(m.movement.edgeBehavior === 'turn' && m.movement.gravity > 0 && m.movement.walkSpeedPx > 0, 'movement 契约（turn/gravity/walkSpeedPx）')
// 坏 manifest 拒收
ok(pet.validatePetManifest({ ...raw, states: {} }) === null, '缺状态列的 manifest 被拒')
ok(pet.validatePetManifest({ ...raw, movement: { ...raw.movement, edgeBehavior: 'bounce' } }) === null, 'edgeBehavior 非 turn 被拒')
// 七态契约向后兼容：老素材包没有 eat 态仍应通过校验
const legacy = JSON.parse(JSON.stringify(raw))
delete legacy.states.eat
const legacyManifest = pet.validatePetManifest(legacy)
ok(legacyManifest !== null && legacyManifest.states.eat === undefined, '无 eat 的老 pet.json 仍通过（七态契约向后兼容）')
// 白名单外自定义态拒收
ok(pet.validatePetManifest({ ...raw, states: { ...raw.states, dance: { frames: ['idle-0.png'], fps: 4, loop: true, next: [] } } }) === null, '白名单外自定义态被拒')
// eat 态：非 loop 播完回 idle；缺 eat 的包转 eat 视为未知（advancePet 兜 idle 段不崩）
ok(m.states.eat && m.states.eat.loop === false && m.states.eat.next.every((t) => t.to === 'idle'), 'eat 态契约：非 loop、出口 idle')
{
  const eatBrain = pet.createPetBrain('eat')
  let cur = { brain: eatBrain, physics: pet.createPetPhysics(400, 600) }
  for (let i = 0; i < 100; i++) {
    cur = pet.advancePet(cur.brain, cur.physics, m, 0.05, { minX: 0, maxX: 800, floorY: 600 }, () => 0)
    if (cur.brain.state === 'idle') break
  }
  ok(cur.brain.state === 'idle', 'eat 播完回到 idle')
}
// —— 缩放契约：petWindowSize / petSpriteScale / petSpriteRect 同步 ——
ok(pet.petWindowSize(1).width === 220 && pet.petWindowSize(2).height === 440, 'petWindowSize 随档位等比')
ok(pet.petSpriteScale(1.5) === 3, 'petSpriteScale = 基准 2 × 档位')
ok(pet.normalizePetZoom(1.5) === 1.5 && pet.normalizePetZoom(3) === 1 && pet.normalizePetZoom('x') === 1, 'normalizePetZoom 白名单外回退 1')
const sprite150 = pet.petSpriteRect(330, 330, pet.petSpriteScale(1.5))
ok(sprite150.width === 192 && sprite150.left === Math.round((330 - 192) / 2) && sprite150.top === 330 - 10 - 192, '150% 档精灵命中区居中贴底')
const sprite100 = pet.petSpriteRect()
ok(sprite100.width === 128 && sprite100.height === 128 && sprite100.top === 220 - 10 - 128, '默认档 petSpriteRect 与旧值一致（向后兼容）')

// —— 事件转移表 ——
const brain = (state) => pet.createPetBrain(state)
const rand = () => 0
ok(pet.stepBrain(brain('idle'), m, 'click', rand).state === 'happy', 'click → happy')
ok(pet.stepBrain(brain('sleep'), m, 'click', rand).state === 'idle', 'sleep 中 click → wake 到 idle')
ok(pet.stepBrain(brain('walk'), m, 'doubleClick', rand).state === 'think', 'doubleClick → think')
ok(pet.stepBrain(brain('walk'), m, 'dragStart', rand).state === 'dragged', 'dragStart → dragged')
ok(pet.stepBrain(brain('dragged'), m, 'throw', rand).state === 'fall', 'throw → fall')
ok(pet.stepBrain(brain('idle'), m, 'throw', rand).state === 'idle', '非 dragged 的 throw 忽略')
ok(pet.stepBrain(brain('fall'), m, 'click', rand).state === 'fall', 'fall 只认 land（click 忽略）')
ok(pet.stepBrain(brain('fall'), m, 'tick', rand).state === 'fall', 'fall 只认 land（tick 忽略）')
ok(pet.stepBrain(brain('idle'), m, 'land', rand).state === 'idle', '非 fall 的 land 忽略')
const landed = pet.stepBrain(brain('fall'), m, 'land', rand)
ok(landed.state === 'walk' || landed.state === 'idle', `land → fall.next 加权出口（got ${landed.state}）`)
ok(pet.stepBrain(brain('sleep'), m, 'wake', rand).state === 'idle', 'wake → idle')

// —— weightedPick 分布 ±3% ——
const items = [{ to: 'a', weight: 70 }, { to: 'b', weight: 20 }, { to: 'c', weight: 10 }]
const counts = { a: 0, b: 0, c: 0 }
for (let i = 0; i < 10000; i++) counts[pet.weightedPick(items).to]++
ok(Math.abs(counts.a / 10000 - 0.7) <= 0.03, `权重 70 落在 70%±3%（got ${(counts.a / 100).toFixed(1)}%）`)
ok(Math.abs(counts.b / 10000 - 0.2) <= 0.03, `权重 20 落在 20%±3%（got ${(counts.b / 100).toFixed(1)}%）`)
ok(Math.abs(counts.c / 10000 - 0.1) <= 0.03, `权重 10 落在 10%±3%（got ${(counts.c / 100).toFixed(1)}%）`)
ok(pet.weightedPick([{ to: 'x', weight: 0 }], rand).to === 'x', '零权重回退最后一项')

// —— 重力 / 落底 ——
const bounds = { minX: 0, maxX: 800, floorY: 600 }
let ph = pet.createPetPhysics(100, 0)
let br = pet.stepBrain(brain('dragged'), m, 'throw', rand)
const r1 = pet.advancePet(br, ph, m, 0.016, bounds, rand)
const r2 = pet.advancePet(r1.brain, r1.physics, m, 0.016, bounds, rand)
ok(r2.physics.vy > r1.physics.vy && r1.physics.vy > 0, `重力加速度生效（vy ${r1.physics.vy.toFixed(1)} → ${r2.physics.vy.toFixed(1)}）`)
let landedAt = null
for (let i = 0; i < 400; i++) {
  const r = pet.advancePet(br, ph, m, 0.016, bounds, rand)
  br = r.brain
  ph = r.physics
  if (br.state !== 'fall') { landedAt = ph; break }
}
ok(br.state === 'walk' || br.state === 'idle', '落底后转 walk/idle')
ok(landedAt && landedAt.y === bounds.floorY, `落底 y 钳到 floorY（got ${landedAt && landedAt.y}）`)
ok(landedAt && landedAt.vy === 0 && landedAt.vx === 0, '落地速度清零')

// —— 抛掷水平滑行（fall 中 vx 推进 x）——
ph = { ...pet.createPetPhysics(100, 0), vx: 300, vy: 200 }
br = brain('fall')
const glide = pet.advancePet(br, ph, m, 0.05, bounds, rand)
ok(glide.physics.x > 100 && glide.physics.y > 0, `抛掷滑行（x ${ph.x}→${glide.physics.x.toFixed(1)}, y ${ph.y}→${glide.physics.y.toFixed(1)}）`)

// —— fall 侧壁折返 ——
ph = { ...pet.createPetPhysics(799.5, 100), vx: 50, vy: 0 }
br = brain('fall')
const wall = pet.advancePet(br, ph, m, 0.05, bounds, rand)
ok(wall.physics.x === bounds.maxX && wall.physics.vx < 0, `右壁折返（x 钳 ${wall.physics.x}，vx 翻负 ${wall.physics.vx.toFixed(1)}）`)

// —— walk 边界折返 + moved 标记 ——
ph = { ...pet.createPetPhysics(bounds.maxX - 1, bounds.floorY), facing: 1 }
br = brain('walk')
const edge = pet.advancePet(br, ph, m, 0.1, bounds, rand)
ok(edge.physics.x === bounds.maxX && edge.physics.facing === -1, 'walk 右缘折返（facing 翻转）')
ok(edge.moved, 'walk 帧上报 moved')
const still = pet.advancePet(brain('idle'), pet.createPetPhysics(400, bounds.floorY), m, 0.1, bounds, rand)
ok(!still.moved, 'idle 不上报 moved')

// —— 非 loop 帧钳制 + 播完一次性转移 ——
ph = pet.createPetPhysics(400, bounds.floorY)
br = brain('happy') // fps 6，2 帧非 loop，next → idle
const half = pet.advancePet(br, ph, m, 0.05, bounds, rand)
ok(half.brain.state === 'happy' && half.brain.frame === 0, '非 loop 未播完不转移')
let done = { brain: br, physics: ph }
for (let i = 0; i < 200; i++) {
  done = pet.advancePet(done.brain, done.physics, m, 0.05, bounds, rand)
  if (done.brain.state !== 'happy') break
}
ok(done.brain.state === 'idle' && done.brain.frame === 0, '非 loop 播完加权转移到 idle（帧复位）')

// —— afterSec 到期自主转移（idle afterSec=6）——
ph = pet.createPetPhysics(400, bounds.floorY)
br = brain('idle')
let matured = { brain: br, physics: ph }
for (let i = 0; i < 61; i++) matured = pet.advancePet(matured.brain, matured.physics, m, 0.1, bounds, rand)
ok(matured.brain.state !== 'idle', `afterSec 到期自主转移（got ${matured.brain.state}）`)
const young = pet.advancePet(brain('idle'), ph, m, 1, bounds, rand)
ok(young.brain.state === 'idle', 'afterSec 未到不转移')

if (failed) { console.error(`\n❌ PET BEHAVIOR SMOKE FAILED (${failed})`); process.exit(1) }
console.log('\n✅ PET BEHAVIOR SMOKE PASSED')
