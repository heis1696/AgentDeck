// 委派截获回归（AGENT-PROFILES-PLAN Phase 0）+ agent 级模型覆盖（Phase 1）：
// - Phase 0 真实事故（2026-09-07，任务 t_mtq13pd1_xy5y6t）：zcode 回合终态全文（含
//   未流式思考内容）比流式累计更长却不含中间消息里的 <delegate> 标记，旧逻辑按
//   "长度取长"二选一丢弃含标记来源 → 委派静默失效。修复 = mergeTurnTexts 两源
//   并集 + parseDelegatesMerged 多源去重。
// - Phase 1：buildModelSelectionFromCliConfig(modelRef) 解析覆盖（隔离 HOME，不碰真实
//   zcode 配置）；claude --model 实测（探测不到则跳过）。
// - Phase 1b：内置 provider 目录新鲜度 + 模型档位回退（2026-11 真实事故：新模型 GLM-5.4 在
//   app-server 注册表里不存在）——隔离 HOME + 假 bundle + 假运行时槽位，端到端走假 app-server。
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
        // 无 low/high 档、只有 disabled/enabled 的模型：覆盖 off 命中 disabled 与各档回落 enabled 链
        'GLM-5.1': { reasoning: { enabled: true, variants: ['disabled', 'enabled'], defaultVariant: 'enabled' } },
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

// 思考强度 → 目录 variant 就近选档（精确命中 / 缺档上调回落 / off→disabled / 全不在→defaultVariant）
const pickVariant = (model, thinking) => buildModelSelectionFromCliConfig(model, undefined, thinking)?.options?.reasoningLevel
assert(pickVariant('GLM-5.3', 'low') === 'low', 'thinking=low：精确命中 low 档')
assert(pickVariant('GLM-5.3', 'high') === 'high' && pickVariant('GLM-5.3', 'max') === 'max', 'thinking=high/max：精确命中')
assert(pickVariant('GLM-5.3', 'medium') === 'high', 'thinking=medium：无 medium 档上调 high')
assert(pickVariant('GLM-5.3', 'off') === 'max', 'thinking=off：无 disabled 档回落 defaultVariant')
assert(pickVariant('GLM-5.1', 'off') === 'disabled', 'thinking=off：有 disabled 档精确命中')
assert(pickVariant('GLM-5.1', 'low') === 'enabled' && pickVariant('GLM-5.1', 'high') === 'enabled' && pickVariant('GLM-5.1', 'max') === 'enabled', 'thinking=low/high/max：无同名档回落 enabled')
assert(pickVariant('GLM-5.1', 'medium') === 'enabled', 'thinking=medium：medium/high 都无档回落 defaultVariant')
assert(buildModelSelectionFromCliConfig('GLM-5.3-Flash', undefined, 'max')?.options === undefined, '非 reasoning 模型忽略思考档位')
assert(pickVariant('GLM-5.3', undefined) === 'max', 'thinking 未设：保持 defaultVariant（现状回归）')

