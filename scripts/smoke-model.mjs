// 委派截获回归（AGENT-PROFILES-PLAN Phase 0）+ agent 级模型覆盖（Phase 1）：
// - Phase 0 真实事故（2026-09-07，任务 t_mtq13pd1_xy5y6t）：zcode 回合终态全文（含
//   未流式思考内容）比流式累计更长却不含中间消息里的 <delegate> 标记，旧逻辑按
//   "长度取长"二选一丢弃含标记来源 → 委派静默失效。修复 = mergeTurnTexts 两源
//   并集 + parseDelegatesMerged 多源去重。
// - Phase 1：buildModelSelectionFromCliConfig(modelRef) 解析覆盖（隔离 HOME，不碰真实
//   zcode 配置）；claude --model 实测（探测不到则跳过）。
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

const root = path.resolve(import.meta.dirname, '..')
for (const [src, out] of [
  ['src/main/delegate.ts', 'out/sm-delegate.cjs'],
  ['src/main/backends/zcode.ts', 'out/sm-zcode.cjs'],
  ['src/main/backends/claude.ts', 'out/sm-claude.cjs']
]) {
  await build({ entryPoints: [path.join(root, src)], outfile: path.join(root, out), bundle: true, platform: 'node', format: 'cjs', target: 'node18' })
}
const { parseDelegates, parseDelegatesMerged } = await import(pathToFileURL(path.join(root, 'out/sm-delegate.cjs')).href)
const { mergeTurnTexts, buildModelSelectionFromCliConfig, listZcodeModels } = await import(pathToFileURL(path.join(root, 'out/sm-zcode.cjs')).href)

const assert = (cond, msg) => { if (!cond) { console.error('❌', msg); process.exit(1) } console.log('  ✓', msg) }

// ============ Phase 0：委派截获 ============
assert(mergeTurnTexts('abc', '') === 'abc', 'mergeTurnTexts：流式为空取终态全文')
assert(mergeTurnTexts('abc', 'b') === 'abc', 'mergeTurnTexts：终态包含流式取终态')
assert(mergeTurnTexts('b', 'abc') === 'abc', 'mergeTurnTexts：流式包含终态取流式')

const streamed = '我先派两个队员。\n<delegate to="DeepSeek" reason="调研">分析 cc-switch</delegate>\n<delegate to="Claude">梳理 UI 改造点</delegate>\n\n两个子任务已派出，等结果。'
const lastMessage = '两个子任务已派出，等结果。'
const full = `（思考：需要并行调研，先拆两块……）${'（此段不流式展示，仅存在于终态）'.repeat(40)}\n${lastMessage}`
assert(full.length > streamed.length, '前置：终态全文确实更长（旧逻辑会选中它）')
assert(parseDelegates(full).length === 0, '前置：旧口径（只看终态全文）解析为 0 —— 事故根因')
const scan = mergeTurnTexts(full, streamed)
assert(scan.includes('<delegate'), 'mergeTurnTexts：互不包含时拼接，标记不再丢失')
const calls = parseDelegatesMerged(scan, lastMessage)
assert(calls.length === 2, `并集多源解析找回两个委派（${calls.length}）`)
assert(calls[0].to === 'DeepSeek' && calls[0].reason === '调研' && calls[0].prompt.includes('cc-switch'), '第一个委派完整（to/reason/prompt）')
assert(calls[1].to === 'Claude' && calls[1].reason === undefined, '第二个委派 reason 可省略')

assert(parseDelegatesMerged(streamed, streamed).length === 2, '同一标记出现在多个来源只计一次')
assert(parseDelegatesMerged('', 'x <delegate to="甲">A</delegate> y').length === 1, '空来源安全')
assert(parseDelegatesMerged().length === 0, '无来源返回空')
assert(parseDelegates(streamed).length === 2, 'parseDelegates 单源行为不变')

const normal = '正文。<delegate to="甲">A</delegate>'
assert(mergeTurnTexts(normal, normal) === normal, '两源相同直接返回，不翻倍')
assert(mergeTurnTexts('甲。\n\n乙。', '甲。乙。') === '甲。\n\n乙。', '互含（空白不敏感）取终态全文——保真消息分隔（final-dedup 契约）')
assert(mergeTurnTexts('', streamed) === streamed, '终态为空守卫：返回流式累计')

