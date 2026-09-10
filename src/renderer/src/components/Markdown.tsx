// 轻量 Markdown 渲染（结果/最终回复用）
// 领队回复里的四族协议标记统一卡片化（与 delegate.ts 解析同规则）：
//   <delegate to reason>派单</delegate>、<continue start>硬切简报</continue>、
//   <round outcome reason/>自评、<review of verdict note/>审核
// 围栏代码块走内置高亮器（零依赖）+ 语言标签 + 一键复制卡片
import { isValidElement, useMemo, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

// 委派标记切分（属性顺序不定，reason 可省略；出现在代码块内也统一卡片化，简单处理）。
// 开标签必须带 to 才构成匹配（与 delegate.ts 解析同规则）：无 to 的裸标记字样不当卡片，
// 否则非贪婪体会延伸到后方真实派单的闭合标签，把正文一并吞进卡片（幻影配对）。
const DELEGATE_RE = /<delegate\b(?=[^>]*\bto\s*=)([^>]*)>([\s\S]*?)<\/delegate>/g
const DELEGATE_TO_RE = /\bto\s*=\s*"([^"]*)"/
const DELEGATE_REASON_RE = /\breason\s*=\s*"([^"]*)"/
// 其余三族：continue（成对）与 round/review（自闭合），在普通片段里二次扫描
const SIDE_TAG_RE = /<continue\b[^>]*>([\s\S]*?)<\/continue>|<(?:round|review)\b[^>]*?\/>/g
const CONTINUE_START_RE = /\bstart\s*=\s*"([^"]*)"/
const ROUND_OUTCOME_RE = /\boutcome\s*=\s*"([^"]*)"/
const ROUND_REASON_RE = /\breason\s*=\s*"([^"]*)"/
const REVIEW_OF_RE = /\bof\s*=\s*"([^"]*)"/
const REVIEW_VERDICT_RE = /\bverdict\s*=\s*"([^"]*)"/
const REVIEW_NOTE_RE = /\bnote\s*=\s*"([^"]*)"/
const EXCERPT_MAX = 60

// 属性抓取（对整个开标签文本跑一次，取首引号值）
function tagAttr(source: string, re: RegExp): string | undefined {
  return re.exec(source)?.[1]
}

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

// 硬切接力卡片：领队输出 <continue start> 时，本回合在此硬切新会话，简报是唯一携带物。
// 紫色系对齐看板上已有的「阶段接力」徽章（.badge-handoff）。
function ContinueCard({ start, brief }: { start?: string; brief: string }) {
  const body = brief.trim()
  const excerpt = excerptOf(body)
  return (
    <div className="continue-card">
      <div className="continue-card-head">
        <span className="continue-card-icon">⏭</span>
        <span className="continue-card-tag">硬切</span>
        <span className="continue-card-title">阶段接力</span>
        <span className="continue-card-mode">{start === 'parked' ? '待启动' : '自动开始'}</span>
      </div>
      <details className="continue-card-body">
        <summary>
          <span className="continue-card-summary-label">交接简报</span>
          {excerpt ? <span className="continue-card-excerpt">{excerpt}</span> : null}
        </summary>
        <pre>{body || '（无内容）'}</pre>
      </details>
    </div>
  )
}

// 回合自评：领队每轮回灌后输出的 <round outcome reason/>
const ROUND_LABEL: Record<string, string> = { action: '已行动', no_action: '无动作', failed: '受挫' }
function RoundChip({ outcome, reason, inline }: { outcome?: string; reason?: string; inline?: boolean }) {
  const known = outcome ? ROUND_LABEL[outcome] : undefined
  return (
    <div className={`round-chip${inline ? ' inline' : ''}${outcome ? ` rc-${outcome}` : ''}`}>
      <span className="round-chip-dot" aria-hidden="true" />
      <span className="round-chip-tag">自评</span>
      <b className="round-chip-outcome">{known ?? outcome ?? '—'}</b>
      {reason ? <span className="round-chip-reason">· {reason}</span> : null}
    </div>
  )
}