// API 预设连接：upsert 进 v2 注册表（个人 provider 规则）后按派生 id 引用
const conn = { name: '某中转站', baseURL: 'https://relay.example/v1', apiKey: 'sk-relay' }
const readPresetConfig = () => JSON.parse(fs.readFileSync(path.join(fakeHome, '.zcode', 'v2', 'provider_config.json'), 'utf8'))
const rmPreset = buildModelSelectionFromCliConfig('glm-5.3', conn)
assert(/^agentdeck-[0-9a-f]{8}$/.test(rmPreset?.providerId ?? '') && rmPreset?.modelId === 'GLM-5.3', `预设+模型：id 由 baseURL 派生（${rmPreset?.providerId}），模型归一到目录 id`)
assert(rmPreset?.options?.reasoningLevel === 'high', '预设模型引用带注册时声明的 reasoningLevel')
const presetRule = readPresetConfig().config.providerConfigRules.providerRules.find((r) => r.providerId === rmPreset.providerId)
assert(presetRule?.providerName === '某中转站' && presetRule?.config?.group === 'standard-personal' && presetRule?.config?.access?.apiKey === 'sk-relay' && presetRule?.config?.api?.baseUrl === 'https://relay.example/v1', 'providerRule 写入（group/access/api 齐全）')
assert(presetRule?.config?.personalModelIds?.[0] === 'GLM-5.3', 'personalModelIds 用归一 id')
const presetModelRule = readPresetConfig().config.modelConfigRules.providerModelRules.find((r) => r.providerId === rmPreset.providerId)
assert(presetModelRule?.config?.enabled === true && presetModelRule?.config?.optionSpecs?.reasoningLevel?.values?.[0] === 'high' && !!presetModelRule?.config?.properties?.contextWindow, 'providerModelRule 完整定义（properties+optionSpecs 自控）')
assert(presetModelRule?.config?.optionSpecs?.reasoningLevel?.map === '{}', 'thinking 未设：map 空（不发参数，现状回归）')
buildModelSelectionFromCliConfig('glm-5.3', conn)
const rulesAfter = readPresetConfig().config.providerConfigRules.providerRules.filter((r) => r.providerId === rmPreset.providerId)
assert(rulesAfter.length === 1, '重复 upsert 幂等（不翻倍）')
assert(readPresetConfig().config.providerConfigRules.providerRules.some((r) => r.providerId === 'bigmodel-api'), '桌面端已有规则不受影响')
const rmPresetUnknown = buildModelSelectionFromCliConfig('gpt-x', conn)
assert(rmPresetUnknown?.modelId === 'gpt-x' && rmPresetUnknown?.options?.reasoningLevel === 'high', '目录外模型同样注册完整定义并带 level（union-alpha 场景）')
const rmPresetSlash = buildModelSelectionFromCliConfig('relay/glm-x9', conn)
assert(rmPresetSlash?.modelId === 'glm-x9', '预设+prov/model 形式：取尾段 modelId')
const rmConnNoModel = buildModelSelectionFromCliConfig(undefined, conn)
assert(rmConnNoModel?.providerId === 'bigmodel-api' && rmConnNoModel.modelId === 'GLM-5.3', '预设无模型：忽略连接，走平台默认')

