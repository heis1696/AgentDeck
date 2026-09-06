// 轻量 Markdown 渲染（结果/最终回复用）
// 领队回复里的 <delegate to="队员" reason="理由">子任务指令</delegate> 标记会渲染成委派卡片
import type { ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

// 委派标记切分（属性顺序不定，reason 可省略；出现在代码块内也统一卡片化，简单处理）
const DELEGATE_RE = /<delegate\b([^>]*)>([\s\S]*?)<\/delegate>/g
const DELEGATE_TO_RE = /\bto\s*=\s*"([^"]*)"/
const DELEGATE_REASON_RE = /\breason\s*=\s*"([^"]*)"/
const EXCERPT_MAX = 60

// 指令首行摘要：压缩空白后截约 60 字，超长补省略号
function excerptOf(prompt: string): string {
  const firstLine = (prompt.trim().split('\n')[0] ?? '').replace(/\s+/g, ' ').trim()
  return firstLine.length > EXCERPT_MAX ? `${firstLine.slice(0, EXCERPT_MAX)}…` : firstLine
}

// 委派卡片：头部展示目标队员与理由，指令体折叠展示（不跑 Markdown，保留换行）
export function DelegateCard({ to, reason, prompt }: { to: string; reason?: string; prompt: string }) {
  const body = prompt.trim()
  const excerpt = excerptOf(body)
  return (
    <div className="delegate-card">
      <div className="delegate-card-head">
        <span className="delegate-card-icon">⚡</span>
        <span className="delegate-card-tag">委派</span>
        <span className="delegate-card-to">{to}</span>
        <span className="delegate-card-arrow">→</span>
        {reason ? <span className="delegate-card-reason">· {reason}</span> : null}
      </div>
      <details className="delegate-card-body">
        <summary>
          <span className="delegate-card-summary-label">子任务指令</span>
          {excerpt ? <span className="delegate-card-excerpt">{excerpt}</span> : null}
        </summary>
        <pre>{body}</pre>
      </details>
    </div>
  )
}

// 属性解析失败（缺 to）时的降级卡片：不崩、不露原始标签，指令整段按纯文本展示
function DelegateFallbackCard({ prompt }: { prompt: string }) {
  const body = prompt.trim()
  const excerpt = excerptOf(body)
  return (
    <div className="delegate-card">
      <div className="delegate-card-head">
        <span className="delegate-card-icon">⚡</span>
        <span className="delegate-card-tag">委派</span>
        <span className="delegate-card-reason">未指明成员</span>
      </div>
      <details className="delegate-card-body">
        <summary>
          <span className="delegate-card-summary-label">子任务指令</span>
          {excerpt ? <span className="delegate-card-excerpt">{excerpt}</span> : null}
        </summary>
        <pre>{body || '（无内容）'}</pre>
      </details>
    </div>
  )
}

// 按 DELEGATE_RE 切成 [普通片段, attrs, 指令, ...] 交替序列，逐段渲染
function renderSegments(text: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const segments = text.split(DELEGATE_RE)
  for (let i = 0; i < segments.length; i += 3) {
    const mdText = segments[i] ?? ''
    if (mdText) {
      nodes.push(
        <ReactMarkdown
          key={nodes.length}
          remarkPlugins={[remarkGfm]}
          components={{
            pre: ({ children }) => (
              <pre>
                <code>{children}</code>
              </pre>
            ),
            a: ({ href, children }) => (
              <a href={href} target="_blank" rel="noreferrer">
                {children}
              </a>
            )
          }}
        >
          {mdText}
        </ReactMarkdown>
      )
    }
    const attrs = segments[i + 1]
    if (attrs !== undefined) {
      const prompt = segments[i + 2] ?? ''
      const to = attrs.match(DELEGATE_TO_RE)?.[1] ?? ''
      const reason = attrs.match(DELEGATE_REASON_RE)?.[1]
      nodes.push(
        to ? (
          <DelegateCard key={nodes.length} to={to} reason={reason} prompt={prompt} />
        ) : (
          <DelegateFallbackCard key={nodes.length} prompt={prompt} />
        )
      )
    }
  }
  return nodes
}

export function Markdown({ text }: { text: string }) {
  return <div className="md">{renderSegments(text)}</div>
}