// ============ Phase 1：zcode model 覆盖（隔离 HOME，读 v2 注册表） ============
const ORIG_HOME = process.env.USERPROFILE
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-model-home-'))
fs.mkdirSync(path.join(fakeHome, '.zcode', 'v2'), { recursive: true })
// 桌面端目录：v2/config.json 的 provider models（大小写敏感、带 reasoning 元数据）
fs.writeFileSync(path.join(fakeHome, '.zcode', 'v2', 'config.json'), JSON.stringify({
  provider: {
    'builtin:bigmodel': {
      name: 'Bigmodel',
      models: {
        'GLM-5.3': { reasoning: { enabled: true, variants: ['low', 'max', 'high'], defaultVariant: 'max' }, limit: { context: 200000, output: 32000 } },
        'GLM-5.3-Flash': {}
      }
    }
  }
}))
// 注册表：v2/provider_config.json 的 providerRules（引用用的 providerId 来源）
fs.writeFileSync(path.join(fakeHome, '.zcode', 'v2', 'provider_config.json'), JSON.stringify({
  schemaVersion: 1,
  config: {
    providerConfigRules: { providerRules: [{ providerId: 'bigmodel-api', templateId: 'bigmodel-api', config: { group: 'standard-personal', access: { type: 'api-key', apiKey: 'sk-fake' } } }] },
    modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] }
  }
}))
process.env.USERPROFILE = fakeHome // os.homedir() 在 Windows 优先读 USERPROFILE

const rmDefault = buildModelSelectionFromCliConfig()
assert(rmDefault?.providerId === 'bigmodel-api' && rmDefault.modelId === 'GLM-5.3', '无覆盖：provider 取注册表首项，模型取目录首项')
assert(rmDefault?.options?.reasoningLevel === 'max', 'reasoning 模型自动带 defaultVariant 的 reasoningLevel')
const rmBare = buildModelSelectionFromCliConfig('glm-5.3')
assert(rmBare?.providerId === 'bigmodel-api' && rmBare.modelId === 'GLM-5.3' && rmBare.options?.reasoningLevel === 'max', '裸 modelId：大小写归一到目录 id，provider 取注册表首项')
const rmFlash = buildModelSelectionFromCliConfig('GLM-5.3-Flash')
assert(rmFlash?.modelId === 'GLM-5.3-Flash' && rmFlash.options === undefined, '非 reasoning 模型不带 options')
const rmSlash = buildModelSelectionFromCliConfig('bigmodel-api/GLM-5.3')
assert(rmSlash?.providerId === 'bigmodel-api' && rmSlash.modelId === 'GLM-5.3', 'prov/model 形式：路由到注册表 provider')
const rmCustom = buildModelSelectionFromCliConfig('glm-9.9')
assert(rmCustom?.modelId === 'glm-9.9' && rmCustom.providerId === 'bigmodel-api' && rmCustom.options === undefined, '目录外模型按原引用透传（服务端给出明确 ModelNotFound）')
assert(buildModelSelectionFromCliConfig('nope/m1') === null, 'provider 不在注册表返回 null')