// 线协议：显式声明优先，缺省按 baseURL 推断（/v1 结尾或 openrouter.ai → openai）
const openaiConn = { name: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', apiKey: 'sk-or' }
const rmOpenai = buildModelSelectionFromCliConfig('deepseek/deepseek-v4-pro', openaiConn)
const openaiRule = readPresetConfig().config.providerConfigRules.providerRules.find((r) => r.providerId === rmOpenai.providerId)
assert(openaiRule?.config?.api?.type === 'openai-chat-completions', 'OpenRouter 预设自动推断为 openai 协议（/messages 会 404）')
const anthropicConn = { name: 'anthropic 直连', baseURL: 'https://relay.example/anthropic', apiKey: 'sk-a' }
buildModelSelectionFromCliConfig('glm-5.3', anthropicConn)
const anthropicRule = readPresetConfig().config.providerConfigRules.providerRules.find((r) => r.providerName === 'anthropic 直连')
assert(anthropicRule?.config?.api?.type === 'anthropic-messages', '无推断特征保持 anthropic（历史行为）')
const explicitConn = { name: '显式覆盖', baseURL: 'https://relay.example/anthropic', apiKey: 'sk-a', protocol: 'openai' }
buildModelSelectionFromCliConfig('glm-5.3', explicitConn)
const explicitRule = readPresetConfig().config.providerConfigRules.providerRules.find((r) => r.providerName === '显式覆盖')
assert(explicitRule?.config?.api?.type === 'openai-chat-completions', '显式 protocol 声明优先于推断')

// 思考强度 → 预设线 optionSpecs 与引用档位（同 provider+model 幂等替换，逐档读最新规则）
const presetLevel = (connArg, thinking) => {
  const sel = buildModelSelectionFromCliConfig('glm-5.3', connArg, thinking)
  const spec = readPresetConfig().config.modelConfigRules.providerModelRules.find((r) => r.providerId === sel?.providerId && r.modelId === sel?.modelId)?.config?.optionSpecs?.reasoningLevel
  return { ref: sel?.options?.reasoningLevel, values: spec?.values, map: spec?.map }
}
let lv = presetLevel(conn, 'off')
assert(lv.ref === 'disabled' && lv.values?.[0] === 'disabled' && lv.map === '{}', 'thinking=off：引用与 values 均 disabled，map 空（不发参数即关）')
lv = presetLevel(conn, 'low')
assert(lv.ref === 'low' && lv.values?.[0] === 'low' && lv.map === undefined, 'thinking=low：单值档且不写 map（交给 zcode 默认映射发参数）')
lv = presetLevel(conn, 'high')
assert(lv.ref === 'high' && lv.values?.[0] === 'high' && lv.map === undefined, 'thinking=high：单值档且不写 map')
lv = presetLevel(conn, 'max')
assert(lv.ref === 'max' && lv.values?.[0] === 'max' && lv.map === undefined, 'thinking=max：单值档且不写 map')
lv = presetLevel(conn, 'medium')
assert(lv.ref === 'medium' && lv.values?.[0] === 'medium' && lv.map === undefined, 'thinking=medium：openai 协议（/v1 推断）保留 medium')
lv = presetLevel(anthropicConn, 'medium')
assert(lv.ref === 'high' && lv.values?.[0] === 'high' && lv.map === undefined, 'thinking=medium：anthropic 协议上调 high')

const catalog = listZcodeModels()
assert(catalog.models.length === 3 && catalog.models.includes('GLM-5.3') && catalog.defaultModel === undefined, `模型目录来自 v2 桌面端目录（${catalog.models.join(',')}）`)

// ============ Phase 1b：内置 provider 目录新鲜度（2026-11 真实事故：GLM-5.4） ============
// 桌面端更新后新模型只存在于新版内置目录（revision 47）；裸启动的 CLI 自行推导目录路径会卡在
// revision 28 → setModel 报 "Provider Registry 中不存在 Model"。修好目录后还有第二层：桌面端
// v2/config.json 已停更、没有该模型 → 不带档位 → "Reasoning level is required"。
const { createZcodeBackend, zcodeProviderRuntimeEnv, modelLevelFallbacks, isReasoningLevelRejection, modelLevelAdjustment } = await import(pathToFileURL(path.join(root, 'out/sm-zcode.cjs')).href)

// 假 bundle：可执行的假 app-server + 自带旧目录（revision 28，没有 GLM-5.4）
const fakeBundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-model-bundle-'))
const fixture = path.join(fakeBundleDir, 'zcode-fake.mjs')
fs.copyFileSync(path.join(root, 'scripts', 'fixtures', 'fake-zcode-app-server.mjs'), fixture)
// 内置目录最小形状：个人 provider（夹具注册表里的 bigmodel-api）引用的模板 + 模板模型规则
const builtinCatalog = (revision, modelIds) => JSON.stringify({
  schemaVersion: 1,
  revision,
  config: {
    providerConfigRules: {
      templateRules: [
        { templateId: 'bigmodel-api', config: { builtinModelIds: modelIds } },
        { templateId: 'other-api', config: { builtinModelIds: ['OTHER-1'] } }
      ],
      providerRules: []
    },
    modelConfigRules: { templateModelRules: [{ templateId: 'bigmodel-api', modelId: 'GLM-5-Turbo', config: { enabled: false } }] }
  }
})
fs.mkdirSync(path.join(fakeBundleDir, 'provider'))
const bundled = path.join(fakeBundleDir, 'provider', 'zcode-builtin.json')
fs.writeFileSync(bundled, builtinCatalog(28, ['GLM-5.3', 'GLM-5.3-Flash', 'GLM-5-Turbo']))

const withoutNew = listZcodeModels(fixture).models
assert(withoutNew.join(',') === 'GLM-5.3,GLM-5.1,GLM-5.3-Flash', `bundle 侧旧目录没有新模型：目录不变，模板停用的与其它模板的模型都不进（${withoutNew.join(',')}）`)
const rmNewRaw = buildModelSelectionFromCliConfig('glm-5.4', undefined, 'max', fixture)
assert(rmNewRaw?.providerId === 'bigmodel-api' && rmNewRaw.modelId === 'glm-5.4' && rmNewRaw.options === undefined, '目录外新模型：按原引用透传、不带档位（现状）')
const personal = path.join(fakeHome, '.zcode', 'v2', 'provider_config.json')
const envBundled = zcodeProviderRuntimeEnv(fixture)
assert(envBundled.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE === bundled && envBundled.ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE === bundled, 'provider env：内置目录指向 bundle 自带那份（本地没有更新的）')
assert(envBundled.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE === personal, 'provider env：个人配置一并显式传入（缺了 CLI 会改回自己的槽位）')

// 桌面端为各版本 CLI 下载的运行时槽位：revision 更大的一份胜出，哪怕另一份 mtime 更新
const slot = (version, content, mtime) => {
  const dir = path.join(fakeHome, '.zcode', 'v2', 'runtime', 'provider', 'test-platform', version, 'endpoint-test')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'zcode-builtin.json')
  fs.writeFileSync(file, content)
  fs.utimesSync(file, mtime, mtime)
  return file
}
const day = 86400e3
slot('9.9.8', builtinCatalog(30, ['GLM-5.3']), new Date(Date.now() + day))
const fresh = slot('9.9.9', builtinCatalog(47, ['GLM-5.4', 'GLM-5.3', 'GLM-5.3-Flash']), new Date(Date.now() - day))
const envFresh = zcodeProviderRuntimeEnv(fixture)
assert(envFresh.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE === fresh && envFresh.ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE === fresh, 'provider env：内置目录取本地 revision 最大的一份（不以 mtime 论新旧）')
const withNew = listZcodeModels(fixture).models
assert(withNew.join(',') === 'GLM-5.3,GLM-5.1,GLM-5.3-Flash,GLM-5.4', `新上模型补进目录、排在既有条目之后（${withNew.join(',')}）`)
assert(buildModelSelectionFromCliConfig(undefined, undefined, undefined, fixture)?.modelId === 'GLM-5.3', '默认模型仍是目录首项（新模型不改变既有默认）')
const rmNew = buildModelSelectionFromCliConfig('glm-5.4', undefined, 'max', fixture)
assert(rmNew?.providerId === 'bigmodel-api' && rmNew.modelId === 'GLM-5.4' && rmNew.options === undefined, '新上模型：id 归一到内置目录大小写，档位留给 setModel 按注册表回退')

