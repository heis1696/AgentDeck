import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ThinkingLevel } from '../../shared/types'
import { isJsonObject } from './cli-common'

export function zcodeDefaultPaths(): string[] {
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], 'D:\\Program Files', path.join(process.env.LOCALAPPDATA ?? '', 'Programs')].filter(Boolean) as string[]
  return roots.flatMap((root) => ['ZCode', 'zcode'].map((directory) => path.join(root, directory, 'resources', 'glm', 'zcode.cjs')))
}

export function resolveNodeRuntime(preferred?: string): { path: string; source: string } {
  if (preferred && fs.existsSync(preferred)) return { path: preferred, source: 'settings' }
  const isWindows = process.platform === 'win32'
  const executable = isWindows ? 'node.exe' : 'node'
  for (const directory of (process.env.PATH ?? '').split(isWindows ? ';' : ':')) {
    if (!directory) continue
    const fullPath = path.join(directory, executable)
    try { if (fs.existsSync(fullPath)) return { path: fullPath, source: 'PATH' } } catch {}
  }
  return { path: process.execPath, source: 'fallback-electron' }
}

export function findZcodeBundle(custom?: string): string | null {
  for (const candidate of custom ? [custom, ...zcodeDefaultPaths()] : zcodeDefaultPaths()) {
    try { if (fs.existsSync(candidate)) return candidate } catch {}
  }
  return null
}

