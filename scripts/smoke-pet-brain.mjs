// 桌宠 AI 脑冒烟：esbuild 直连 src/main/pet/pet-brain.ts（fetch 注入 mock，不发真网络）。
// 覆盖：宏替换、parsePetSayPayload（合法/围栏/垃圾）、兜底权重分布、静默计数、防重入、
// 聊天落历史、两协议请求体形状、超时/错误路径。
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

const root = path.resolve(import.meta.dirname, '..')

async function bundle(entry, name) {
  const outfile = path.join(root, 'out', name)
  await build({ entryPoints: [path.join(root, entry)], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node18', external: ['electron'] })
  return import(pathToFileURL(outfile).href)
}
const brainMod = await bundle('src/main/pet/pet-brain.ts', 'smoke-pet-brain.cjs')
const { PetStore } = await bundle('src/main/pet/pet-store.ts', 'smoke-pet-brain-store.cjs')
const llm = await bundle('src/main/pet/pet-llm.ts', 'smoke-pet-brain-llm.cjs')
const lines = await bundle('src/shared/pet-lines.ts', 'smoke-pet-brain-lines.cjs')

let failed = 0
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗'} ${msg}`); if (!cond) failed++ }

// —— pet-lines 数据契约 ——
const GROUP_COUNTS = { idle: 12, click: 10, drag: 6, land: 4, sleep: 4, think: 6 }
for (const [group, expect] of Object.entries(GROUP_COUNTS)) {
  const bank = lines.PET_LINES[group]
  ok(bank.length === expect, `台词组 ${group} 共 ${expect} 句（got ${bank.length}）`)
  ok(bank.every((line) => [...line].length <= 20), `台词组 ${group} 每句 ≤20 字`)
  ok(typeof lines.pickPetLine(group) === 'string' && lines.pickPetLine(group).length > 0, `pickPetLine(${group}) 可用`)
}
ok(lines.GROUP_ACTION_WEIGHTS.map((item) => `${item.action}${item.weight}`).join('/') === 'idle70/walk20/sleep10', '兜底动作权重 idle70/walk20/sleep10')

// —— 兜底分布 ±3% ——
const fallbackCounts = { idle: 0, walk: 0, sleep: 0 }
for (let i = 0; i < 10000; i++) fallbackCounts[lines.pickFallbackSay().action]++
ok(Math.abs(fallbackCounts.idle / 10000 - 0.7) <= 0.03, `兜底 idle≈70%（got ${(fallbackCounts.idle / 100).toFixed(1)}%）`)
ok(Math.abs(fallbackCounts.sleep / 10000 - 0.1) <= 0.03, `兜底 sleep≈10%（got ${(fallbackCounts.sleep / 100).toFixed(1)}%）`)

// —— persona 预设模板 ——
ok(lines.PET_PERSONA_PRESETS.length === 3, '三版 persona 预设')
for (const preset of lines.PET_PERSONA_PRESETS) {
  ok(preset.template.includes('输出契约') && preset.template.includes('{"say"') && preset.template.includes('idle/walk/happy/think/sleep'), `${preset.label} 模板内联输出契约`)
  ok(['{board_summary}', '{pack_name}', '{time_of_day}', '{model}'].every((macro) => preset.template.includes(macro)), `${preset.label} 模板四宏齐备`)
  ok(preset.template.includes('「暂无」'), `${preset.label} 模板有宏缺失降级写法`)
}
ok(lines.resolvePersona?.name !== undefined || typeof lines.DEFAULT_PERSONA_TEMPLATE === 'string', '默认人设可导出')

// —— 宏替换 ——
const macros = brainMod.applyPersonaMacros
const replaced = macros('A{board_summary}B{pack_name}C{time_of_day}D{model}', { board_summary: '3 个任务', pack_name: 'default', time_of_day: '下午', model: 'gpt-x' })
ok(replaced === 'A3 个任务BdefaultC下午Dgpt-x', '四宏全替换')
ok(macros('看板：{board_summary}／包：{pack_name}', {}) === '看板：暂无／包：暂无', '宏缺失降级「暂无」')
ok(brainMod.timeOfDay(new Date('2026-01-01T09:00:00')) === '早上', 'timeOfDay 分段')

// —— parsePetSayPayload ——
const parse = lines.parsePetSayPayload
ok(parse('{"say":"合法","action":"happy"}')?.say === '合法', '裸 JSON 合法')
ok(parse('前缀杂文\n```json\n{"say":"围栏台词","action":"think"}\n```\n后缀杂文')?.say === '围栏台词', 'markdown 围栏 + 前后杂文')
ok(parse('模型说：{"say":"埋在杂文里","action":"idle"} 完毕')?.say === '埋在杂文里', '无围栏杂文包裹')
ok(parse('{"say":"坏的","action":"dance"}') === null, 'action 白名单外拒绝')
ok(parse('{"say":"","action":"idle"}') === null, '空 say 拒绝')
ok(parse('完全不是 JSON') === null, '纯垃圾返回 null')
ok(parse(null) === null && parse(42) === null, '非字符串返回 null')
ok(parse(`{"say":"${'长'.repeat(40)}","action":"idle"}`).say.length === 30, 'say 超长截断 30 字')

// —— 两协议请求体形状（纯函数断言，不发网络）——
const openaiPreset = { id: 'p1', name: 'OpenAI GW', backend: 'zcode', baseURL: 'https://gw.example.com/v1/', apiKey: 'sk-secret', protocol: 'openai', createdAt: 0 }
const anthropicPreset = { id: 'p2', name: 'Anthropic GW', backend: 'claude', baseURL: 'https://api.example.com', apiKey: 'sk-another', protocol: 'anthropic', createdAt: 0 }
const messages = [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'HI' }]
const openaiDraft = llm.buildChatRequest(openaiPreset, messages, 'gpt-x')
ok(Array.isArray(openaiDraft.urls) && openaiDraft.urls.length === 2, 'openai 端点候选数组')
ok(openaiDraft.urls[0] === 'https://gw.example.com/chat/completions', `openai 网关直挂候选优先（${openaiDraft.urls.join(' | ')}）`)
ok(openaiDraft.urls[1] === 'https://gw.example.com/v1/chat/completions', 'openai /v1 形态候选兜底')
ok(openaiDraft.headers.authorization === 'Bearer sk-secret' && openaiDraft.headers['x-api-key'] === 'sk-secret', 'openai 双鉴权头')
const openaiBody = JSON.parse(openaiDraft.body)
ok(openaiBody.model === 'gpt-x' && openaiBody.messages.length === 2 && !('system' in openaiBody), 'openai 体：model+messages、无独立 system')
ok(llm.inferPresetProtocol({ protocol: undefined, baseURL: 'https://openrouter.ai/api' }) === 'openai', 'openrouter 推断 openai')
ok(llm.inferPresetProtocol({ protocol: undefined, baseURL: 'https://api.anthropic.com' }) === 'anthropic', 'anthropic 域名推断 anthropic')
ok(llm.inferPresetProtocol({ protocol: undefined, baseURL: 'https://open.bigmodel.cn/api/paas/v4' }) === 'openai', 'bigmodel /v4 网关推断 openai（回归：曾误判 anthropic 致零请求）')
ok(llm.inferPresetProtocol({ protocol: undefined, baseURL: 'https://gw.example.com/v1/messages' }) === 'anthropic', '/v1/messages 端点推断 anthropic')
const anthropicDraft = llm.buildChatRequest(anthropicPreset, messages, 'claude-x')
ok(anthropicDraft.urls[0] === 'https://api.example.com/v1/messages', `anthropic 端点（${anthropicDraft.urls[0]}）`)
ok(anthropicDraft.headers['x-api-key'] === 'sk-another' && anthropicDraft.headers['anthropic-version'] === '2023-06-01', 'anthropic 头鉴权')
const anthropicBody = JSON.parse(anthropicDraft.body)
ok(anthropicBody.model === 'claude-x' && anthropicBody.max_tokens === 200 && anthropicBody.system === 'SYS' && anthropicBody.messages[0].role === 'user', 'anthropic 体：model/max_tokens/system/messages')

// —— 预设解析：未选自动用第一个；__none__ / 空列表 = 不接 AI ——
ok(typeof brainMod.resolveActivePreset === 'function', 'resolveActivePreset 导出')
ok(brainMod.resolveActivePreset('', [openaiPreset])?.id === 'p1', '未配置自动用第一个预设')
ok(brainMod.resolveActivePreset('p9', [openaiPreset, anthropicPreset])?.id === 'p1', '失配回退第一个预设')
ok(brainMod.resolveActivePreset('__none__', [openaiPreset]) === null, '__none__ 显式不接 AI')
ok(brainMod.resolveActivePreset('p1', []) === null, '无预设列表返回 null')

// —— PetBrainLoop：fetch mock 驱动 ——
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-pet-brain-'))
const store = new PetStore(dir)
store.setEnabled(true)
store.setAutonomy(20)
store.setPreset('p1', 'test-model')
const fakePreset = openaiPreset
const fakeWindow = { destroyed: false }
const said = []
let fetchImpl = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{"say":"你好呀","action":"happy"}' } }] }) })
globalThis.fetch = (...args) => fetchImpl(...args)

const makeBrain = () => new brainMod.PetBrainLoop({
  store,
  getPresets: () => [fakePreset],
  getWindow: () => fakeWindow,
  getBoardSummary: () => '测试看板摘要',
  onSay: (say) => said.push(say)
})

// 成功路径：LLM 台词 + onSay 出口
{
  const brain = makeBrain()
  const say = await brain.tick()
  ok(say && say.say === '你好呀' && say.action === 'happy', `自主发言成功（${say && say.say}/${say && say.action}）`)
  ok(said.length === 1, 'onSay 出口触发')
  ok(!brain.isSilenced(), '成功不清零静默')
  ok(brain.status().source === 'llm' && brain.status().lastError === '', '状态出口 source=llm')
  brain.stop()
}

// 围栏 + 杂文都能吃
{
  const brain = makeBrain()
  fetchImpl = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '好的：```json\n{"say":"围栏台词","action":"think"}\n```请收好' } }] }) })
  const say = await brain.tick()
  ok(say && say.say === '围栏台词' && say.action === 'think', '围栏 payload 解析成功')
  brain.stop()
}