// 档位回退序列：本地目录的首选 → thinking 就近档 → 强度降序 → 不带档位（去重保序）
const sequence = (model, thinking) => modelLevelFallbacks(buildModelSelectionFromCliConfig(model, undefined, thinking, fixture), thinking)
const show = (levels) => levels.map((level) => level ?? '∅').join(' → ')
const expectSeq = (model, thinking, expected, label) => {
  const got = sequence(model, thinking)
  assert(got.length === expected.length && got.every((level, i) => level === expected[i]), `${label}（${show(got)}）`)
}
expectSeq('GLM-5.4', 'max', [undefined, 'max', 'high', 'enabled', 'medium', 'low', 'disabled'], '目录外模型 + thinking=max：不带档位 → max → high → enabled → 强度降序')
expectSeq('GLM-5.3', 'low', ['low', 'enabled', 'max', 'high', 'medium', 'disabled', undefined], '本地首选 low → 就近档 enabled → 强度降序 → 不带档位')
expectSeq('GLM-5.3-Flash', 'max', [undefined, 'max', 'high', 'enabled', 'medium', 'low', 'disabled'], '本地非 reasoning 模型：先不带档位，被拒才降级重试')
assert(isReasoningLevelRejection('Reasoning level is required for zai-api/GLM-5.4') && isReasoningLevelRejection('Reasoning effort "medium" is not supported by zai-api/GLM-5.4'), '档位拒绝识别：缺档位 / 档位不支持')
assert(!isReasoningLevelRejection('Provider Registry 中不存在 Model: zai-api/GLM-5.4'), '模型不存在不是档位拒绝（不得触发回退重试）')
const selNew = buildModelSelectionFromCliConfig('GLM-5.4', undefined, undefined, fixture)
const selLegacy = buildModelSelectionFromCliConfig('GLM-5.1', undefined, undefined, fixture)
assert(selLegacy?.options?.reasoningLevel === 'enabled', '前置：GLM-5.1 本地默认档位是 enabled')
assert(modelLevelAdjustment(selNew, 'max', 'max') === null, '命中 thinking 档位：不提示')
assert(modelLevelAdjustment(selNew, undefined, 'max') === '思考档位就近调整: 默认 → max', '未设 thinking 的新模型：说明实际采用的档位')
assert(modelLevelAdjustment(selLegacy, undefined, 'high') === '思考档位就近调整: enabled → high', '本地默认被拒后换档：说明前后档位')
assert(modelLevelAdjustment(selLegacy, undefined, undefined) === '思考档位已忽略: enabled（注册表不支持任何档位）', '注册表不认任何档位：说明档位被忽略')
assert(modelLevelAdjustment(selLegacy, 'low', 'enabled') === null, '本地首选被接受：不提示')

