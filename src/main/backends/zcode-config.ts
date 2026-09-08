import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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

export function buildRuntimeModelFromCliConfig(modelRef?: string, connection?: { name: string; baseURL: string; apiKey: string }): Record<string, unknown> | null {
  try {
    const ref = modelRef?.trim()
    if (connection && ref) {
      const slash = ref.indexOf('/')
      const modelId = slash > 0 && slash < ref.length - 1 ? ref.slice(slash + 1) : ref
      return { revision: '0', generatedAt: Date.now(), model: { providerId: 'preset', modelId }, provider: { providerId: 'preset', kind: 'anthropic', label: connection.name, baseURL: connection.baseURL, apiKey: { source: 'inline', value: connection.apiKey }, apiKeyRequired: true, models: [{ modelId }] } }
    }
    const root = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.zcode', 'cli', 'config.json'), 'utf8')) as unknown
    if (!isJsonObject(root) || !isJsonObject(root.model) || !isJsonObject(root.provider)) return null
    const [defaultProvider, defaultModel] = String(root.model.main ?? '').split('/')
    const slash = ref?.indexOf('/') ?? -1
    const providerId = slash > 0 && ref ? ref.slice(0, slash) : defaultProvider
    const modelId = slash > 0 && ref ? ref.slice(slash + 1) : ref || defaultModel
    const providerConfig = root.provider[providerId]
    if (!modelId || !isJsonObject(providerConfig)) return null
    const providerModels = isJsonObject(providerConfig.models) ? providerConfig.models : {}
    const models = Object.entries(providerModels).map(([id, value]) => ({ modelId: id, ...(isJsonObject(value) && typeof value.name === 'string' ? { label: value.name } : {}) }))
    if (!models.some((model) => model.modelId === modelId)) models.push({ modelId })
    const options = isJsonObject(providerConfig.options) ? providerConfig.options : {}
    return {
      revision: '0', generatedAt: Date.now(), model: { providerId, modelId },
      provider: { providerId, kind: providerConfig.kind ?? 'anthropic', ...(providerConfig.name ? { label: providerConfig.name } : {}), ...(options.baseURL ? { baseURL: options.baseURL } : {}), apiKey: { source: 'inline', value: options.apiKey }, apiKeyRequired: true, models }
    }
  } catch { return null }
}

export function listZcodeModels(): { models: string[]; defaultModel?: string } {
  try {
    const root = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.zcode', 'cli', 'config.json'), 'utf8')) as unknown
    if (!isJsonObject(root)) return { models: [] }
    const providers = isJsonObject(root.provider) ? root.provider : {}
    const models = [...new Set(Object.values(providers).flatMap((provider) => isJsonObject(provider) && isJsonObject(provider.models) ? Object.keys(provider.models) : []))]
    const defaultModel = isJsonObject(root.model) ? String(root.model.main ?? '').split('/').pop() : undefined
    return { models, ...(defaultModel ? { defaultModel } : {}) }
  } catch { return { models: [] } }
}