// API 预设连接：upsert 进 v2 注册表（个人 provider 规则）后按派生 id 引用
const conn = { name: '某中转站', baseURL: 'https://relay.example/v1', apiKey: 'sk-relay' }
const readPresetConfig = () => JSON.parse(fs.readFileSync(path.join(fakeHome, '.zcode', 'v2', 'provider_config.json'), 'utf8'))
const rmPreset = buildModelSelectionFromCliConfig('glm-5.3', conn)
assert(/^agentdeck-[0-9a-f]{8}$/.test(rmPreset?.providerId ?? '') && rmPreset?.modelId === 'GLM-5.3', `预设+模型：id 由 baseURL 派生（${rmPreset?.providerId}），模型归一到目录 id`)
assert(rmPreset?.options?.reasoningLevel === 'max', '预设 reasoning 模型同样带 defaultVariant')
const presetRule = readPresetConfig().config.providerConfigRules.providerRules.find((r) => r.providerId === rmPreset.providerId)
assert(presetRule?.providerName === '某中转站' && presetRule?.config?.group === 'standard-personal' && presetRule?.config?.access?.apiKey === 'sk-relay' && presetRule?.config?.api?.baseUrl === 'https://relay.example/v1', 'providerRule 写入（group/access/api 齐全）')
assert(presetRule?.config?.personalModelIds?.[0] === 'GLM-5.3', 'personalModelIds 用归一 id')
const presetModelRule = readPresetConfig().config.modelConfigRules.providerModelRules.find((r) => r.providerId === rmPreset.providerId)
assert(presetModelRule?.modelId === 'GLM-5.3' && presetModelRule?.config?.enabled === true, 'providerModelRule 登记（enabled）')
buildModelSelectionFromCliConfig('glm-5.3', conn)
const rulesAfter = readPresetConfig().config.providerConfigRules.providerRules.filter((r) => r.providerId === rmPreset.providerId)
assert(rulesAfter.length === 1, '重复 upsert 幂等（不翻倍）')
assert(readPresetConfig().config.providerConfigRules.providerRules.some((r) => r.providerId === 'bigmodel-api'), '桌面端已有规则不受影响')
const rmPresetUnknown = buildModelSelectionFromCliConfig('gpt-x', conn)
assert(rmPresetUnknown?.modelId === 'gpt-x' && rmPresetUnknown?.options === undefined, '目录外模型按原引用注册（无 reasoning options）')
const rmPresetSlash = buildModelSelectionFromCliConfig('relay/glm-x9', conn)
assert(rmPresetSlash?.modelId === 'glm-x9', '预设+prov/model 形式：取尾段 modelId')
const rmConnNoModel = buildModelSelectionFromCliConfig(undefined, conn)
assert(rmConnNoModel?.providerId === 'bigmodel-api' && rmConnNoModel.modelId === 'GLM-5.3', '预设无模型：忽略连接，走平台默认')

const catalog = listZcodeModels()
assert(catalog.models.length === 2 && catalog.models.includes('GLM-5.3') && catalog.defaultModel === undefined, `模型目录来自 v2 桌面端目录（${catalog.models.join(',')}）`)

process.env.USERPROFILE = ORIG_HOME // 还原，避免影响后续 claude 实测读真实配置

// ============ Phase 1：claude --model 实测（探测不到/网关临时故障则跳过） ============
const { createClaudeBackend } = await import(pathToFileURL(path.join(root, 'out/sm-claude.cjs')).href)
const claudeBackend = createClaudeBackend()
const claudeProbe = await claudeBackend.probe()
if (!claudeProbe.ok) {
  console.log(`  - claude 不可用，跳过 --model 实测（${claudeProbe.detail}）`)
} else {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-model-cli-'))
  fs.writeFileSync(path.join(workdir, 'note.txt'), 'the secret word is pineapple\n')
  let turn = null
  const outcome = await claudeBackend.start({
    prompt: '读取当前目录下 note.txt，只回复那个秘密单词本身，不要其他内容。',
    workdir,
    mode: 'yolo',
    model: 'sonnet',
    events: {
      onEvent: () => {},
      onTurnEnd: (r) => { turn = r }
    }
  }).then(
    (session) => ({ session }),
    (e) => ({ error: String(e?.message ?? e) })
  )
  // 网关/供应商侧故障（5xx、限流、账户池耗尽、模型无权限/不存在）不代表接线问题：CLI 已接受
  // --model 并发起请求。跳过而非失败，其余错误照常判败。
  if (outcome.error && /5\d\d|server-side|no available accounts|rate.?limit|overloaded|may not exist|not have access/i.test(outcome.error)) {
    console.log(`  - claude 网关临时故障，跳过 --model 实测（${outcome.error.slice(0, 110)}）`)
  } else {
    assert(!outcome.error, `claude 带 --model sonnet 完成一回合（${outcome.error ?? outcome.session.sessionId.slice(0, 10) + '…'}）`)
    assert(turn?.ok && (turn?.response ?? '').includes('pineapple'), '回合结果正确')
  }
}

console.log('\n✅ SMOKE-MODEL PASSED')
process.exit(0)
