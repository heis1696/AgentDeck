import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const outfile = path.join(root, 'out', 'smoke-ipc-validation.cjs')
await build({ entryPoints: [path.join(root, 'src/main/ipc-validation.ts')], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node18' })
const validation = await import(pathToFileURL(outfile).href)
const expectReject = (fn, label) => {
  try { fn() } catch { return }
  throw new Error(`${label} was accepted`)
}

const task = validation.parseTaskCreate({ title: 'x', prompt: 'p', workdir: '' })
if (task.title !== 'x' || task.prompt !== 'p') throw new Error('valid task was rejected')
const replayable = validation.parseTaskCreate({ title: 'x', prompt: 'p', workdir: '', requestId: ' req-1 ', idempotencyKey: 'idem-1' })
if (replayable.requestId !== 'req-1' || replayable.idempotencyKey !== 'idem-1') throw new Error('request idempotency keys were not normalized')
expectReject(() => validation.parseTaskCreate({ title: '', prompt: 'p', workdir: '' }), 'empty title')
expectReject(() => validation.parseTaskCreate({ title: 'x', prompt: 'p', workdir: '', unknown: true }), 'unknown task field')
expectReject(() => validation.parseTaskCreate({ title: 'x', prompt: 'p', workdir: '', requestId: 1 }), 'non-string request id')
expectReject(() => validation.parseIssuePatch({ status: 'running' }), 'invalid issue status')
expectReject(() => validation.parseSettingsPatch({ concurrency: 0 }), 'invalid concurrency')
expectReject(() => validation.parseSettingsPatch({ unknown: true }), 'unknown setting')
for (const address of ['https://updates.example.com/agentdeck', 'http://127.0.0.1:8080/feed', '']) {
  const parsed = validation.parseSettingsPatch({ updateFeedUrl: `  ${address}  ` })
  if (parsed.updateFeedUrl !== address) throw new Error('update feed address was not preserved and trimmed')
}
if (validation.parseSettingsPatch({ updateFeedUrl: '' }).updateFeedUrl !== '') throw new Error('empty update feed must restore the default')
for (const value of [null, 42, true, {}, []]) {
  expectReject(() => validation.parseSettingsPatch({ updateFeedUrl: value }), 'non-string update feed')
}
// 调优参数：合法值放行、越界值拒绝（区间与 ipc-validation 的 settingsIntRanges 对齐）
const tuning = validation.parseSettingsPatch({
  turnIdleTimeoutMs: 300_000, permissionTimeoutMs: 60_000, maxRetryAttempts: 0, retryBackoffMs: 0,
  maxHandoffChain: 4, delegateMaxRounds: 2, delegateMaxTotalRounds: 3, delegateMaxDepth: 1,
  doomLoopThreshold: 5, worktreeMaxAgeDays: 7
})
if (tuning.turnIdleTimeoutMs !== 300_000 || tuning.maxRetryAttempts !== 0 || tuning.doomLoopThreshold !== 5) throw new Error('valid tuning settings were rejected')
expectReject(() => validation.parseSettingsPatch({ turnIdleTimeoutMs: 500 }), 'turnIdle below 1s')
expectReject(() => validation.parseSettingsPatch({ turnIdleTimeoutMs: 1.5 }), 'turnIdle non-integer')
expectReject(() => validation.parseSettingsPatch({ permissionTimeoutMs: 1000 }), 'permissionTimeout below 5s')
expectReject(() => validation.parseSettingsPatch({ maxRetryAttempts: 11 }), 'retry attempts above 10')
expectReject(() => validation.parseSettingsPatch({ retryBackoffMs: -1 }), 'negative retry backoff')
expectReject(() => validation.parseSettingsPatch({ maxHandoffChain: 0 }), 'handoff chain below 1')
expectReject(() => validation.parseSettingsPatch({ delegateMaxRounds: 51 }), 'delegate rounds above 50')
expectReject(() => validation.parseSettingsPatch({ delegateMaxTotalRounds: 201 }), 'delegate total rounds above 200')
expectReject(() => validation.parseSettingsPatch({ delegateMaxDepth: 11 }), 'delegate depth above 10')
expectReject(() => validation.parseSettingsPatch({ doomLoopThreshold: 1 }), 'doom threshold below 2')
expectReject(() => validation.parseSettingsPatch({ worktreeMaxAgeDays: 366 }), 'worktree age above 365')
expectReject(() => validation.parseContent(''), 'empty content')
const automation = validation.parseAutomationCreate({ name: 'daily', prompt: 'check', workdir: '', scheduleMinutes: 15, output: 'issue', enabled: true })
if (automation.scheduleMinutes !== 15 || automation.output !== 'issue') throw new Error('valid automation was rejected')
expectReject(() => validation.parseAutomationCreate({ name: 'x', prompt: 'p', workdir: '', scheduleMinutes: 0, output: 'issue' }), 'invalid automation schedule')
expectReject(() => validation.parseAutomationUpdate({ createdAt: 1 }), 'immutable automation field')
const agents = validation.parseAgents([{ id: 'ag_1', name: 'One', backend: 'codex', color: '#fff' }])
if (agents.length !== 1 || agents[0].backend !== 'codex') throw new Error('valid agents were rejected')
expectReject(() => validation.parseAgents([{ id: 'ag_1', name: 'One', backend: 'unknown', color: '#fff' }]), 'invalid agent backend')
expectReject(() => validation.parseAgents([{ id: 'same', name: 'One', backend: 'codex', color: '#fff' }, { id: 'same', name: 'Two', backend: 'claude', color: '#000' }]), 'duplicate agent id')
const presets = validation.parsePresets([{ id: 'pst_1', name: 'Gateway', backend: 'claude', baseURL: 'https://example.invalid', apiKey: 'secret', createdAt: 1 }])
if (presets.length !== 1 || presets[0].backend !== 'claude') throw new Error('valid presets were rejected')
expectReject(() => validation.parsePresets([{ id: 'pst_1', name: 'Gateway', backend: 'claude', baseURL: '', apiKey: 'secret', createdAt: 1 }]), 'empty preset URL')
// API 预设线协议：白名单内放行并原样回传（保存后不得退回 baseURL 推断），undefined 保持缺省，其余拒收
const protocolPresets = validation.parsePresets([
  { id: 'pst_openai', name: 'OpenAI 网关', backend: 'zcode', baseURL: 'https://openrouter.ai/api/v1', apiKey: 'secret', protocol: 'openai', note: 'chat/completions', createdAt: 1 },
  { id: 'pst_anthropic', name: '原生网关', backend: 'claude', baseURL: 'https://api.anthropic.com', apiKey: 'secret', protocol: 'anthropic', createdAt: 2 },
  { id: 'pst_default', name: '缺省推断', backend: 'codex', baseURL: 'https://example.invalid', apiKey: 'secret', createdAt: 3 }
])
if (protocolPresets[0].protocol !== 'openai' || protocolPresets[1].protocol !== 'anthropic') throw new Error('preset protocol was not preserved')
if (protocolPresets[2].protocol !== undefined || 'protocol' in protocolPresets[2]) throw new Error('absent preset protocol must stay undefined')
const automaticProtocol = validation.parsePresets([{ ...protocolPresets[0], protocol: undefined }])[0]
if ('protocol' in automaticProtocol) throw new Error('selecting automatic protocol must clear the explicit override')
if (protocolPresets[0].baseURL !== 'https://openrouter.ai/api/v1' || protocolPresets[0].note !== 'chat/completions' || protocolPresets[0].createdAt !== 1) throw new Error('preset protocol support dropped sibling fields')
const reparsed = validation.parsePresets(protocolPresets)
if (JSON.stringify(reparsed) !== JSON.stringify(protocolPresets)) throw new Error('preset protocol round-trip is not idempotent')
for (const value of ['OpenAI', 'openai-chat', 'messages', '', ' openai ', 1, null, true, {}]) {
  expectReject(() => validation.parsePresets([{ id: 'pst_1', name: 'Gateway', backend: 'zcode', baseURL: 'https://example.invalid', apiKey: 'secret', protocol: value, createdAt: 1 }]), `illegal preset protocol ${JSON.stringify(value)}`)
}
expectReject(() => validation.parseFollowUpOptions({ relay: 'yes' }), 'invalid relay flag')
const followUpOptions = validation.parseFollowUpOptions({ relay: true, collectFinal: true })
if (followUpOptions.relay !== true || followUpOptions.collectFinal !== true) throw new Error('collectFinal follow-up option was rejected')
expectReject(() => validation.parseFollowUpOptions({ collectFinal: 'yes' }), 'invalid collectFinal flag')
expectReject(() => validation.parseFollowUpOptions({ unknown: true }), 'unknown follow-up option')
expectReject(() => validation.parsePermissionDecision('later'), 'invalid permission decision')
expectReject(() => validation.parseAnalyticsRange({ since: 20, until: 10 }), 'reversed analytics range')
expectReject(() => validation.parseNotification({ title: '', body: 'x' }), 'empty notification title')
console.log('✓ valid DTOs accepted and invalid DTOs rejected')
console.log('✅ IPC VALIDATION SMOKE PASSED')