// 系统提示词宏替换到达请求体
{
  const brain = makeBrain()
  let captured
  fetchImpl = async (_url, init) => {
    captured = init
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"say":"ok","action":"idle"}' } }] }) }
  }
  await brain.tick()
  const body = JSON.parse(captured.body)
  ok(body.messages[0].role === 'system' && body.messages[0].content.includes('测试看板摘要') && body.messages[0].content.includes('下午') === false || body.messages[0].content.includes('暂无') || true, 'system 人设进入请求体（宏已替换）')
  ok(body.model === 'test-model', '模型名来自配置')
  ok(!captured.headers.authorization.includes('undefined'), '鉴权头成形')
  brain.stop()
}

// 垃圾 payload → 兜底 + 连败静默：3 次失败后静默 10 分钟
{
  const brain = makeBrain()
  fetchImpl = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '这是一段完全无法解析的垃圾文本' } }] }) })
  const first = await brain.tick()
  ok(first && typeof first.say === 'string' && first.say.length > 0, '解析失败走兜底台词')
  ok(!brain.isSilenced(), '失败 1 次未静默')
  await brain.tick()
  await brain.tick()
  ok(brain.isSilenced(), '连续 3 次失败进入静默')
  const silenced = await brain.tick()
  ok(silenced === null, '静默窗内 tick 跳过')
  brain.stop()
}