// 委派单审核结论：领队对 done 子任务输出的 <review of verdict note/>
function ReviewChip({ of, verdict, note, inline }: { of?: string; verdict?: string; note?: string; inline?: boolean }) {
  const pass = verdict === 'pass'
  const label = pass ? '通过' : verdict === 'fail' ? '退回' : verdict || '—'
  return (
    <div className={`review-chip${inline ? ' inline' : ''} ${pass ? 'rv-pass' : 'rv-fail'}`}>
      <span className="review-chip-icon" aria-hidden="true">{pass ? '✓' : '↩'}</span>
      <span className="review-chip-tag">审核</span>
      <b className="review-chip-of">{of || '—'}</b>
      <span className="review-chip-verdict">{label}</span>
      {note ? <span className="review-chip-note">· {note}</span> : null}
    </div>
  )
}

// 流式过程中的行内标记渲染：已完整闭合的协议标记即时卡片化，
// 未闭合的残余文本保持原样（闭合瞬间自动变身）。流式气泡用，闭合后走完整 Markdown。
export function renderStreamingMarkers(text: string): ReactNode {
  const re = /<delegate\b[^>]*>[\s\S]*?<\/delegate>|<continue\b[^>]*>[\s\S]*?<\/continue>|<(?:round|review)\b[^>]*?\/>/g
  const nodes: ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index))
    const tag = m[0]
    const key = `m${m.index}`
    if (tag.startsWith('<round')) {
      nodes.push(<RoundChip key={key} inline outcome={tagAttr(tag, ROUND_OUTCOME_RE)} reason={tagAttr(tag, ROUND_REASON_RE)} />)
    } else if (tag.startsWith('<review')) {
      nodes.push(
        <ReviewChip key={key} inline of={tagAttr(tag, REVIEW_OF_RE)} verdict={tagAttr(tag, REVIEW_VERDICT_RE)} note={tagAttr(tag, REVIEW_NOTE_RE)} />
      )
    } else if (tag.startsWith('<delegate')) {
      nodes.push(<span key={key} className="stream-tag">⚡ 委派 → {tagAttr(tag, DELEGATE_TO_RE) ?? '…'}</span>)
    } else {
      nodes.push(<span key={key} className="stream-tag stream-tag-violet">⏭ 阶段接力</span>)
    }
    last = m.index + tag.length
  }
  nodes.push(text.slice(last))
  return nodes
}

// ---------- 内置语法高亮（零依赖） ----------
// 每种语言是一组 [token 类型, 正则源] 规则，按顺序合成一条全局正则扫描；
// 规则源里只能用非捕获组（组序号用于反查 token 类型）。
type TokType = 'kw' | 'str' | 'num' | 'com' | 'fn' | 'type' | 'prop' | 'tag' | 'attr'
type Rule = [TokType, string]

const CLIKE_STR = String.raw`"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'`
const CLIKE_COM = String.raw`//[^\n]*|/\*[\s\S]*?\*/`
const CLIKE_NUM = String.raw`\b0x[\da-fA-F]+\b|\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b`
const CLIKE_FN = String.raw`\b[A-Za-z_$][\w$]*(?=\s*\()`

