import { useMemo } from 'react'

/** unified diff 的一行 */
interface DiffLine {
  kind: 'meta' | 'file' | 'hunk' | 'add' | 'del' | 'ctx'
  text: string
}

interface DiffFile {
  name: string
  lines: DiffLine[]
  adds: number
  dels: number
  binary: boolean
}

const MAX_RENDER_LINES = 3000

/** 解析 unified diff（git diff 默认输出；含 \ No newline、Binary files 等杂行容错） */
export function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = []
  let cur: DiffFile | null = null
  for (const raw of diff.split('\n')) {
    if (!raw && !cur) continue // 前导/尾随空行不建虚拟文件
    if (raw.startsWith('diff --git ') || /^diff --cc /.test(raw)) {
      const m = raw.match(/^diff --(?:git|cc) a\/(.*) b\/(.*)$/)
      cur = { name: m?.[2] ?? raw.replace(/^diff --\w+ /, ''), lines: [{ kind: 'meta', text: raw }], adds: 0, dels: 0, binary: false }
      files.push(cur)
      continue
    }
    if (!cur) {
      // 无文件头的裸 diff（比如手工贴的片段）：整体放进一个虚拟文件
      cur = { name: '', lines: [], adds: 0, dels: 0, binary: false }
      files.push(cur)
    }
    if (raw.startsWith('@@')) cur.lines.push({ kind: 'hunk', text: raw })
    else if (raw.startsWith('+') && !raw.startsWith('+++')) {
      cur.adds++
      cur.lines.push({ kind: 'add', text: raw })
    } else if (raw.startsWith('-') && !raw.startsWith('---')) {
      cur.dels++
      cur.lines.push({ kind: 'del', text: raw })
    } else if (raw.startsWith('+++')) cur.lines.push({ kind: 'file', text: raw })
    else if (raw.startsWith('---') || raw.startsWith('index ') || /^[a-z]+ mode /.test(raw)) cur.lines.push({ kind: 'meta', text: raw })
    else if (/^Binary files .* differ/.test(raw)) {
      cur.binary = true
      cur.lines.push({ kind: 'meta', text: raw })
    } else if (raw.startsWith('\\') || raw.startsWith('diff --')) cur.lines.push({ kind: 'meta', text: raw })
    else cur.lines.push({ kind: 'ctx', text: raw })
  }
  return files.filter((f) => f.name !== '' || f.lines.some((l) => l.text.trim() !== ''))
}

/** git diff 按行染色渲染（零依赖） */
export function DiffView({ diff }: { diff: string }) {
  const files = useMemo(() => parseDiff(diff), [diff])
  let total = 0
  let truncated = false
  const rendered = files.map((f) => {
    if (truncated) return null
    if (total + f.lines.length > MAX_RENDER_LINES) {
      truncated = true
      return null
    }
    total += f.lines.length
    return f
  })
  const shown = rendered.filter(Boolean) as DiffFile[]

  if (!shown.length) return <div className="list-empty">无改动</div>
  return (
    <div className="diff-view">
      {shown.map((f, i) => (
        <div key={i} className="diff-file">
          <div className="diff-file-head">
            <span className="diff-file-name">{f.name || '(未命名片段)'}</span>
            {f.binary ? (
              <span className="mini dim">二进制文件</span>
            ) : (
              <>
                {f.dels > 0 && <span className="diff-count del">-{f.dels}</span>}
                {f.adds > 0 && <span className="diff-count add">+{f.adds}</span>}
              </>
            )}
          </div>
          <pre className="diff-body">
            {f.lines.map((l, j) => (
              <span key={j} className={`dl dl-${l.kind}`}>{l.text || ' '}</span>
            ))}
          </pre>
        </div>
      ))}
      {truncated && <div className="list-empty">diff 过长，仅渲染前 {MAX_RENDER_LINES} 行（完整内容见仓库）</div>}
    </div>
  )
}
