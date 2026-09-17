// 队员定义 ↔ Markdown（Claude Code subagent 格式）互换：纯函数，文件对话框与读写由 IPC 层负责，便于 smoke。
// 格式：YAML frontmatter（name/description[/model]）+ 正文即 system prompt；
// agentdeck 专属字段（backend/预设/可驱使）不参与交换——导入草稿仍走生成确认视图，安全边界不变。
import { parseFrontmatter } from './skills'
import type { Agent } from './agents'
import type { AgentDraft, ImportResult } from '../shared/forge'

/** 派发协议标记：导入内容来自任意来源，进系统提示词前剥离（与 agent-forge 同款规则） */
const DISPATCH_TAG_RE = /<\/?(?:delegate|consult|continue|round|review)\b[^>]*>/gi

/** agentdeck Agent → subagent Markdown（description 由 role/note 拼合；无人设的锻造师不参与导出） */
export function serializeAgentMarkdown(agent: Agent): string {
  const description = [agent.role, agent.note]
    .filter((part) => Boolean(part?.trim()))
    .join(' · ')
    .replace(/\r?\n/g, ' ')
  const frontmatter = [
    '---',
    `name: ${agent.name}`,
    ...(description ? [`description: ${description}`] : []),
    ...(agent.model ? [`model: ${agent.model}`] : []),
    '---'
  ].join('\n')
  return `${frontmatter}\n\n${agent.systemPrompt ?? ''}\n`
}

/** subagent Markdown → 草稿（name 必填、正文必非空；description→note，正文→systemPrompt；未知 frontmatter 键忽略） */
export function parseAgentMarkdown(raw: string): ImportResult {
  const { data, body } = parseFrontmatter(raw)
  const name = (data.name ?? '').trim().slice(0, 32)
  const systemPrompt = body.replace(DISPATCH_TAG_RE, '').trim().slice(0, 4000)
  if (!name) return { ok: false, error: 'frontmatter 缺少 name（不是合法的 subagent 文件）' }
  if (!systemPrompt) return { ok: false, error: '正文为空——subagent 正文应为人设 system prompt' }
  const note = (data.description ?? '').replace(DISPATCH_TAG_RE, '').trim().slice(0, 200)
  const model = (data.model ?? '').trim().slice(0, 64)
  const color = (data.color ?? '').trim()
  const draft: AgentDraft = {
    name,
    systemPrompt,
    color: /^#[0-9a-fA-F]{6}$/.test(color) ? color : '#4f8cff',
    ...(note ? { note } : {}),
    ...(model ? { model } : {})
  }
  return { ok: true, draft }
}
