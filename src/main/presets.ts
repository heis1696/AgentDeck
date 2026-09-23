// API 预设（连接档案）：全局连接档案（baseURL/apiKey/线协议/备注），零全局切换——
// 预设只在 agent 引用它的会话里注入（zcode upsert 进 v2 注册表按 id 引用，claude 走 spawn env）。
// 预设不归属平台：backend（agent 的执行后端）按 id 引用预设；模型在 agent 表单里从预设在线拉取后单独钉选。
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

export interface ApiPreset {
  id: string
  name: string
  baseURL: string
  apiKey: string
  /** 线协议：openai（OpenAI 兼容 /chat/completions，OpenRouter/OneAPI/DeepSeek 等）| anthropic（/messages）。
   *  缺省自动推断：baseURL 以 /v1 结尾或含 openrouter.ai → openai，否则 anthropic（历史行为）。 */
  protocol?: 'anthropic' | 'openai'
  note?: string
  createdAt: number
}

export function normalizePreset(value: unknown, fallback?: ApiPreset): ApiPreset | null {
  if (!value || typeof value !== 'object') return fallback ?? null
  const raw = value as Partial<ApiPreset>
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : fallback?.id
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  const baseURL = typeof raw.baseURL === 'string' ? raw.baseURL.trim().replace(/\/+$/, '') : ''
  const apiKey = typeof raw.apiKey === 'string' ? raw.apiKey.trim() : ''
  if (!id || !name || !baseURL || !apiKey) return fallback ?? null
  // 只重建白名单字段：旧数据里的遗留字段（如已废弃的 backend）在载入/保存时自然剔除，其余字段不得丢
  return {
    id,
    name,
    baseURL,
    apiKey,
    ...(raw.protocol === 'openai' || raw.protocol === 'anthropic' ? { protocol: raw.protocol } : {}),
    ...(typeof raw.note === 'string' && raw.note.trim() ? { note: raw.note.trim() } : {}),
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now()
  }
}

export function normalizePresets(values: unknown): ApiPreset[] {
  if (!Array.isArray(values)) return []
  const out: ApiPreset[] = []
  const ids = new Set<string>()
  for (const value of values) {
    const preset = normalizePreset(value)
    if (!preset || ids.has(preset.id)) continue
    ids.add(preset.id)
    out.push(preset)
  }
  return out
}

const file = () => path.join(app.getPath('userData'), 'api-presets.json')

export function loadPresets(): ApiPreset[] {
  try {
    const list = normalizePresets(JSON.parse(fs.readFileSync(file(), 'utf8')))
    if (list.length) return list
  } catch {}
  return []
}

export function savePresets(presets: ApiPreset[]): ApiPreset[] {
  presets = normalizePresets(presets)
  fs.mkdirSync(path.dirname(file()), { recursive: true })
  fs.writeFileSync(file(), JSON.stringify(presets, null, 2))
  return presets
}

export function newPresetId(): string {
  return `pst_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/**
 * 从预设在线拉取模型目录：先试 OpenAI 风格（GET {base}/v1/models，Bearer），
 * 再试 Anthropic 风格（GET {base}/models，x-api-key）。两类网关通常都容忍多余头，
 * 故每次请求同时带两种鉴权头，按响应体形状解析。
 */
export async function fetchPresetModels(preset: ApiPreset, timeoutMs = 12_000): Promise<string[]> {
  const base = preset.baseURL.replace(/\/+$/, '').replace(/\/v1$/, '')
  const headers: Record<string, string> = {
    Authorization: `Bearer ${preset.apiKey}`,
    'x-api-key': preset.apiKey,
    'anthropic-version': '2023-06-01'
  }
  let lastError = ''
  for (const url of [`${base}/v1/models`, `${base}/models`]) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
      if (!res.ok) {
        lastError = `HTTP ${res.status} @ ${url}`
        continue
      }
      const j: any = await res.json()
      const items: unknown[] = Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : []
      const models = [...new Set(items.map((m: any) => (typeof m === 'string' ? m : m?.id ?? m?.name ?? '')).filter((s): s is string => !!s))].sort()
      if (models.length) return models
      lastError = `响应无模型列表 @ ${url}`
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
    }
  }
  throw new Error(lastError || '拉取失败')
}
