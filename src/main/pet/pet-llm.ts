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
  /** 候选端点按序尝试（照 fetchPresetModels 惯例）：网关直挂路径优先，/v1 形态兜底 */
  urls: string[]
  headers: Record<string, string>
  body: string
}

/** 协议推断：显式 protocol 优先；否则 anthropic 是例外而非常态——仅 anthropic/claude 网关或 /v1/messages 端点走原生协议，其余（/v1、/v4、openrouter、各 OpenAI 兼容网关）一律 openai */
export function inferPresetProtocol(preset: Pick<ApiPreset, 'protocol' | 'baseURL'>): 'openai' | 'anthropic' {
  if (preset.protocol === 'openai' || preset.protocol === 'anthropic') return preset.protocol
  const base = preset.baseURL.replace(/\/+$/, '').toLowerCase()
  return /anthropic|claude/.test(base) || base.endsWith('/v1/messages') ? 'anthropic' : 'openai'
}

/** 请求构造纯函数：smoke 直连断言形状，不发真网络 */
export function buildChatRequest(preset: ApiPreset, messages: PetChatMessage[], model?: string): PetChatRequestDraft {
  const protocol = inferPresetProtocol(preset)
  const trimmed = preset.baseURL.replace(/\/+$/, '')
  // 双鉴权头照 fetchPresetModels 惯例：网关对多余头不敏感，省一次协议猜错
  const authHeaders = {
    authorization: `Bearer ${preset.apiKey}`,
    'x-api-key': preset.apiKey
  }
  if (protocol === 'openai') {
    // baseURL 可能带完整端点（…/chat/completions）、带版本段（…/v1、…/v4）或裸主机；两种候选覆盖主流网关
    const base = trimmed.endsWith('/chat/completions')
      ? trimmed.slice(0, -'/chat/completions'.length)
      : trimmed.replace(/\/v1$/, '')
    const urls = trimmed.endsWith('/chat/completions')
      ? [trimmed]
      : [`${base}/chat/completions`, `${base}/v1/chat/completions`]
    return {
      protocol,
      urls,
      headers: { 'content-type': 'application/json', ...authHeaders },
      body: JSON.stringify({ ...(model ? { model } : {}), messages })
    }
  }
  const system = messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n')
  const rest = messages
    .filter((message) => message.role !== 'system')
    .map((message) => ({ role: message.role, content: message.content }))
  return {
    protocol,
    urls: [`${trimmed.replace(/\/v1\/messages$/, '')}/v1/messages`],
    headers: { 'content-type': 'application/json', ...authHeaders, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ ...(model ? { model } : {}), max_tokens: 200, ...(system ? { system } : {}), messages: rest })
  }
}

/** 单轮对话：候选端点按序尝试；非 2xx / 超时 / 无文本都抛错（错误信息不含 key） */
export async function chatCompletion(preset: ApiPreset, messages: PetChatMessage[], opts: { timeoutMs?: number; model?: string } = {}): Promise<string> {
  const draft = buildChatRequest(preset, messages, opts.model)
  const errors: string[] = []
  for (const url of draft.urls) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: draft.headers,
        body: draft.body,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 12_000)
      })
      if (!res.ok) {
        errors.push(`HTTP ${res.status} @ ${url.replace(/^https?:\/\//, '')}`)
        continue
      }
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
      errors.push('响应没有文本内容')
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err))
    }
  }
  throw new Error(`模型请求失败：${errors.join('；')}`)
}
