// Issue 评论统一中继：全文层落评论的唯一出口 + 未送达统一降级。
// 背景：多处「Issue 评论未送达（Issue 不存在）→ 任务事件留痕」的降级逻辑曾经四散
// （重启续报/审核备注/停放通知 × 主进程 + sidecar），漏一处就是一次静默丢弃——
// 收口到一个函数，调用方只给评论文案与降级事件文案。
import type { TaskEvent } from '../shared/types'

/** Issue 评论通道的物理上限（UTF-8 字节）：超出必须在调用侧钳制并指引回报告副本 */
export const ISSUE_COMMENT_MAX_BYTES = 64 * 1024
/** 钳制时预留的截断指引字节预算（指引行随钳制结果追加，不能把总量再顶过上限） */
export const ISSUE_COMMENT_POINTER_RESERVE_BYTES = 512

export interface IssueCommentAuthor {
  type: 'agent' | 'user'
  id: string
}

export interface IssueRelayChannels {
  addComment(issueId: string, text: string, author?: IssueCommentAuthor): { id: string } | null
  appendEvent(taskId: string, event: Omit<TaskEvent, 'seq'>): TaskEvent | null
  pushEvent(taskId: string, event: TaskEvent): void
}

export interface RelayIssueCommentInput {
  issueId: string
  /** 降级事件的落点任务（评论送达失败时留痕的任务） */
  taskId: string
  comment: string
  /** 降级事件文案（「⚠ …未送达（Issue 不存在）…」） */
  fallbackEventText: string
  author?: IssueCommentAuthor
}

/**
 * 评论送达 = true；未送达（addComment 返回 null，即 Issue 不存在）= 一条龙降级：
 * console.warn + 任务事件落盘 + pushEvent 推送。绝不静默丢。
 */
export function relayIssueCommentOrEvent(channels: IssueRelayChannels, input: RelayIssueCommentInput): boolean {
  const delivered = channels.addComment(input.issueId, input.comment, input.author)
  if (delivered) return true
  console.warn(`[issue-relay] 评论未送达（Issue 不存在）：issue=${input.issueId} task=${input.taskId}，降级为任务时间线事件`)
  const event = channels.appendEvent(input.taskId, { ts: Date.now(), kind: 'status', text: input.fallbackEventText })
  if (event) channels.pushEvent(input.taskId, event)
  return false
}

/** 把评论钳制进通道上限：码点级截断（不孤立代理项），并预留截断指引行的字节预算。
 *  未超限原样返回；超限返回截断后文本 + truncated 标记（调用方负责追加指引回副本）。 */
export function clampIssueCommentBytes(text: string, maxBytes = ISSUE_COMMENT_MAX_BYTES): { text: string; truncated: boolean } {
  const budget = maxBytes - ISSUE_COMMENT_POINTER_RESERVE_BYTES
  if (budget <= 0 || Buffer.byteLength(text, 'utf8') <= budget) return { text, truncated: false }
  let cut = text.length
  while (cut > 1 && Buffer.byteLength(text.slice(0, cut), 'utf8') > budget) cut = Math.max(1, Math.floor(cut * 0.9))
  // 尾字符是代理对的高位半 → 回退一位，保住完整码点
  const prev = text.charCodeAt(cut - 1)
  if (prev >= 0xd800 && prev <= 0xdbff) cut -= 1
  return { text: text.slice(0, cut), truncated: true }
}
