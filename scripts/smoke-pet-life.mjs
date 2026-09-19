// 桌宠养成纯逻辑冒烟：esbuild 直连 src/shared/pet-life.ts（好感/心情公式、事件→反应映射、
// 记忆摘要拼接、行为权重偏置、时间感知）。零 electron 依赖，纯函数断言。
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const outfile = path.join(root, 'out', 'smoke-pet-life.cjs')
await build({
  entryPoints: [path.join(root, 'src/shared/pet-life.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18'
})
const life = await import(pathToFileURL(outfile).href)

let failed = 0
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗'} ${msg}`); if (!cond) failed++ }

// —— 数值域与等级 ——
ok(life.clampStat(-5) === 0 && life.clampStat(250) === 100 && life.clampStat(41.6) === 42, 'clampStat 钳到 0-100 并取整')
ok(life.addAffection(99, 5) === 100 && life.addAffection(0, -10) === 0, 'addAffection 上/下限钳制')
ok(life.addMood(96, 8) === 100 && life.addMood(4, -8) === 0, 'addMood 上/下限钳制')
ok(life.affectionTier(0) === '陌生' && life.affectionTier(19) === '陌生', '等级：陌生 0-19')
ok(life.affectionTier(20) === '点头之交' && life.affectionTier(39) === '点头之交', '等级：点头之交 20-39')
ok(life.affectionTier(55) === '熟悉' && life.affectionTier(60) === '亲近' && life.affectionTier(80) === '挚友' && life.affectionTier(100) === '挚友', '等级阈值下闭上开')
ok(life.moodLabel(75) === '开心' && life.moodLabel(50) === '平静' && life.moodLabel(10) === '低落', '心情文案三档')

// —— 按日衰减 ——
const now = Date.now()
ok(life.decayAffection(50, now - 3600_000, now) === 50, '不满 1 天不衰减')
ok(life.decayAffection(50, now - 3 * 86_400_000, now) === 44, '3 天衰减 6 点（每日 -2）')
ok(life.decayAffection(1, now - 30 * 86_400_000, now) === 0, '衰减地板 0')
ok(life.decayAffection(50, 0, now) === 50 && life.decayAffection(50, now + 1000, now) === 50, 'lastInteractAt=0 / 未来时间不衰减')

// —— 交互与投喂 ——
ok(life.interactionEffect('click').affection === 1 && life.interactionEffect('click').mood === 2, '单击：好感+1 心情+2')
ok(life.interactionEffect('throw').affection === 0 && life.interactionEffect('throw').mood === -3, '抛掷：好感不动 心情-3')
ok(life.interactionEffect('chat').affection === 2 && life.interactionEffect('chat').mood === 4, '聊天：好感+2 心情+4')
const full = life.feedEffect(0)
ok(full.affection === 4 && full.mood === 8 && !full.full, '投喂前 5 次：好感+4 心情+8')
const overfed = life.feedEffect(5)
ok(overfed.affection === 0 && overfed.mood === 4 && overfed.full, '第 6 次起吃撑：好感停涨、心情减半')
ok(life.PET_FEED_DAILY_FULL === 5, '每日全额投喂上限 5 次')

// —— 看板事件 → 反应映射 ——
ok(life.boardReactionFor(undefined, 'running')?.kind === 'start', 'queued→running 事件 start')
ok(life.boardReactionFor('running', 'done')?.kind === 'done' && life.boardReactionFor('running', 'done').mood === 10 && life.boardReactionFor('running', 'done').affection === 3, 'running→done 事件 done（好感+3 心情+10）')
ok(life.boardReactionFor('running', 'failed')?.kind === 'failed' && life.boardReactionFor('running', 'failed').mood === -6, 'running→failed 事件 failed（心情-6）')
ok(life.boardReactionFor('done', 'done') === null, '重复上报不反应')
ok(life.boardReactionFor('running', 'queued') === null && life.boardReactionFor('running', 'cancelled') === null, '排队/取消不反应')
ok(life.boardReactionFor('failed', 'failed') === null, 'failed 重复不反应')
const doneR = life.boardReactionFor('running', 'done')
ok(doneR.action === 'happy' && doneR.lineGroup === 'event_done', 'done 反应动画 happy / 兜底组 event_done')

// —— 记忆摘要拼接 ——
const prompt = life.buildMemoryPrompt('旧记忆一段', [{ role: 'user', text: '我喜欢薄荷' }, { role: 'pet', text: '记住啦' }])
ok(prompt.includes('旧记忆一段') && prompt.includes('主人：我喜欢薄荷') && prompt.includes('团子：记住啦'), '摘要提示词含已有记忆 + 双方台词')
ok(prompt.includes('300'), `摘要字数约束进提示词（${life.PET_MEMORY_SUMMARY_CAP}）`)
const longOld = '旧'.repeat(900)
const merged = life.mergeMemory(longOld, '新记忆内容')
ok(merged.startsWith('新记忆内容'), '新摘要在前（新记忆优先）')
ok([...merged].length === life.PET_MEMORY_CAP, `总长按码点截到 ${life.PET_MEMORY_CAP}`)
ok(life.mergeMemory(longOld.slice(0, 700), '新记忆内容').length === 706, '未超上限不截断')
ok(life.mergeMemory('已有', '   ') === '已有' && life.mergeMemory('', '新') === '新', '空摘要不覆盖 / 空记忆直接采纳')
ok(life.composeMemorySection('  ') === '', '空记忆不产生注入段')
ok(life.composeMemorySection('主人叫小明').includes('主人叫小明') && life.composeMemorySection('主人叫小明').startsWith('\n\n'), '记忆注入段成形')

// —— 行为权重偏置（不改原 manifest） ——
const manifest = {
  frameSize: [64, 64],
  states: {
    idle: { frames: ['a.png'], fps: 4, loop: true, afterSec: 6, next: [{ to: 'walk', weight: 4 }, { to: 'sleep', weight: 2 }, { to: 'happy', weight: 1 }] },
    walk: { frames: ['a.png'], fps: 6, loop: true, next: [{ to: 'idle', weight: 3 }] },
    sleep: { frames: ['a.png'], fps: 2, loop: true, next: [{ to: 'idle', weight: 1 }] },
    happy: { frames: ['a.png'], fps: 6, loop: false, next: [{ to: 'idle', weight: 1 }] },
    think: { frames: ['a.png'], fps: 3, loop: false, next: [{ to: 'idle', weight: 1 }] },
    fall: { frames: ['a.png'], fps: 8, loop: true, next: [{ to: 'idle', weight: 1 }] },
    dragged: { frames: ['a.png'], fps: 8, loop: true, next: [] }
  },
  movement: { walkSpeedPx: 60, gravity: 1800, edgeBehavior: 'turn' },
  bubble: { offset: [8, -56] }
}
const tuned = life.tuneTransitions(manifest, { affection: 90, mood: 15 })
ok(tuned !== manifest, 'tuneTransitions 返回新对象')
ok(manifest.states.idle.next[1].weight === 2, '原 manifest 不被改动')
ok(tuned.states.idle.next[1].weight === 6, '低心情：sleep 权重 ×3')
ok(tuned.states.idle.next[2].weight === 1 && tuned.states.idle.next[0].weight === 6, '挚友：walk ×1.5；happy 无心情加成')
const tunedHappy = life.tuneTransitions(manifest, { affection: 10, mood: 90 })
ok(tunedHappy.states.idle.next[2].weight === 2, '好心情：happy 权重 ×2')
ok(tunedHappy.states.idle.next[1].weight === 2, '心情好时不加重睡意')
const tunedNeutral = life.tuneTransitions(manifest, { affection: 10, mood: 50 })
ok(JSON.stringify(tunedNeutral.states.idle.next) === JSON.stringify(manifest.states.idle.next), '中性数值权重不变')

// —— 兜底动作偏置 ——
const w = (weights) => weights.map((item) => `${item.action}${item.weight}`).join('/')
ok(w(life.fallbackActionWeights()) === 'idle70/walk20/sleep10', '缺省基线 idle70/walk20/sleep10')
ok(w(life.fallbackActionWeights({})) === 'idle70/walk20/sleep10', '空偏置回基线')
ok(w(life.fallbackActionWeights({ mood: 20 })).includes('sleep40'), '低心情偏置加睡意')
ok(w(life.fallbackActionWeights({ affection: 80 })).includes('happy25'), '高好感偏置加撒娇')

// —— 时间感知 ——
ok(life.todayKey(new Date(2026, 8, 19, 23, 59)) === '2026-09-19', 'todayKey 本地时区 YYYY-MM-DD')
ok(life.firstSeenToday('2026-09-18', new Date(2026, 8, 19, 9, 0)), '昨天打过卡 → 今天是首次')
ok(!life.firstSeenToday('2026-09-19', new Date(2026, 8, 19, 9, 0)), '同日不重复问候')
ok(life.firstSeenToday('', new Date(2026, 8, 19)), '从未打过卡 → 首次')

if (failed) { console.error(`\n❌ PET LIFE SMOKE FAILED (${failed})`); process.exit(1) }
console.log('\n✅ PET LIFE SMOKE PASSED')