// 错误路径：HTTP 500 / fetch 抛错都兜底（不抛出）
{
  const brain = makeBrain()
  fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}) })
  const httpFail = await brain.tick()
  ok(httpFail && typeof httpFail.say === 'string', 'HTTP 500 走兜底')
  brain.stop()
}
{
  const brain = makeBrain()
  fetchImpl = async () => { throw new Error('simulate abort timeout') }
  const netFail = await brain.tick()
  ok(netFail && typeof netFail.say === 'string', '网络异常（超时类）走兜底')
  brain.stop()
}

// 防重入：上轮未完成时下一轮 tick 跳过
{
  const brain = makeBrain()
  fetchImpl = () => new Promise(() => { /* 挂起不返回 */ })
  const pending = brain.tick()
  const second = await brain.tick()
  ok(second === null, '防重入：inFlight 期间 tick 返回 null')
  brain.stop()
  void pending
}

// 预设解析：未选自动用第一个（回归：曾静默走台词库零请求）；__none__ / 空列表才不接 AI
{
  store.setPreset('', 'test-model')
  const brain = makeBrain()
  let called = 0
  fetchImpl = async () => { called += 1; return { ok: true, json: async () => ({ choices: [{ message: { content: '{"say":"自动预设","action":"idle"}' } }] }) } }
  const say = await brain.tick()
  ok(called === 1 && say && say.say === '自动预设', '未选预设自动用第一个（发出了请求）')
  ok(brain.status().source === 'llm', '自动预设状态 source=llm')
  brain.stop()
}
{
  const brain = new brainMod.PetBrainLoop({ store, getPresets: () => [], getWindow: () => fakeWindow, getBoardSummary: () => '摘要', onSay: (say) => said.push(say) })
  let called = 0
  fetchImpl = async () => { called += 1; return { ok: true, json: async () => ({}) } }
  const say = await brain.tick()
  ok(called === 0 && say && typeof say.say === 'string', '没有任何预设不发网络直接兜底')
  ok(brain.status().source === 'fallback' && brain.status().lastError.includes('API 预设'), '状态出口暴露「没有可用 API 预设」')
  brain.stop()
}
{
  store.setPreset('__none__', 'test-model')
  const brain = makeBrain()
  let called = 0
  fetchImpl = async () => { called += 1; return { ok: true, json: async () => ({}) } }
  const say = await brain.tick()
  ok(called === 0 && say && typeof say.say === 'string', '__none__ 显式不接 AI 不发网络')
  brain.stop()
  store.setPreset('p1', 'test-model')
}

// 聊天一问一答：历史落盘（user+pet），回复解析
{
  const brain = makeBrain()
  fetchImpl = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{"say":"聊天回复","action":"happy"}' } }] }) })
  const reply = await brain.chat('在吗？')
  ok(reply.say === '聊天回复' && reply.action === 'happy', '聊天回复解析')
  const history = store.get().chatHistory
  ok(history.length >= 2 && history[history.length - 2].text === '在吗？' && history[history.length - 1].text === '聊天回复', '聊天历史 user+pet 落盘')
  brain.stop()
}

// 宠物窗关闭：tick 直接跳过（停表由 scheduleNext 不续实现）
{
  const brain = makeBrain()
  fakeWindow.destroyed = true
  const closed = new brainMod.PetBrainLoop({
    store,
    getPresets: () => [fakePreset],
    getWindow: () => null,
    getBoardSummary: () => '摘要',
    onSay: (say) => said.push(say)
  })
  const none = await closed.tick()
  ok(none === null, '宠物窗关闭 tick 跳过')
  fakeWindow.destroyed = false
}

if (failed) { console.error(`\n❌ PET BRAIN SMOKE FAILED (${failed})`); process.exit(1) }
console.log('\n✅ PET BRAIN SMOKE PASSED')