const RECIPES: Record<string, { flags?: string; rules: Rule[] }> = {
  js: {
    rules: [
      ['com', CLIKE_COM],
      ['str', String.raw`"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|` + '`(?:\\\\.|[^`\\\\])*`'],
      ['kw', String.raw`\b(?:import|export|from|default|const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|super|this|typeof|instanceof|in|of|try|catch|finally|throw|async|await|yield|static|get|set|public|private|protected|readonly|interface|type|enum|implements|namespace|declare|abstract|as|satisfies|keyof|infer|is)\b`],
      ['num', String.raw`\b(?:true|false|null|undefined|NaN)\b`],
      ['num', CLIKE_NUM],
      ['fn', CLIKE_FN],
      ['type', String.raw`\b[A-Z][A-Za-z0-9_$]*\b`]
    ]
  },
  json: {
    rules: [
      ['prop', String.raw`"(?:\\.|[^"\\])*"(?=\s*:)`],
      ['str', String.raw`"(?:\\.|[^"\\])*"`],
      ['num', String.raw`\b(?:true|false|null)\b`],
      ['num', CLIKE_NUM]
    ]
  },
  bash: {
    rules: [
      ['com', String.raw`#[^\n]*`],
      ['str', String.raw`"[^"\n]*"|'[^'\n]*'`],
      ['prop', String.raw`\$\{[^}\n]*\}|\$[\w@*#?!$-]+`],
      ['kw', String.raw`\b(?:if|then|elif|else|fi|for|in|do|done|while|until|case|esac|function|return|exit|export|local|source|set|unset|shift|trap|alias)\b`],
      ['fn', String.raw`\b(?:npm|pnpm|yarn|npx|node|git|cd|ls|echo|cat|grep|sed|awk|curl|wget|mkdir|rmdir|rm|cp|mv|ln|chmod|chown|sudo|make|cargo|rustc|python3?|pip3?|docker|kubectl|ssh|scp|tar|zip|unzip|find|xargs|head|tail|sort|uniq|wc|which|env|kill|ps|du|df|touch|tee)\b`],
      ['prop', String.raw`(?:^|\s)--?[a-zA-Z][\w-]*`]
    ]
  },
  py: {
    rules: [
      ['com', String.raw`#[^\n]*`],
      ['str', String.raw`[rbfu]{0,2}(?:"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')`],
      ['attr', String.raw`@[\w.]+`],
      ['kw', String.raw`\b(?:def|class|import|from|as|return|if|elif|else|for|while|break|continue|pass|try|except|finally|raise|with|lambda|global|nonlocal|assert|yield|async|await|del|in|is|not|and|or)\b`],
      ['num', String.raw`\b(?:self|cls|None|True|False)\b`],
      ['fn', String.raw`\b[A-Za-z_]\w*(?=\s*\()`],
      ['num', CLIKE_NUM]
    ]
  },
  css: {
    rules: [
      ['com', String.raw`/\*[\s\S]*?\*/`],
      ['kw', String.raw`@[\w-]+`],
      ['str', CLIKE_STR],
      ['num', String.raw`#[0-9a-fA-F]{3,8}\b`],
      ['prop', String.raw`[-a-zA-Z]+(?=\s*:)`],
      ['num', String.raw`\b\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|vmin|vmax|s|ms|deg|fr)?\b`],
      ['type', String.raw`\.[\w-]+|#[\w-]+`]
    ]
  },
  html: {
    rules: [
      ['com', String.raw`<!--[\s\S]*?-->|<![^>]*>`],
      ['tag', String.raw`</?[A-Za-z][\w-]*|/?>`],
      ['attr', String.raw`[A-Za-z-][\w-]*(?==)`],
      ['str', CLIKE_STR]
    ]
  },
  sql: {
    flags: 'i',
    rules: [
      ['com', String.raw`--[^\n]*|/\*[\s\S]*?\*/`],
      ['str', String.raw`'(?:''|[^'\n])*'`],
      ['kw', String.raw`\b(?:select|from|where|insert|into|values|update|set|delete|create|table|drop|alter|add|column|join|left|right|inner|outer|full|cross|on|group|order|by|having|limit|offset|as|and|or|not|null|primary|key|foreign|references|distinct|count|sum|avg|min|max|between|like|in|exists|union|all|case|when|then|else|end|with|asc|desc|default|unique|index|view|if)\b`],
      ['num', CLIKE_NUM]
    ]
  },
  yaml: {
    flags: 'm',
    rules: [
      ['com', String.raw`#[^\n]*`],
      ['prop', String.raw`^[ \t]*(?:- )?[\w.\-/]+(?=\s*:)`],
      ['str', CLIKE_STR],
      ['num', String.raw`\b(?:true|false|null|yes|no|on|off)\b`],
      ['num', CLIKE_NUM]
    ]
  },
  diff: {
    flags: 'm',
    rules: [
      ['com', String.raw`^(?:\+\+\+|---|diff |index )[^\n]*`],
      ['kw', String.raw`^@@[^\n]*`],
      ['str', String.raw`^\+[^\n]*`],
      ['tag', String.raw`^-[^\n]*`]
    ]
  },
  clike: {
    rules: [
      ['com', CLIKE_COM],
      ['str', String.raw`"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'`],
      ['kw', String.raw`\b(?:fn|func|let|mut|pub|struct|impl|enum|trait|use|mod|match|loop|while|for|in|if|else|return|break|continue|package|import|class|interface|extends|implements|new|this|self|static|final|const|var|void|public|private|protected|virtual|override|namespace|using|template|typename|switch|case|default|sizeof|go|defer|chan|select|type|map|range|unsafe|goto)\b`],
      ['num', CLIKE_NUM],
      ['fn', CLIKE_FN],
      ['type', String.raw`\b[A-Z]\w*\b`]
    ]
  }
}

