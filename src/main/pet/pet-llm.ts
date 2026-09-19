// 桌宠 LLM 接线：零依赖 fetch，双协议（openai chat/completions + anthropic messages）。
// 照 fetchPresetModels 惯例：AbortSignal.timeout 超时、baseURL 归一化。
// apiKey 只在请求头里出现，任何日志/错误信息不得携带（错误只报 HTTP 状态）。
import type { ApiPreset } from '../presets'

export interface PetChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface PetChatRequestDraft {
  protocol: 'openai' | 'anthropic'
  url: string
  headers: Record<string, string>
  body: string
}

/** 协议推断：显式 protocol 优先，否则照 presets.ts 惯例按 baseURL 推（/v1 或 openrouter → openai） */
export function inferPresetProtocol(preset: Pick<ApiPreset, 'protocol' | 'baseURL'>): 'openai' | 'anthropic' {
  if (preset.protocol === 'openai' || preset.protocol === 'anthropic') return preset.protocol
  const base = preset.baseURL.replace(/\/+$/, '')
  return /openrouter\.ai|\/v1$/.test(base) ? 'openai' : 'anthropic'
}

/** 请求构造纯函数：smoke 直连断言形状，不发真网络 */
export function buildChatRequest(preset: ApiPreset, messages: PetChatMessage[], model?: string): PetChatRequestDraft {
  const protocol = inferPresetProtocol(preset)
  const base = preset.baseURL.replace(/\/+$/, '').replace(/\/v1$/, '')
  if (protocol === 'openai') {
    return {
      protocol,
      url: `${base}/v1/chat/completions`,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${preset.apiKey}`
      },
      body: JSON.stringify({ ...(model ? { model } : {}), messages })
    }
  }
  const system = messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n')
  const rest = messages
    .filter((message) => message.role !== 'system')
    .map((message) => ({ role: message.role, content: message.content }))
  return {
    protocol,
    url: `${base}/v1/messages`,
    headers: {
      'content-type': 'application/json',
      'x-api-key': preset.apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({ ...(model ? { model } : {}), max_tokens: 200, ...(system ? { system } : {}), messages: rest })
  }
}

/** 单轮对话：返回首个文本块；非 2xx / 超时 / 无文本都抛错（错误信息不含 key） */
export async function chatCompletion(preset: ApiPreset, messages: PetChatMessage[], opts: { timeoutMs?: number; model?: string } = {}): Promise<string> {
  const draft = buildChatRequest(preset, messages, opts.model)
  const res = await fetch(draft.url, {
    method: 'POST',
    headers: draft.headers,
    body: draft.body,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 12_000)
  })
  if (!res.ok) throw new Error(`模型请求失败：HTTP ${res.status}`)
  const json: unknown = await res.json()
  if (draft.protocol === 'openai') {
    const content = (json as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content
    if (typeof content === 'string' && content.trim()) return content
  } else {
    const parts = (json as { content?: Array<{ type?: unknown; text?: unknown }> })?.content
    const text = Array.isArray(parts)
      ? parts.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text as string).join('')
      : ''
    if (text.trim()) return text
  }
  throw new Error('模型响应没有文本内容')
}