// 端到端（假 app-server 的 reasoning-level 场景）：走真实 backend.start → spawn → setModel 路径
fs.mkdirSync(path.join(fakeHome, '.zcode', 'cli'), { recursive: true })
fs.writeFileSync(path.join(fakeHome, '.zcode', 'cli', 'config.json'), JSON.stringify({ provider: {}, model: { main: 'bigmodel-api/GLM-5.3' } }))
const setModelLog = path.join(fakeBundleDir, 'setmodel.log')
const ORIG_SCENARIO = process.env.FAKE_SCENARIO
process.env.FAKE_SCENARIO = 'reasoning-level'
process.env.FAKE_SETMODEL_LOG = setModelLog
const readAttempts = () => (fs.existsSync(setModelLog) ? fs.readFileSync(setModelLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [])
const levelsOf = (attempts) => attempts.map((m) => m.options?.reasoningLevel)
const backend = createZcodeBackend(() => ({ nodePath: process.execPath, zcodePath: fixture }))
const runTurn = async (model, thinking) => {
  fs.rmSync(setModelLog, { force: true })
  const events = []
  let resolveEnd = () => {}
  const ended = new Promise((resolve) => { resolveEnd = resolve })
  let session = null
  let outcome
  try {
    session = await backend.start({ prompt: 'hi', workdir: fakeBundleDir, mode: 'yolo', model, thinking, events: { onEvent: (e) => events.push(e), onTurnEnd: resolveEnd } })
    outcome = await Promise.race([ended, new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: 'turn timeout' }), 10000))])
  } catch (e) {
    outcome = { ok: false, error: String(e?.message ?? e) }
  }
  await session?.close().catch(() => {})
  return { ...outcome, attempts: readAttempts(), statuses: events.filter((e) => e.kind === 'status').map((e) => e.text) }
}
const t1 = await runTurn('glm-5.4', 'max')
assert(t1.ok && show(levelsOf(t1.attempts)) === '∅ → max' && t1.attempts.at(-1).modelId === 'GLM-5.4', `新模型 + thinking=max：不带档位被拒后回退到 max，模型引用不变（尝试 ${show(levelsOf(t1.attempts))}）`)
assert(t1.statuses.includes('模型已设置: bigmodel-api/GLM-5.4') && !t1.statuses.some((s) => s.includes('思考档位')), '命中 thinking 档位：只报模型已设置')
const t2 = await runTurn('GLM-5.1', undefined)
assert(t2.ok && show(levelsOf(t2.attempts)) === 'enabled → max → high', `本地默认档位被拒：按强度降序回退（尝试 ${show(levelsOf(t2.attempts))}）`)
assert(t2.statuses.includes('思考档位就近调整: enabled → high'), '实际档位与本地默认不一致：给出状态说明')
const t3 = await runTurn('GLM-9.9', 'max')
assert(!t3.ok && /Provider Registry 中不存在 Model: bigmodel-api\/GLM-9\.9/.test(t3.error ?? '') && t3.attempts.length === 1, `模型不存在：原样上抛、不触发档位回退（${String(t3.error).slice(0, 60)}）`)
const t4 = await runTurn('GLM-5.3-Flash', 'max')
assert(t4.ok && t4.attempts.length === 1 && levelsOf(t4.attempts)[0] === undefined, '注册表不要求档位的模型：首次不带档位即被接受，无多余请求')
if (ORIG_SCENARIO === undefined) delete process.env.FAKE_SCENARIO
else process.env.FAKE_SCENARIO = ORIG_SCENARIO
delete process.env.FAKE_SETMODEL_LOG
try { fs.rmSync(fakeBundleDir, { recursive: true, force: true }) } catch {}

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
