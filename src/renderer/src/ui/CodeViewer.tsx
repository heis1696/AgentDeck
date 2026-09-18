/**
 * R3 契约：<CodeViewer {...edit} /> 只读展示工具事件快照，不读取工作区文件。
 * content（包括空字符串）优先于 oldString/newString；后者仅为替换片段，行号从 1 起，非文件绝对行号。
 * additions/deletions 为后端统计；缺省语言 plaintext；主题由 html.light + 双主题 token 自动切换。
 * 高亮器全局单例、语言按需加载；每次最多增加 3000 行，查找可展开并跳到隐藏行。
 *
 * v2（反馈4）：diff 通道优先——payload 带 git 统一 diff 时按 GitHub 风格渲染
 * （双行号 + hunk 头 + +/- 底色），行号是文件绝对行号；diffNote 说明数据来源
 * （clean=git 无未提交改动、回退参数快照等）。binary=true 只显示统计不渲染文本。
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { HighlighterCore, ThemedToken } from 'shiki'

export interface CodeViewerProps {
  file: string
  content?: string
  oldString?: string
  newString?: string
  truncated?: boolean
  additions?: number
  deletions?: number
  /** git 统一 diff（tasks:fileDiff 权威数据）；存在即进入 diff 渲染模式 */
  diff?: string
  /** diff 数据来源说明（clean / 错误码等），展示在工具条下方 */
  diffNote?: string
  /** 二进制文件：只有统计没有可渲染文本 */
  binary?: boolean
}

const PAGE_SIZE = 3000
const languages = {
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  jsonc: () => import('shiki/langs/jsonc.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  scss: () => import('shiki/langs/scss.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  shellscript: () => import('shiki/langs/shellscript.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs')
}
type Language = keyof typeof languages | 'plaintext'
const extensions: Record<string, Language> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  json: 'json', jsonc: 'jsonc', css: 'css', scss: 'scss', html: 'html', htm: 'html',
  py: 'python', pyw: 'python', rs: 'rust', go: 'go', md: 'markdown', mdx: 'markdown',
  sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript', yaml: 'yaml', yml: 'yaml',
  toml: 'toml', sql: 'sql', java: 'java', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp'
}
function fileLanguage(file: string): Language {
  const name = file.split(/[\\/]/).pop()?.toLowerCase() ?? ''
  if (['.bashrc', '.zshrc', '.bash_profile'].includes(name)) return 'shellscript'
  return extensions[name.split('.').pop() ?? ''] ?? 'plaintext'
}
let highlighterPromise: Promise<HighlighterCore> | undefined
function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = Promise.all([
      import('shiki/core'), import('shiki/engine/oniguruma'),
      import('shiki/themes/github-light.mjs'), import('shiki/themes/github-dark.mjs')
    ]).then(([{ createHighlighterCore }, { createOnigurumaEngine }, light, dark]) => createHighlighterCore({
      themes: [light.default, dark.default], langs: [],
      engine: createOnigurumaEngine(import('shiki/wasm'))
    })).catch((error) => { highlighterPromise = undefined; throw error })
  }
  return highlighterPromise
}

type CodeRow = { text: string; number: number; kind: 'normal' | 'deleted' | 'added' | 'hunk'; oldNumber?: number }
const lines = (text: string) => text.split(/\r\n|\n|\r/)

/** 统一 diff → 行模型：@@ 头为 hunk 行；上下文双号推进；-旧行 / +新行各自推进 */
export function parseUnifiedDiff(diff: string): CodeRow[] {
  const rows: CodeRow[] = []
  let oldNo = 0
  let newNo = 0
  for (const raw of lines(diff)) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
    if (hunk) { oldNo = Number(hunk[1]); newNo = Number(hunk[2]); rows.push({ text: raw, number: newNo, oldNumber: oldNo, kind: 'hunk' }); continue }
    if (raw.startsWith('diff --git ') || raw.startsWith('index ') || raw.startsWith('--- ') || raw.startsWith('+++ ') || raw.startsWith('new file mode') || raw.startsWith('deleted file mode') || raw.startsWith('Binary files') || raw.startsWith('\\ No newline')) continue
    if (raw.startsWith('-')) { rows.push({ text: raw.slice(1), number: oldNo, kind: 'deleted' }); oldNo++; continue }
    if (raw.startsWith('+')) { rows.push({ text: raw.slice(1), number: newNo, kind: 'added' }); newNo++; continue }
    rows.push({ text: raw.startsWith(' ') ? raw.slice(1) : raw, number: newNo, oldNumber: oldNo, kind: 'normal' })
    oldNo++; newNo++
  }
  return rows
}

