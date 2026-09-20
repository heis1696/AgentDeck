/**
 * R3 契约：<CodeViewer {...edit} /> 只读展示工具事件快照，不读取工作区文件。
 * content（包括空字符串）优先于 oldString/newString；后者仅为替换片段，行号从 1 起，非文件绝对行号。
 * additions/deletions 为后端统计；缺省语言 plaintext；主题由 html.light + 双主题 token 自动切换。
 * 高亮器全局单例、语言按需加载；每次最多增加 3000 行，查找可展开并跳到隐藏行。
 *
 * v2（反馈4）：diff 通道优先——payload 带 git 统一 diff 时按 GitHub 风格渲染
 * （双行号 + hunk 头 + +/- 底色），行号是文件绝对行号；diffNote 说明数据来源
 * （clean=git 无未提交改动、回退参数快照等）。binary=true 只显示统计不渲染文本。
 * v3（审查项 4）：diff 模式「跳转」按**新/旧文件绝对行号**定位（不再拿行下标充当行号），
 * 行号选择器切换新文件 / 旧文件；显式滚动统一走 motion.ts（尊重 prefers-reduced-motion）。
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { HighlighterCore, ThemedToken } from 'shiki'
import { isComposingKey } from './interaction-center'
import { scrollElementTo } from './motion'

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

/**
 * 行模型。三套行号语义必须分清楚（跳转正确性的根）：
 * - `number`：本行在**自身所属文件**里的行号（新增/上下文 = 新文件，删除 = 旧文件），仅用于左侧展示；
 * - `oldNumber`：该行在**旧文件**里的绝对行号（仅删除行与上下文行有）；
 * - `newNumber`：该行在**新文件**里的绝对行号（仅新增行与上下文行有）；
 * 删除行的 `number` 等于旧文件行号，所以跳转判定不能只看 `number`——必须按侧取 oldNumber/newNumber。
 * hunk 头（@@）不是文件里的行，两侧行号都不登记：按行号跳转要落在真实内容行上。
 */
export type CodeRow = {
  text: string
  number: number
  kind: 'normal' | 'deleted' | 'added' | 'hunk'
  oldNumber?: number
  newNumber?: number
}
export type DiffSide = 'old' | 'new'
const lines = (text: string) => text.split(/\r\n|\n|\r/)

/** 统一 diff → 行模型：@@ 头为 hunk 行；上下文双号推进；-旧行 / +新行各自推进 */
export function parseUnifiedDiff(diff: string): CodeRow[] {
  const rows: CodeRow[] = []
  let oldNo = 0
  let newNo = 0
  for (const raw of lines(diff)) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
    if (hunk) { oldNo = Number(hunk[1]); newNo = Number(hunk[2]); rows.push({ text: raw, number: newNo, kind: 'hunk' }); continue }
    if (raw.startsWith('diff --git ') || raw.startsWith('index ') || raw.startsWith('--- ') || raw.startsWith('+++ ') || raw.startsWith('new file mode') || raw.startsWith('deleted file mode') || raw.startsWith('Binary files') || raw.startsWith('\\ No newline')) continue
    if (raw.startsWith('-')) { rows.push({ text: raw.slice(1), number: oldNo, oldNumber: oldNo, kind: 'deleted' }); oldNo++; continue }
    if (raw.startsWith('+')) { rows.push({ text: raw.slice(1), number: newNo, newNumber: newNo, kind: 'added' }); newNo++; continue }
    rows.push({ text: raw.startsWith(' ') ? raw.slice(1) : raw, number: newNo, oldNumber: oldNo, newNumber: newNo, kind: 'normal' })
    oldNo++; newNo++
  }
  return rows
}

/**
 * 按**某一侧的绝对行号**定位行下标（审查项 4）：diff 里行下标 ≠ 文件行号
 * （hunk 之间会跳号），所以必须整体扫描该侧行号，找不到返回 -1。
 */
