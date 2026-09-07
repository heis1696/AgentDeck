// 委派截获回归（AGENT-PROFILES-PLAN Phase 0）+ agent 级模型覆盖（Phase 1）：
// - Phase 0 真实事故（2026-09-07，任务 t_mtq13pd1_xy5y6t）：zcode 回合终态全文（含
//   未流式思考内容）比流式累计更长却不含中间消息里的 <delegate> 标记，旧逻辑按
//   "长度取长"二选一丢弃含标记来源 → 委派静默失效。修复 = mergeTurnTexts 两源
//   并集 + parseDelegatesMerged 多源去重。
// - Phase 1：buildRuntimeModelFromCliConfig(modelRef) 解析覆盖（隔离 HOME，不碰真实
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
const { mergeTurnTexts, buildRuntimeModelFromCliConfig, listZcodeModels } = await import(pathToFileURL(path.join(root, 'out/sm-zcode.cjs')).href)

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

// ============ Phase 1：zcode runtimeModel 覆盖（隔离 HOME） ============
const ORIG_HOME = process.env.USERPROFILE
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-model-home-'))
fs.mkdirSync(path.join(fakeHome, '.zcode', 'cli'), { recursive: true })
fs.writeFileSync(path.join(fakeHome, '.zcode', 'cli', 'config.json'), JSON.stringify({
  provider: {
    zai: { kind: 'anthropic', name: 'Z.ai', options: { baseURL: 'https://fake.z.ai', apiKey: 'sk-fake' }, models: { 'glm-5.3': { name: 'GLM-5.3' }, 'glm-5.2': {}, 'glm-5-turbo': {} } },
    beta: { kind: 'anthropic', name: 'Beta', options: { baseURL: 'https://fake.beta', apiKey: 'sk-fake2' }, models: { 'glm-x': {} } }
  },
  model: { main: 'zai/glm-5.3', lite: 'zai/glm-4.7' }
}))
process.env.USERPROFILE = fakeHome // os.homedir() 在 Windows 优先读 USERPROFILE

const rmDefault = buildRuntimeModelFromCliConfig()
assert(rmDefault?.model?.providerId === 'zai' && rmDefault.model.modelId === 'glm-5.3', '无覆盖：沿用 config 默认 zai/glm-5.3')
const rmBare = buildRuntimeModelFromCliConfig('glm-5.2')
assert(rmBare?.model?.providerId === 'zai' && rmBare.model.modelId === 'glm-5.2', '裸 modelId：provider 沿用默认，模型覆盖为 glm-5.2')
assert(rmBare?.provider?.baseURL === 'https://fake.z.ai' && Array.isArray(rmBare.provider?.models), 'provider 注册表快照完整（baseURL/models）')
const rmSlash = buildRuntimeModelFromCliConfig('beta/glm-x')
assert(rmSlash?.model?.providerId === 'beta' && rmSlash.model.modelId === 'glm-x' && rmSlash.provider?.providerId === 'beta', 'prov/model 形式：双路由到 beta/glm-x')
const rmCustom = buildRuntimeModelFromCliConfig('glm-9.9')
assert(rmCustom?.model?.modelId === 'glm-9.9' && rmCustom.provider?.models?.some((m) => m.modelId === 'glm-9.9'), '目录缺项时补录模型')
assert(buildRuntimeModelFromCliConfig('nope/m1') === null, 'provider 不存在返回 null')

const catalog = listZcodeModels()
assert(catalog.models.length === 4 && catalog.models.includes('glm-x') && catalog.defaultModel === 'glm-5.3', `模型目录并集 + 默认（${catalog.models.join(',')}）`)

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
  // 网关/供应商侧临时故障（5xx、限流、账户池耗尽）不代表接线问题：CLI 已接受
  // --model 并发起请求。跳过而非失败，其余错误照常判败。
  if (outcome.error && /5\d\d|server-side|no available accounts|rate.?limit|overloaded/i.test(outcome.error)) {
    console.log(`  - claude 网关临时故障，跳过 --model 实测（${outcome.error.slice(0, 110)}）`)
  } else {
    assert(!outcome.error, `claude 带 --model sonnet 完成一回合（${outcome.error ?? outcome.session.sessionId.slice(0, 10) + '…'}）`)
    assert(turn?.ok && (turn?.response ?? '').includes('pineapple'), '回合结果正确')
  }
}

console.log('\n✅ SMOKE-MODEL PASSED')
process.exit(0)