const LANG_ALIAS: Record<string, string> = {
  javascript: 'js', js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', ts: 'js', tsx: 'js', typescript: 'js',
  json: 'json', json5: 'json', jsonc: 'json',
  bash: 'bash', sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash',
  python: 'py', py: 'py', python3: 'py',
  css: 'css', scss: 'css', less: 'css',
  html: 'html', xml: 'html', svg: 'html', vue: 'html', svelte: 'html',
  sql: 'sql',
  yaml: 'yaml', yml: 'yaml', toml: 'yaml', ini: 'yaml',
  diff: 'diff', patch: 'diff',
  go: 'clike', golang: 'clike', rust: 'clike', java: 'clike', kotlin: 'clike', swift: 'clike',
  c: 'clike', cpp: 'clike', 'c++': 'clike', csharp: 'clike', 'c#': 'clike', cs: 'clike', php: 'clike'
}

// 合成正则按语言缓存（流式重渲染频繁，避免每次重编译）
const MASTER_CACHE = new Map<string, { re: RegExp; types: TokType[] }>()

function masterFor(lang: string): { re: RegExp; types: TokType[] } | null {
  const recipe = RECIPES[lang]
  if (!recipe) return null
  const cached = MASTER_CACHE.get(lang)
  if (cached) return cached
  const types = recipe.rules.map(([type]) => type)
  // g 必须带上（exec 推进 lastIndex），语言自定义的 m/i 追加在后
  const re = new RegExp(recipe.rules.map(([, source]) => `(${source})`).join('|'), `g${recipe.flags ?? ''}`)
  const built = { re, types }
  MASTER_CACHE.set(lang, built)
  return built
}

// 把代码切成 [类型, 文本] 序列（'plain' 为未命中段）
function tokenize(code: string, lang: string): [TokType | 'plain', string][] {
  const master = masterFor(lang)
  if (!master || !code) return [['plain', code]]
  const { re, types } = master
  re.lastIndex = 0
  const out: [TokType | 'plain', string][] = []
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(code))) {
    if (m[0].length === 0) { re.lastIndex++; continue }
    if (m.index > last) out.push(['plain', code.slice(last, m.index)])
    const groupIndex = m.findIndex((group, i) => i > 0 && group !== undefined)
    out.push([types[groupIndex - 1], m[0]])
    last = m.index + m[0].length
  }
  if (last < code.length) out.push(['plain', code.slice(last)])
  return out
}

