// 动态思考强度前端两道 2s 确认状态机冒烟（无 Electron / 无 DOM）：
// 覆盖不变量 DT-2（阶段 1 严格零偷跑）、hover 暂停续计时、取消保留草稿、并发互斥与交互中心复位。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-ui-triage-'))
const outfile = path.join(tmpDir, 'triage-ui.cjs')

const entry = [
  path.join(root, 'src/renderer/src/ui/triage-flow.ts'),
  path.join(root, 'src/renderer/src/ui/interaction-center.ts'),
  path.join(root, 'src/renderer/src/ui/interaction-layer.ts')
].map((file) => `export * from ${JSON.stringify(file)}`).join('\n')

await build({
  stdin: { contents: entry, resolveDir: root, loader: 'js' },
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18'
})

const {
  shouldPromptTriage,
  createTriageFlow,
  createInteractionCenter,
  createLayerStack,
  TRIAGE_CONFIRM_MS
} = await import(pathToFileURL(outfile).href)

let failures = 0
const ok = (cond, label) => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}`)
  if (!cond) { failures++; process.exitCode = 1 }
}
const section = (title) => console.log(`\n── ${title}`)

function fakeClock(startMs = 1000) {
  let current = startMs
  const armed = []
  const cleared = []
  return {
    now: () => current,
    advance(ms) { current += ms },
    timers: {
      set(fn, ms) {
        const handle = { fn, ms, cleared: false }
        armed.push(handle)
        return handle
      },
      clear(handle) {
        if (handle) handle.cleared = true
        cleared.push(handle)
      }
    },
    armed,
    cleared,
    fireLatest() {
      const h = [...armed].reverse().find((item) => !item.cleared)
      if (!h) throw new Error('No active timer to fire')
      h.cleared = true
      h.fn()
    }
  }
}

try {
  section('1. shouldPromptTriage 触发矩阵')
  {
    ok(shouldPromptTriage({ agent: { backend: 'zcode', thinking: 'auto' }, kind: 'task' }), 'task + zcode + auto → 弹窗')
    ok(shouldPromptTriage({ agent: { backend: 'claude', thinking: 'auto' }, kind: 'task' }), 'task + claude + auto → 弹窗')
    ok(shouldPromptTriage({ agent: { backend: 'codex', thinking: 'auto' }, kind: 'task' }), 'task + codex + auto → 弹窗')
    ok(shouldPromptTriage({ agent: { backend: 'agy', thinking: 'auto' }, kind: 'task' }), 'task + agy + auto → 弹窗')
    ok(shouldPromptTriage({ agent: { backend: 'dsh', thinking: 'auto' }, kind: 'task' }), 'task + dsh + auto → 启动前弹窗')
    ok(!shouldPromptTriage({ agent: { backend: 'opencode', thinking: 'auto' }, kind: 'task' }), 'task + opencode + auto → 不弹窗')
    ok(!shouldPromptTriage({ agent: { backend: 'zcode', thinking: 'high' }, kind: 'task' }), 'task + 固定 high → 不弹窗')
    ok(!shouldPromptTriage({ agent: { backend: 'zcode' }, kind: 'task' }), 'task + 默认未设 → 不弹窗')

    ok(shouldPromptTriage({ agent: { backend: 'zcode', thinking: 'auto' }, kind: 'followup' }), 'followup + zcode + auto → 弹窗')
    ok(shouldPromptTriage({ agent: { backend: 'claude', thinking: 'auto' }, kind: 'followup' }), 'followup + claude + auto → 弹窗')
    ok(shouldPromptTriage({ agent: { backend: 'codex', thinking: 'auto' }, kind: 'followup' }), 'followup + codex + auto → 弹窗')
    ok(shouldPromptTriage({ agent: { backend: 'agy', thinking: 'auto' }, kind: 'followup' }), 'followup + agy + auto → 弹窗')
    ok(!shouldPromptTriage({ agent: { backend: 'dsh', thinking: 'auto' }, kind: 'followup' }), 'followup + dsh（startup-only）→ 不弹窗')
    ok(!shouldPromptTriage({ agent: { backend: 'opencode', thinking: 'auto' }, kind: 'followup' }), 'followup + opencode → 不弹窗')
  }

  section('2. DT-2 铁律：阶段 1 严禁偷跑，点跳过零 assess 调用')
  {
    const clock = fakeClock()
    const flow = createTriageFlow({ timers: clock.timers, now: clock.now })
    let assessCalls = 0
    const p = flow.start({
      kind: 'task',
      prompt: '改一行文案',
      agentName: 'ZetCode',
      assess: async () => { assessCalls++; return { ok: true, decision: { level: 'low', reason: 'simple', source: 'triage', via: 'preset-http', durationMs: 10 } } }
    })
    ok(flow.getState().stage === 'confirm-triage', '进入阶段 1（confirm-triage）')
    ok(assessCalls === 0, '阶段 1 等待期内 assessCalls === 0（严格零偷跑）')
    ok(clock.armed[0].ms === TRIAGE_CONFIRM_MS, '阶段 1 倒计时 2000ms')
    flow.skip()
    const outcome = await p
    ok(outcome.action === 'proceed' && outcome.skipTriage === true && !outcome.thinking, '点跳过以 skipTriage:true 放行')
    ok(assessCalls === 0, '跳过后全程 0 次 assess 调用')
    ok(flow.getState().stage === 'idle', '结束后回到 idle')
  }

  section('3. 阶段 1 直接选档：跳过评估与阶段 2')
  {
    const clock = fakeClock()
    const flow = createTriageFlow({ timers: clock.timers, now: clock.now })
    let assessCalls = 0
    const p = flow.start({
      kind: 'task',
      prompt: '直接用高思考',
      assess: async () => { assessCalls++; return { ok: true, decision: { level: 'low', reason: 'x', source: 'triage', via: 'preset-http', durationMs: 1 } } }
    })
    flow.pickLevel('high')
    const outcome = await p
    ok(outcome.action === 'proceed' && outcome.thinking === 'high' && outcome.thinkingSource === 'user' && assessCalls === 0, '阶段 1 选档跳过 assess 与阶段 2 直接发车')
  }

  section('4. 阶段 1 到期 → 评估 → 阶段 2（hover 暂停与续计时）→ 自动发车')
  {
    const clock = fakeClock(5000)
    const flow = createTriageFlow({ timers: clock.timers, now: clock.now })
    let receivedInput = null
    let resolveAssess = null
    const p = flow.start({
      kind: 'followup',
      prompt: '深挖竞态原因',
      currentThinking: 'medium',
      assess: (input) => {
        receivedInput = input
        return new Promise((r) => { resolveAssess = r })
      }
    })
    // 阶段 1 到期
    clock.advance(2000)
    clock.fireLatest()
    ok(flow.getState().stage === 'assessing', '阶段 1 到期转入 assessing')
    ok(receivedInput?.kind === 'followup' && receivedInput?.currentThinking === 'medium' && !!receivedInput?.requestId, 'assess 携带 requestId/kind/currentThinking')

    // 分诊返回进入阶段 2（confirm-level）
    resolveAssess({ ok: true, decision: { level: 'max', reason: '核心状态机竞态', source: 'triage', via: 'preset-http', durationMs: 420 } })
    await Promise.resolve()
    await Promise.resolve()
    ok(flow.getState().stage === 'confirm-level' && flow.getState().decision?.level === 'max', '分诊返回后进入阶段 2（confirm-level）')

    // 700ms 后 hover 暂停，剩余 1300ms
    clock.advance(700)
    flow.setHovered(true)
    ok(flow.getState().hovered === true && flow.getState().remainingMs === 1300 && flow.getState().deadlineAt === null, 'hover 暂停倒计时并冻结剩余 1300ms')

    // 停留 5 秒后移出，按剩余 1300ms 重装定时器
    clock.advance(5000)
    flow.setHovered(false)
    const resumedTimer = clock.armed[clock.armed.length - 1]
    ok(flow.getState().hovered === false && resumedTimer.ms === 1300, '移出 hover 按剩余 1300ms 续计时')

    // 阶段 2 到期自动发车
    clock.advance(1300)
    clock.fireLatest()
    const outcome = await p
    ok(outcome.action === 'proceed' && outcome.thinking === 'max' && outcome.thinkingSource === 'triage' && outcome.thinkingReason === '核心状态机竞态', '阶段 2 到期按分诊结果自动发车')
  }

  section('5. 评估中跳过调用 cancel + 阶段 2 改档 + 取消 + Fail-open 降级')
  {
    const clock = fakeClock()
    const flow = createTriageFlow({ timers: clock.timers, now: clock.now })
    const cancelledIds = []
    let lateResolve = null
    const p1 = flow.start({
      kind: 'task',
      prompt: '慢分诊',
      assess: () => new Promise((r) => { lateResolve = r }),
      cancel: (id) => { cancelledIds.push(id) }
    })
    flow.confirmNow()
    const reqId = flow.getState().requestId
    ok(flow.getState().stage === 'assessing' && !!reqId, '点立即评估直入 assessing')
    flow.skip()
    const o1 = await p1
    lateResolve({ ok: true, decision: { level: 'max', reason: 'late', source: 'triage', via: 'preset-http', durationMs: 99 } })
    await Promise.resolve()
    ok(o1.action === 'proceed' && o1.skipTriage === true && cancelledIds[0] === reqId && flow.getState().stage === 'idle', '评估中跳过触发 cancel(requestId) 且丢弃迟到响应')

    // 阶段 2 改档
    const p2 = flow.start({
      kind: 'task',
      prompt: '改档测试',
      assess: async () => ({ ok: true, decision: { level: 'low', reason: '太简单', source: 'triage', via: 'preset-http', durationMs: 10 } })
    })
    flow.confirmNow()
    await Promise.resolve(); await Promise.resolve()
    flow.pickLevel('high')
    const o2 = await p2
    ok(o2.action === 'proceed' && o2.thinking === 'high' && o2.thinkingSource === 'user', '阶段 2 点击档位覆盖分诊建议')

    // 阶段 2 取消（保留草稿）
    const p3 = flow.start({
      kind: 'task',
      prompt: '取消测试',
      assess: async () => ({ ok: true, decision: { level: 'high', reason: '复杂', source: 'triage', via: 'preset-http', durationMs: 10 } })
    })
    flow.confirmNow()
    await Promise.resolve(); await Promise.resolve()
    flow.cancel()
    const o3 = await p3
    ok(o3.action === 'cancelled' && flow.getState().stage === 'idle', '阶段 2 取消返回 cancelled')

    // Fail-open 降级
    const toasts = []
    const p4 = flow.start({
      kind: 'task',
      prompt: '超时测试',
      assess: async () => ({ ok: false, error: '分诊超时', fallback: 'medium' }),
      onFallbackToast: (msg) => toasts.push(msg)
    })
    flow.confirmNow()
    const o4 = await p4
    ok(o4.action === 'proceed' && o4.thinking === 'medium' && o4.thinkingSource === 'fallback' && toasts.length === 1, 'assess 失败 Fail-open 降级 medium 并推提示')
  }

  section('6. InteractionCenter 集成：并发互斥与 reset 清理')
  {
    const clock = fakeClock()
    const center = createInteractionCenter({ layers: createLayerStack(), timers: clock.timers, now: clock.now })
    const p1 = center.triage.start({
      kind: 'task',
      prompt: '第一条',
      assess: async () => ({ ok: true, decision: { level: 'high', reason: 'ok', source: 'triage', via: 'preset-http', durationMs: 5 } })
    })
    const p2 = center.triage.start({
      kind: 'task',
      prompt: '第二条冲突',
      assess: async () => ({ ok: true, decision: { level: 'low', reason: 'no', source: 'triage', via: 'preset-http', durationMs: 5 } })
    })
    const o2 = await p2
    ok(o2.action === 'cancelled' && center.getState().toasts.some((t) => t.text.includes('请先完成当前思考强度确认')), '并发二次触发拒绝并 toast 提示，不打断首条')
    ok(center.getState().triage.stage === 'confirm-triage', '首条确认条保持活跃')
    center.reset()
    const o1 = await p1
    ok(o1.action === 'cancelled' && center.getState().triage.stage === 'idle', 'interaction-center.reset 清理未决确认条与定时器')
  }

  console.log(failures === 0 ? '\n✅ UI TRIAGE SMOKE PASSED' : `\n❌ UI TRIAGE SMOKE FAILED (${failures})`)
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true })
}
process.exit(failures === 0 ? 0 : 1)