export function findDiffRowIndex(rows: CodeRow[], line: number, side: DiffSide): number {
  if (!Number.isFinite(line) || line < 1) return -1
  return rows.findIndex((row) => (side === 'old' ? row.oldNumber : row.newNumber) === line)
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
  const [gotoValue, setGotoValue] = useState('')
  const [gotoSide, setGotoSide] = useState<DiffSide>('new')
  const [jumpLine, setJumpLine] = useState(-1)
  const [atTop, setAtTop] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const copyTimer = useRef<ReturnType<typeof setTimeout>>()
  const jumpTimer = useRef<ReturnType<typeof setTimeout>>()
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
    if (container && row) scrollElementTo(container, Math.max(0, row.offsetTop - container.clientHeight / 2))
  }, [selectedLine, limit, highlight])
  useEffect(() => () => { clearTimeout(copyTimer.current); clearTimeout(jumpTimer.current) }, [])

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
  /** 跳到第 N 行：diff 模式下 N 是**所选一侧的绝对文件行号**（非行下标）；其余模式 N 就是行号 */
  const gotoLine = (raw: string) => {
    const target = Number.parseInt(raw, 10)
    if (!Number.isFinite(target) || target < 1) return
    const index = isDiff ? findDiffRowIndex(rows, target, gotoSide) : Math.min(rows.length, target) - 1
    if (index < 0) return
    if (index >= limit) setLimit(Math.ceil((index + 1) / PAGE_SIZE) * PAGE_SIZE)
    setGotoValue(String(target))
    setJumpLine(index)
    clearTimeout(jumpTimer.current)
    jumpTimer.current = setTimeout(() => setJumpLine(-1), 1600)
    requestAnimationFrame(() => {
      const container = scrollRef.current
      const row = container?.querySelector<HTMLElement>(`[data-code-line="${index}"]`)
      if (container && row) scrollElementTo(container, Math.max(0, row.offsetTop - container.clientHeight / 3))
    })
  }
  const onViewerKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    // IME 组合中一律放行（Enter/Escape/↑↓ 都属于输入法候选）
    if (isComposingKey(event.nativeEvent)) return
    const target = event.target as HTMLElement
    const inField = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
    if (!inField && event.key === '/') { event.preventDefault(); searchRef.current?.focus(); return }
    if (inField || event.ctrlKey || event.metaKey || event.altKey) return
    if (event.key === 'n' || event.key === 'N') { event.preventDefault(); moveMatch(event.key === 'n' ? 1 : -1); return }
    if (event.key === 'w') { event.preventDefault(); setWrap((value) => !value); return }
    if (event.key === 'c') { event.preventDefault(); void copy(); return }
    if (event.key === 'g' || event.key === 'G') {
      event.preventDefault()
      const container = scrollRef.current
      if (container) scrollElementTo(container, event.key === 'g' ? 0 : container.scrollHeight)
    }
  }
  const ready = highlight?.count === visibleRows.length
  const totalAdds = additions ?? 0
  const totalDels = deletions ?? 0
  const changeTotal = totalAdds + totalDels
  return <section className={`code-viewer${wrap ? ' is-wrapped' : ''}${isDiff ? ' is-diff' : ''}`} aria-label={`${file} 只读代码`} onKeyDown={onViewerKeyDown}>
    {truncated && <div className="code-warning" role="status">内容已截断：工具事件最多保留 64 KB，以下不是完整文件。</div>}
    <header className="code-toolbar">
      <span className="code-filename" title={file}>{file.split(/[\\/]/).pop()}</span>
      <span className="code-language">{language} · {isDiff ? 'git diff' : '只读'}</span>
      {(additions != null || deletions != null) && <span className="code-counts" title={`新增 ${totalAdds} 行 · 删除 ${totalDels} 行`}><span className="edit-added">+{totalAdds}</span> <span className="edit-deleted">-{totalDels}</span>{changeTotal > 0 && <span className="code-change-bar" aria-hidden="true"><i className="is-add" style={{ flexGrow: totalAdds }} /><i className="is-del" style={{ flexGrow: totalDels }} /></span>}</span>}
      <button type="button" aria-pressed={wrap} title="自动换行（W）" onClick={() => setWrap((value) => !value)}>自动换行</button>
      <button type="button" disabled={missing || binary} title={`${isDiff ? '复制 diff 原文' : isContent ? '复制当前快照（含未展开行）' : '复制替换后的片段'}（C）`} onClick={() => void copy()}>{copyState}</button>
    </header>
    <div className="code-search">
      <input ref={searchRef} type="search" value={query} aria-label="查找代码" placeholder="查找代码…（/ 聚焦，Enter 下一个）" onChange={(event) => { setQuery(event.target.value); setMatchIndex(0) }} onKeyDown={(event) => {
        // IME 组合中：Enter 上屏、Escape 取消候选，都不该被查找框当成命令
        if (isComposingKey(event.nativeEvent)) return
        if (event.key === 'Enter') { event.preventDefault(); moveMatch(event.shiftKey ? -1 : 1) }
        if (event.key === 'Escape') { setQuery(''); setMatchIndex(0) }
      }} />
      <span role="status">{query ? matches.length ? `${matchIndex % matches.length + 1}/${matches.length} 行` : '无匹配' : `${rows.length} 行`}</span>
      <button type="button" disabled={!matches.length} aria-label="上一个匹配行" title="上一个匹配行（N）" onClick={() => moveMatch(-1)}>↑</button>
      <button type="button" disabled={!matches.length} aria-label="下一个匹配行" title="下一个匹配行（n）" onClick={() => moveMatch(1)}>↓</button>
      <form className="code-goto" onSubmit={(event) => { event.preventDefault(); gotoLine(gotoValue) }}>
        {isDiff && <select className="code-goto-side" value={gotoSide} aria-label="跳转行号按哪一侧的文件" title="按新文件或旧文件的绝对行号跳转" onChange={(event) => setGotoSide(event.target.value === 'old' ? 'old' : 'new')}>
          <option value="new">新文件</option>
          <option value="old">旧文件</option>
        </select>}
        <input inputMode="numeric" value={gotoValue} aria-label={isDiff ? (gotoSide === 'old' ? '跳转到旧文件行' : '跳转到新文件行') : '跳转到行'} placeholder="行号" title={isDiff ? `${gotoSide === 'old' ? '旧' : '新'}文件绝对行号后回车（不在本次 diff 范围内则无命中）` : '跳转到指定行后回车'} onChange={(event) => setGotoValue(event.target.value.replace(/[^\d]/g, ''))} />
        <button type="submit" disabled={!gotoValue} title="跳转到该行">跳转</button>
      </form>
    </div>
    {diffNote && <div className="code-diff-note">{diffNote}</div>}
    {!isContent && !isDiff && !missing && <div className="code-diff-note">替换片段 · 删除 / 新增行号分别从 1 开始，非文件绝对行号</div>}
    {highlightError && <div className="code-warning" role="status">语法高亮加载失败，已回退为纯文本。</div>}
    <div ref={scrollRef} className="code-scroll" tabIndex={0} aria-label="代码内容（/ 查找，n/N 跳匹配，w 换行，c 复制，g/G 首尾）" onScroll={() => setAtTop((scrollRef.current?.scrollTop ?? 0) < 24)}>
      {missing || binary ? <div className="code-empty">{binary ? '二进制文件：只有行数统计，没有可渲染文本。' : '此事件只有编辑统计，未提供代码快照。'}</div> : !rows.length ? <div className="code-empty">空替换片段</div> : !ready && !highlightError ? <div className="code-skeleton" role="status" aria-label="正在加载语法高亮">{[72, 48, 85, 60, 38, 76].map((width, index) => <i key={index} style={{ width: `${width}%` }} />)}</div> : <div className="code-lines">
        {visibleRows.map((row, index) => <div key={index} data-code-line={index} className={`code-line is-${row.kind}${matchSet.has(index) ? ' is-match' : ''}${selectedLine === index ? ' is-current-match' : ''}${jumpLine === index ? ' is-jump' : ''}`}>
          {isDiff
            ? <><span className="code-line-number code-line-number-old" aria-hidden="true">{row.kind === 'added' || row.kind === 'hunk' ? '' : row.oldNumber ?? row.number}</span><span className="code-line-number" aria-hidden="true">{row.kind === 'deleted' || row.kind === 'hunk' ? '' : row.number}</span></>
            : <span className="code-line-number" aria-hidden="true">{row.number}</span>}
          <span className="code-line-sign" aria-hidden="true">{row.kind === 'deleted' ? '-' : row.kind === 'added' ? '+' : ' '}</span>
          <code>{ready && !highlightError ? highlight.tokens[index]?.map((token, tokenIndex) => <span key={tokenIndex} className="code-token" style={token.htmlStyle as CSSProperties}>{token.content}</span>) : row.text}{!row.text && '\u200b'}</code>
        </div>)}
      </div>}
      {rows.length > limit && <button className="code-load-more" type="button" onClick={() => setLimit((value) => value + PAGE_SIZE)}>加载更多（剩余 {rows.length - limit} 行）</button>}
      {!atTop && <button type="button" className="code-to-top" title="回到顶部（g）" aria-label="回到顶部" onClick={() => scrollElementTo(scrollRef.current, 0)}>↑</button>}
    </div>
    <footer className="code-status" title={file}><span>{file}</span><span>{isDiff ? 'git diff' : isContent ? '文件快照' : '编辑片段'} · {Math.min(limit, rows.length)}/{rows.length} 行{changeTotal > 0 ? ` · +${totalAdds}/-${totalDels}` : ''}</span></footer>
  </section>
}