function highlighted(code: string, lang?: string): ReactNode {
  const canonical = lang ? LANG_ALIAS[lang] : undefined
  if (!canonical) return code
  return tokenize(code, canonical).map(([type, text], index) =>
    type === 'plain' ? text : <span key={index} className={`tok-${type}`}>{text}</span>
  )
}

// 代码卡片：头部语言标签 + 一键复制，正文高亮
function CodeCard({ code, lang }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false)
  const body = useMemo(() => highlighted(code, lang), [code, lang])
  const copy = () => {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    })
  }
  return (
    <div className="md-code">
      <div className="md-code-bar">
        <span className="md-code-lang">{lang || 'text'}</span>
        <button type="button" className={copied ? 'md-code-copy ok' : 'md-code-copy'} onClick={copy}>
          {copied ? '✓ 已复制' : '⧉ 复制'}
        </button>
      </div>
      <pre><code>{body}</code></pre>
    </div>
  )
}

// react-markdown 的 pre 子节点（<code class="language-x">）里抠出语言与纯文本
function extractText(node: unknown): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(extractText).join('')
  if (isValidElement(node)) return extractText((node.props as { children?: unknown }).children)
  return ''
}

function preOverride({ children }: { children?: ReactNode }) {
  const child = Array.isArray(children) ? children[0] : children
  let className = ''
  let code: string
  if (isValidElement(child)) {
    const props = child.props as { className?: string; children?: unknown }
    className = props.className ?? ''
    code = extractText(props.children)
  } else {
    code = extractText(children)
  }
  const lang = /language-([\w+#.-]+)/.exec(className)?.[1]?.toLowerCase()
  return <CodeCard code={code.replace(/\n$/, '')} lang={lang} />
}

const MD_COMPONENTS = {
  pre: preOverride,
  a: ({ href, children }: { href?: string; children?: ReactNode }) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
      {href && /^https?:\/\//.test(href) && <span className="md-link-ext" aria-hidden="true">↗</span>}
    </a>
  )
}

// 普通文本入队：先过 continue/round/review 二次扫描，其余走 Markdown
function pushMarkdown(mdText: string, nodes: ReactNode[]) {
  if (!mdText) return
  let last = 0
  let m: RegExpExecArray | null
  SIDE_TAG_RE.lastIndex = 0
  while ((m = SIDE_TAG_RE.exec(mdText))) {
    const before = mdText.slice(last, m.index)
    if (before) pushRawMarkdown(before, nodes)
    const tag = m[0]
    if (tag.startsWith('<continue')) {
      nodes.push(<ContinueCard key={nodes.length} start={tagAttr(tag, CONTINUE_START_RE)} brief={m[1] ?? ''} />)
    } else if (tag.startsWith('<round')) {
      nodes.push(<RoundChip key={nodes.length} outcome={tagAttr(tag, ROUND_OUTCOME_RE)} reason={tagAttr(tag, ROUND_REASON_RE)} />)
    } else {
      nodes.push(
        <ReviewChip
          key={nodes.length}
          of={tagAttr(tag, REVIEW_OF_RE)}
          verdict={tagAttr(tag, REVIEW_VERDICT_RE)}
          note={tagAttr(tag, REVIEW_NOTE_RE)}
        />
      )
    }
    last = m.index + tag.length
  }
  const rest = mdText.slice(last)
  if (rest) pushRawMarkdown(rest, nodes)
}

function pushRawMarkdown(mdText: string, nodes: ReactNode[]) {
  if (!mdText) return
  nodes.push(
    <ReactMarkdown key={nodes.length} remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
      {mdText}
    </ReactMarkdown>
  )
}

// 按 DELEGATE_RE 切成 [普通片段, attrs, 指令, ...] 交替序列，逐段渲染
function renderSegments(text: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const segments = text.split(DELEGATE_RE)
  for (let i = 0; i < segments.length; i += 3) {
    pushMarkdown(segments[i] ?? '', nodes)
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