export function ensureZcodeCliConfig(): { ok: boolean; detail: string } {
  const cliConfigPath = path.join(os.homedir(), '.zcode', 'cli', 'config.json')
  try {
    const current = JSON.parse(fs.readFileSync(cliConfigPath, 'utf8')) as unknown
    if (isJsonObject(current) && isJsonObject(current.model) && current.model.main) return { ok: true, detail: 'cli config 已存在' }
  } catch {}
  try {
    const v2Path = path.join(os.homedir(), '.zcode', 'v2', 'config.json')
    if (!fs.existsSync(v2Path)) return { ok: false, detail: '未找到 ~/.zcode/v2/config.json，请先在 ZCode 里登录' }
    const root = JSON.parse(fs.readFileSync(v2Path, 'utf8')) as unknown
    const providers = isJsonObject(root) && isJsonObject(root.provider) ? root.provider : {}
    const ids = Object.keys(providers).sort((a, b) => a === 'builtin:zai' ? -1 : b === 'builtin:zai' ? 1 : 0)
    for (const id of ids) {
      const provider = providers[id]
      if (!isJsonObject(provider)) continue
      const options = isJsonObject(provider.options) ? provider.options : {}
      const apiKey = typeof options.apiKey === 'string' ? options.apiKey : ''
      const baseURL = typeof options.baseURL === 'string' ? options.baseURL : typeof provider.baseURL === 'string' ? provider.baseURL : ''
      if (provider.enabled !== true || !apiKey || !baseURL) continue
      const providerId = id.replace(/^builtin:/, '')
      const modelTable = isJsonObject(provider.models) ? provider.models : {}
      const models = Object.fromEntries(Object.keys(modelTable).map((model) => [model.toLowerCase(), { name: model }]))
      const preferred = Object.keys(models).find((model) => model === 'glm-5.3') ?? Object.keys(models)[0] ?? 'glm-5.3'
      const config = {
        provider: { [providerId]: { kind: typeof provider.kind === 'string' ? provider.kind : 'anthropic', name: typeof provider.name === 'string' ? provider.name : providerId, options: { apiKeyRequired: true, baseURL, apiKey }, models } },
        model: { main: `${providerId}/${preferred}`, lite: `${providerId}/glm-4.7` }
      }
      fs.mkdirSync(path.dirname(cliConfigPath), { recursive: true })
      fs.writeFileSync(cliConfigPath, JSON.stringify(config, null, 2))
      return { ok: true, detail: `已从 ZCode 登录态生成配置（${providerId}/${preferred}）` }
    }
    return { ok: false, detail: 'ZCode 登录态中没有可用的 API key' }
  } catch (error) {
    return { ok: false, detail: `读取 ZCode 配置失败: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * 解析模型引用为协议 model 字段（{providerId, modelId, options?} 引用）。
 * 新协议（CLI 3.12.3+）只收注册表引用：providerId 必须是 ~/.zcode/v2/provider_config.json
 * providerRules 里的 id（如 bigmodel-api），模型 id 大小写敏感（目录里是 GLM-5.3），
 * reasoning 模型必须带 options.reasoningLevel（取桌面端目录里的 defaultVariant；
 * thinking 档位提供时按目录 variants 就近选档，非 reasoning 模型忽略）。
 * 连接（API 预设）替代旧 runtimeModel 内联凭据：作为个人 provider 规则 upsert 进
 * v2 provider_config.json（id 由 baseURL 派生，不同预设互不冲突），app-server 由
 * agentdeck 每回合重新拉起、启动前写入即生效。
 */
export function buildModelSelectionFromCliConfig(
  modelRef?: string,
  connection?: { name: string; baseURL: string; apiKey: string; protocol?: 'anthropic' | 'openai' },
  thinking?: ThinkingLevel
): { providerId: string; modelId: string; options?: { reasoningLevel: string } } | null {
  const ref = modelRef?.trim()
  if (connection && ref) {
    const slash = ref.indexOf('/')
    const requested = slash > 0 && slash < ref.length - 1 ? ref.slice(slash + 1) : ref
    const catalog = readV2ModelCatalog()
    const entry = catalog?.models.find((m) => m.modelId === requested) ?? catalog?.models.find((m) => m.modelId.toLowerCase() === requested.toLowerCase())
    // 注册与引用必须同 id：优先目录归一后的，目录外按原引用
    const modelId = entry?.modelId ?? requested
    // 注册表里该模型的 optionSpecs 由本函数显式声明（档位见 presetReasoningSpec），
    // 引用必须带同款 level，否则选择校验报 "Reasoning level is required"
    const reasoning = presetReasoningSpec(connection, thinking)
    if (!upsertPresetProvider(connection, modelId, reasoning)) {
      throw new Error(`预设连接「${connection.name}」注册失败：无法写入 ~/.zcode/v2/provider_config.json（ZCode 桌面端可能正占用该文件，稍后重试）`)
    }
    return { providerId: presetProviderId(connection), modelId, options: { reasoningLevel: reasoning.level } }
  }
  const catalog = readV2ModelCatalog()
  if (!catalog) return null
  const slash = ref ? ref.indexOf('/') : -1
  if (slash > 0 && ref) {
    // 显式 provider 前缀：必须在注册表里（不在则 null，保持"provider 不存在"语义）
    const prefix = ref.slice(0, slash)
    if (!catalog.providerIds.includes(prefix)) return null
    const bare = ref.slice(slash + 1)
    const entry = bare ? (catalog.models.find((m) => m.modelId === bare) ?? catalog.models.find((m) => m.modelId.toLowerCase() === bare.toLowerCase())) : undefined
    return entry ? withReasoning(prefix, entry, thinking) : { providerId: prefix, modelId: bare }
  }
  const providerId = catalog.providerIds[0]
  if (!providerId) return null
  if (ref) {
    const entry = catalog.models.find((m) => m.modelId === ref) ?? catalog.models.find((m) => m.modelId.toLowerCase() === ref.toLowerCase())
    return entry ? withReasoning(providerId, entry, thinking) : { providerId, modelId: ref }
  }
  const first = catalog.models[0]
  return first ? withReasoning(providerId, first, thinking) : null
}

/** 档位 → 目录 variants 的就近选档链：精确命中优先，缺档按链取第一个存在者，全不在回落 defaultVariant */
const THINKING_VARIANT_CHAINS: Record<ThinkingLevel, string[]> = {
  off: ['disabled'],
  low: ['low', 'enabled'],
  medium: ['medium', 'high'],
  high: ['high', 'enabled'],
  max: ['max', 'high', 'enabled']
}

function pickThinkingVariant(thinking: ThinkingLevel, reasoning: { defaultVariant?: string; variants?: string[] }): string {
  const chain = THINKING_VARIANT_CHAINS[thinking]
  const hit = chain.find((variant) => reasoning.variants?.includes(variant))
  return hit ?? reasoning.defaultVariant ?? reasoning.variants?.[0] ?? 'high'
}

/**
 * 预设线的 reasoningLevel 声明与引用档位。未设保持 'high'（历史行为，回归兼容）；
 * off 用 'disabled' 且不发任何 thinking 参数；low/medium/high/max 声明单值档、
 * 不写 map——与 builtin 目录一致，交给 zcode 内置默认映射翻译成 thinking /
 * reasoning_effort 参数（anthropic 协议无 medium 档，上调 'high'）。
 */
function presetReasoningSpec(connection: { baseURL: string; protocol?: 'anthropic' | 'openai' }, thinking?: ThinkingLevel): { level: string; silent: boolean } {
  if (!thinking) return { level: 'high', silent: true }
  if (thinking === 'off') return { level: 'disabled', silent: true }
  if (thinking === 'medium' && resolvePresetProtocol(connection) === 'anthropic-messages') return { level: 'high', silent: false }
  return { level: thinking, silent: false }
}

/** 预设注册到 v2 注册表的 providerId：baseURL 派生（fnv1a-32），同预设幂等、异预设不冲突 */
function presetProviderId(connection: { baseURL: string }): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < connection.baseURL.length; i++) {
    hash ^= connection.baseURL.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `agentdeck-${hash.toString(16).padStart(8, '0')}`
}

/** 预设线协议：显式声明优先；缺省按 baseURL 推断——/v1 结尾或 openrouter.ai 是 OpenAI 兼容惯例，其余 anthropic（历史行为） */
function resolvePresetProtocol(connection: { baseURL: string; protocol?: 'anthropic' | 'openai' }): 'anthropic-messages' | 'openai-chat-completions' {
  const explicit = connection.protocol
  const openai = explicit ? explicit === 'openai' : /openrouter\.ai/i.test(connection.baseURL) || /\/v1\/?$/.test(connection.baseURL.replace(/\/+$/, ''))
  return openai ? 'openai-chat-completions' : 'anthropic-messages'
}

/**
 * 把预设连接 upsert 成 v2 注册表的个人 provider：providerRule 声明凭据/端点/模型目录
 * （group 必填 standard-personal，缺了整条规则被静默过滤），providerModelRule 用
 * 完整模型定义（注册表完整性校验必查 properties/optionSpecs；只写 enabled 会被内置
 * 通用规则补成"reasoning 必选"，外部模型没法定义 level 就卡死）。optionSpecs 按
 * presetReasoningSpec 声明 reasoningLevel（silent 档写 map '{}' 即不发 thinking 参数），
 * 引用端始终带同款 level。api.type 按预设协议（openai 网关注册 anthropic-messages
 * 会 404：OpenRouter 等没有 /messages 路由）。只动自己 id 的条目，桌面端规则不受影响。
 */
function upsertPresetProvider(
  connection: { name: string; baseURL: string; apiKey: string; protocol?: 'anthropic' | 'openai' },
  modelId: string,
  reasoning: { level: string; silent: boolean }
): boolean {
  const id = presetProviderId(connection)
  try {
    const configPath = path.join(os.homedir(), '.zcode', 'v2', 'provider_config.json')
    let root: unknown
    try { root = JSON.parse(fs.readFileSync(configPath, 'utf8')) as unknown } catch {
      root = { schemaVersion: 1, config: { providerConfigRules: { providerRules: [] }, modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] } } }
    }
    if (!isJsonObject(root)) return false
    const config = isJsonObject(root.config) ? root.config : (root.config = {})
    if (!isJsonObject(config.providerConfigRules)) config.providerConfigRules = { providerRules: [] }
    if (!isJsonObject(config.modelConfigRules)) config.modelConfigRules = { providerModelRules: [], manualProviderModelRules: [] }
    const providerRules = config.providerConfigRules
    const rules = Array.isArray(providerRules.providerRules) ? providerRules.providerRules.filter((rule) => !(isJsonObject(rule) && rule.providerId === id)) : []
    rules.push({
      providerId: id,
      providerName: connection.name,
      enabled: true,
      config: {
        group: 'standard-personal',
        access: { type: 'api-key', apiKey: connection.apiKey },
        api: { type: resolvePresetProtocol(connection), baseUrl: connection.baseURL },
        personalModelIds: [modelId]
      }
    })
    providerRules.providerRules = rules
    const modelRules = config.modelConfigRules
    const list = Array.isArray(modelRules.providerModelRules) ? modelRules.providerModelRules.filter((rule) => !(isJsonObject(rule) && rule.providerId === id && rule.modelId === modelId)) : []
    list.push({
      providerId: id,
      modelId,
      config: {
        enabled: true,
        properties: {
          requiresMfjsToolSchema: false,
          contextWindow: 200000,
          inputFormat: { supportsText: true, supportsImage: false, supportsVideo: false, supportsAudio: false, supportsPdf: false },
          outputFormat: { supportsText: true },
          supportsToolCall: true,
          supportsJsonSchemaOutput: false,
          supportsNativeWebSearch: false,
          supportsMidConversationSystem: false
        },
        optionSpecs: {
          // silent 档（未设/关）写空 map：不生成任何 thinking 请求参数；
          // 其余档不写 map，由 zcode 内置默认映射发 thinking/reasoning_effort
          reasoningLevel: { values: [reasoning.level], ...(reasoning.silent ? { map: '{}' } : {}) },
          maxOutputTokens: { max: 32000, map: "{'max_tokens': maxOutputTokens}" }
        }
      }
    })
    modelRules.providerModelRules = list
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, JSON.stringify(root, null, 2))
    return true
  } catch { return false }
}

function withReasoning(providerId: string, entry: { modelId: string; reasoning?: { enabled?: boolean; defaultVariant?: string; variants?: string[] } }, thinking?: ThinkingLevel): { providerId: string; modelId: string; options?: { reasoningLevel: string } } {
  const reasoning = entry.reasoning
  // 非 reasoning 模型忽略思考档位；reasoning 模型按档位就近选 variant（未设保持 defaultVariant）
  const options = !reasoning?.enabled
    ? undefined
    : { reasoningLevel: thinking ? pickThinkingVariant(thinking, reasoning) : (reasoning.defaultVariant ?? reasoning.variants?.[0] ?? 'high') }
  return { providerId, modelId: entry.modelId, ...(options ? { options } : {}) }
}

/** 桌面端 v2 目录：provider id 来自 provider_config.json 的 providerRules，模型表来自 v2/config.json 各 provider 的 models */
function readV2ModelCatalog(): { providerIds: string[]; models: { modelId: string; reasoning?: { enabled?: boolean; defaultVariant?: string; variants?: string[] } }[] } | null {
  const v2Dir = path.join(os.homedir(), '.zcode', 'v2')
  try {
    const providerIds: string[] = []
    try {
      const rules = JSON.parse(fs.readFileSync(path.join(v2Dir, 'provider_config.json'), 'utf8')) as unknown
      if (isJsonObject(rules) && isJsonObject(rules.config) && isJsonObject(rules.config.providerConfigRules) && Array.isArray(rules.config.providerConfigRules.providerRules)) {
        for (const rule of rules.config.providerConfigRules.providerRules) {
          if (isJsonObject(rule) && typeof rule.providerId === 'string') providerIds.push(rule.providerId)
        }
      }
    } catch {}
    const models: { modelId: string; reasoning?: { enabled?: boolean; defaultVariant?: string; variants?: string[] } }[] = []
    const seen = new Set<string>()
    const v2Config = JSON.parse(fs.readFileSync(path.join(v2Dir, 'config.json'), 'utf8')) as unknown
    if (isJsonObject(v2Config) && isJsonObject(v2Config.provider)) {
      for (const provider of Object.values(v2Config.provider)) {
        if (!isJsonObject(provider) || !isJsonObject(provider.models)) continue
        for (const [modelId, meta] of Object.entries(provider.models)) {
          if (seen.has(modelId)) continue
          seen.add(modelId)
          const reasoning = isJsonObject(meta) && isJsonObject(meta.reasoning) ? meta.reasoning : undefined
          models.push({
            modelId,
            ...(reasoning ? { reasoning: { enabled: reasoning.enabled === true, ...(typeof reasoning.defaultVariant === 'string' ? { defaultVariant: reasoning.defaultVariant } : {}), ...(Array.isArray(reasoning.variants) ? { variants: reasoning.variants.filter((v): v is string => typeof v === 'string') } : {}) } } : {})
          })
        }
      }
    }
    if (!providerIds.length && !models.length) return null
    return { providerIds, models }
  } catch { return null }
}

export function listZcodeModels(): { models: string[]; defaultModel?: string } {
  // 优先桌面端 v2 目录（注册表真实可用的模型 id，大小写如 GLM-5.3）；
  // 读不到时退回旧 cli config（历史行为）
  try {
    const v2Config = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.zcode', 'v2', 'config.json'), 'utf8')) as unknown
    if (isJsonObject(v2Config) && isJsonObject(v2Config.provider)) {
      const models = [...new Set(Object.values(v2Config.provider).flatMap((provider) => isJsonObject(provider) && isJsonObject(provider.models) ? Object.keys(provider.models) : []))]
      if (models.length) return { models }
    }
  } catch {}
  try {
    const root = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.zcode', 'cli', 'config.json'), 'utf8')) as unknown
    if (!isJsonObject(root)) return { models: [] }
    const providers = isJsonObject(root.provider) ? root.provider : {}
    const models = [...new Set(Object.values(providers).flatMap((provider) => isJsonObject(provider) && isJsonObject(provider.models) ? Object.keys(provider.models) : []))]
    const defaultModel = isJsonObject(root.model) ? String(root.model.main ?? '').split('/').pop() : undefined
    return { models, ...(defaultModel ? { defaultModel } : {}) }
  } catch { return { models: [] } }
}

/**
 * 补齐 CLI 内置 Provider 配置（zcode-builtin.json）。
 * app-server 以文件入口运行时只在 <bundle 目录>/provider/ 与其上溯 5 级的
 * config/provider/ 两处找该文件；新版 ZCode 桌面端把它挪到了 resources/config/provider/
 * （resources/glm/ 里的旧位置随更新被清掉），导致 app-server 拉起即退出
 * （code 1，"无法定位 CLI ZCode Built-in Provider Config"）。
 * 启动前检测：两处都不在时，从桌面端新版布局或 v2 运行时缓存复制补齐。
 */
export function ensureZcodeCliProviderConfig(bundle: string): { ok: boolean; detail: string } {
  const bundleDir = path.dirname(path.resolve(bundle))
  const target = path.join(bundleDir, 'provider', 'zcode-builtin.json')
  const driveRootFallback = path.resolve(bundleDir, '..', '..', '..', '..', '..', 'config', 'provider', 'zcode-builtin.json')
  try {
    if (fs.existsSync(target) || fs.existsSync(driveRootFallback)) return { ok: true, detail: 'provider config 就绪' }
  } catch {}
  const sources = [path.join(bundleDir, '..', 'config', 'provider', 'zcode-builtin.json'), ...runtimeProviderConfigSources()]
  for (const source of sources) {
    try {
      if (!fs.existsSync(source)) continue
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(source, target)
      return { ok: true, detail: `已补齐 provider config（复制自 ${source}）` }
    } catch {}
  }
  return { ok: false, detail: '无法定位 zcode-builtin.json，请检查 ZCode 桌面端是否完整安装' }
}

/** 新版桌面端为 CLI 下载的 provider 运行时缓存：~/.zcode/v2/runtime/provider/<平台>/<版本>/endpoint 目录下的 zcode-builtin.json，取最新 */
function runtimeProviderConfigSources(): string[] {
  const runtimeRoot = path.join(os.homedir(), '.zcode', 'v2', 'runtime', 'provider')
  try {
    const found: { file: string; mtime: number }[] = []
    for (const platform of fs.readdirSync(runtimeRoot)) {
      const platformDir = path.join(runtimeRoot, platform)
      for (const version of fs.readdirSync(platformDir)) {
        for (const endpoint of fs.readdirSync(path.join(platformDir, version))) {
          const file = path.join(platformDir, version, endpoint, 'zcode-builtin.json')
          try { found.push({ file, mtime: fs.statSync(file).mtimeMs }) } catch {}
        }
      }
    }
    return found.sort((a, b) => b.mtime - a.mtime).map((entry) => entry.file)
  } catch { return [] }
}