export function CodeViewer(props: CodeViewerProps) {
  // 快照更新必须重置分页/查找，不能把旧快照的高亮结果套到新文本上。
  const identity = JSON.stringify([props.file, props.content, props.oldString, props.newString, props.diff])
  return <CodeSnapshot key={identity} {...props} />
}

function CodeSnapshot({ file, content, oldString, newString, truncated, additions, deletions, diff, diffNote, binary }: CodeViewerProps) {
  const [wrap, setWrap] = useState(false)
  const [query, setQuery] = useState('')
  const [matchIndex, setMatchIndex] = useState(0)
  const [limit, setLimit] = useState(PAGE_SIZE)
  const [highlight, setHighlight] = useState<{ count: number; tokens: ThemedToken[][] } | null>(null)
  const [highlightError, setHighlightError] = useState(false)
  const [copyState, setCopyState] = useState('复制')
  const scrollRef = useRef<HTMLDivElement>(null)
  const copyTimer = useRef<ReturnType<typeof setTimeout>>()
  const isDiff = diff !== undefined && diff !== ''
  const isContent = !isDiff && content !== undefined
  const missing = !isDiff && !isContent && oldString === undefined && newString === undefined
  const language = fileLanguage(file)
  const rows = useMemo<CodeRow[]>(() => {
    if (isDiff) return parseUnifiedDiff(diff)
    if (isContent) return lines(content).map((text, index) => ({ text, number: index + 1, kind: 'normal' as const }))
    const removed: CodeRow[] = oldString ? lines(oldString).map((text, index) => ({ text, number: index + 1, kind: 'deleted' as const })) : []
    const added: CodeRow[] = newString ? lines(newString).map((text, index) => ({ text, number: index + 1, kind: 'added' as const })) : []
    return [...removed, ...added]
  }, [content, oldString, newString, diff, isContent, isDiff])
  const visibleRows = useMemo(() => rows.slice(0, limit), [rows, limit])
  const matches = useMemo(() => {
    if (!query) return []
    const needle = query.toLocaleLowerCase()
    return rows.flatMap((row, index) => row.text.toLocaleLowerCase().includes(needle) ? [index] : [])
  }, [rows, query])
  const matchSet = useMemo(() => new Set(matches), [matches])
  const selectedLine = matches.length ? matches[matchIndex % matches.length] : -1

  useEffect(() => {
    let cancelled = false
    setHighlightError(false)
    void getHighlighter().then(async (highlighter) => {
      if (language !== 'plaintext') await highlighter.loadLanguage((await languages[language]()).default)
      if (cancelled) return
      const tokenize = (block: CodeRow[]) => block.length ? highlighter.codeToTokens(block.map((row) => row.text).join('\n'), {
        lang: language, themes: { light: 'github-light', dark: 'github-dark' }, defaultColor: false
      }).tokens : []
      // diff/片段模式按"旧侧/新侧"连续段分别 tokenize（上下文+新增属新文件视图，删除属旧文件视图），
      // 段内 token 与行一一对应；content 模式整块一次
      const segmentTokens = (block: CodeRow[]) => {
        const assigned: ThemedToken[][] = new Array(block.length)
        let buffer: Array<{ row: CodeRow; index: number }> = []
        let bufferOld = false
        const flush = () => {
          if (!buffer.length) return
          tokenize(buffer.map((item) => item.row)).forEach((tokens, index) => { assigned[buffer[index].index] = tokens })
          buffer = []
        }
        block.forEach((row, index) => {
          if (row.kind === 'hunk') { flush(); return }
          const isOld = row.kind === 'deleted'
          if (buffer.length && isOld !== bufferOld) flush()
          bufferOld = isOld
          buffer.push({ row, index })
        })
        flush()
        return assigned
      }
      const tokens = isContent ? tokenize(visibleRows) : isDiff ? segmentTokens(visibleRows) : [
        ...tokenize(visibleRows.filter((row) => row.kind === 'deleted')),
        ...tokenize(visibleRows.filter((row) => row.kind === 'added'))
      ]
      if (!cancelled) setHighlight({ count: visibleRows.length, tokens })
    }).catch(() => { if (!cancelled) setHighlightError(true) })
    return () => { cancelled = true }
  }, [language, isContent, isDiff, visibleRows])

  useEffect(() => {
    if (selectedLine < 0) return
    if (selectedLine >= limit) { setLimit(Math.ceil((selectedLine + 1) / PAGE_SIZE) * PAGE_SIZE); return }
    const container = scrollRef.current
    const row = container?.querySelector<HTMLElement>(`[data-code-line="${selectedLine}"]`)
    if (container && row) container.scrollTo({ top: Math.max(0, row.offsetTop - container.clientHeight / 2), behavior: 'smooth' })
  }, [selectedLine, limit, highlight])
  useEffect(() => () => { clearTimeout(copyTimer.current) }, [])

  const moveMatch = (direction: number) => {
    if (matches.length) setMatchIndex((index) => (index + direction + matches.length) % matches.length)
  }
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(isDiff ? diff : isContent ? content : newString ?? '')
      setCopyState('已复制')
    } catch { setCopyState('复制失败') }
    clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => setCopyState('复制'), 1800)
  }
  const ready = highlight?.count === visibleRows.length
  return <section className={`code-viewer${wrap ? ' is-wrapped' : ''}${isDiff ? ' is-diff' : ''}`} aria-label={`${file} 只读代码`}>
    {truncated && <div className="code-warning" role="status">内容已截断：工具事件最多保留 64 KB，以下不是完整文件。</div>}
    <header className="code-toolbar">
      <span className="code-filename" title={file}>{file.split(/[\\/]/).pop()}</span>
      <span className="code-language">{language} · {isDiff ? 'git diff' : '只读'}</span>
      {(additions != null || deletions != null) && <span className="code-counts"><span className="edit-added">+{additions ?? 0}</span> <span className="edit-deleted">-{deletions ?? 0}</span></span>}
      <button type="button" aria-pressed={wrap} onClick={() => setWrap((value) => !value)}>自动换行</button>
      <button type="button" disabled={missing || binary} title={isDiff ? '复制 diff 原文' : isContent ? '复制当前快照（含未展开行）' : '复制替换后的片段'} onClick={() => void copy()}>{copyState}</button>
    </header>
    <div className="code-search">
      <input type="search" value={query} aria-label="查找代码" placeholder="查找代码…" onChange={(event) => { setQuery(event.target.value); setMatchIndex(0) }} onKeyDown={(event) => {
        if (event.key === 'Enter') { event.preventDefault(); moveMatch(event.shiftKey ? -1 : 1) }
        if (event.key === 'Escape') { setQuery(''); setMatchIndex(0) }
      }} />
      <span role="status">{query ? matches.length ? `${matchIndex % matches.length + 1}/${matches.length} 行` : '无匹配' : `${rows.length} 行`}</span>
      <button type="button" disabled={!matches.length} aria-label="上一个匹配行" onClick={() => moveMatch(-1)}>↑</button>
      <button type="button" disabled={!matches.length} aria-label="下一个匹配行" onClick={() => moveMatch(1)}>↓</button>
    </div>
    {diffNote && <div className="code-diff-note">{diffNote}</div>}
    {!isContent && !isDiff && !missing && <div className="code-diff-note">替换片段 · 删除 / 新增行号分别从 1 开始，非文件绝对行号</div>}
    {highlightError && <div className="code-warning" role="status">语法高亮加载失败，已回退为纯文本。</div>}
    <div ref={scrollRef} className="code-scroll" tabIndex={0} aria-label="代码内容">
      {missing || binary ? <div className="code-empty">{binary ? '二进制文件：只有行数统计，没有可渲染文本。' : '此事件只有编辑统计，未提供代码快照。'}</div> : !rows.length ? <div className="code-empty">空替换片段</div> : !ready && !highlightError ? <div className="code-skeleton" role="status" aria-label="正在加载语法高亮">{[72, 48, 85, 60, 38, 76].map((width, index) => <i key={index} style={{ width: `${width}%` }} />)}</div> : <div className="code-lines">
        {visibleRows.map((row, index) => <div key={index} data-code-line={index} className={`code-line is-${row.kind}${matchSet.has(index) ? ' is-match' : ''}${selectedLine === index ? ' is-current-match' : ''}`}>
          {isDiff
            ? <><span className="code-line-number code-line-number-old" aria-hidden="true">{row.kind === 'added' || row.kind === 'hunk' ? '' : row.oldNumber ?? row.number}</span><span className="code-line-number" aria-hidden="true">{row.kind === 'deleted' || row.kind === 'hunk' ? '' : row.number}</span></>
            : <span className="code-line-number" aria-hidden="true">{row.number}</span>}
          <span className="code-line-sign" aria-hidden="true">{row.kind === 'deleted' ? '-' : row.kind === 'added' ? '+' : ' '}</span>
          <code>{ready && !highlightError ? highlight.tokens[index]?.map((token, tokenIndex) => <span key={tokenIndex} className="code-token" style={token.htmlStyle as CSSProperties}>{token.content}</span>) : row.text}{!row.text && '\u200b'}</code>
        </div>)}
      </div>}
      {rows.length > limit && <button className="code-load-more" type="button" onClick={() => setLimit((value) => value + PAGE_SIZE)}>加载更多（剩余 {rows.length - limit} 行）</button>}
    </div>
    <footer className="code-status" title={file}><span>{file}</span><span>{isDiff ? 'git diff' : isContent ? '文件快照' : '编辑片段'} · {Math.min(limit, rows.length)}/{rows.length} 行</span></footer>
  </section>
}
