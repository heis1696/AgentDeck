// 工具调用的编辑元数据（`kind: 'tool'` 事件的 `data.edit`）。
//
// ── 契约（渲染层做 `file +N -M` 角标 + 点击查看详情，字段名/含义不要改）──
//   data.edit = {
//     file: string        // 被改动的文件路径：patch 取 patch 头，写/编辑类取 file_path/path
//     additions: number   // 新增行数（>= 0）
//     deletions: number   // 删除行数（>= 0）
//     content?: string    // Write/NotebookEdit 类：写入后的内容（点击查看用）
//     oldString?: string  // Edit 类：被替换掉的原文
//     newString?: string  // Edit/MultiEdit 类：替换后的新文（MultiEdit 为多段拼接）
//     truncated?: boolean // 上面任一字符串触达 64KB 上限被截断（行数仍按全文统计）
//   }
//
// ── 规则 ──
// - 纯函数、无副作用；**绝不 throw**——事件流是主进程主动脉，解析异常不能打断回合。
// - 按工具名分派（大小写/分隔符不敏感，兼容 `mcp__fs__edit_file` 这类命名）：
//     Write/NotebookEdit 类  args.file_path|path + content → additions=内容行数、deletions=0
//     Edit/str_replace 类    args.file_path + old_string/new_string → deletions=old 行数、
//                            additions=new 行数，保留 oldString/newString
//     MultiEdit 类           args.edits[] 逐项累加行数，newString 多段拼接
//     apply_patch/diff 类    直接从 patch 文本统计 +/- 行（以 patch 文本为权威），
//                            file 取 patch 头（`*** Update File:` / `+++ b/…` / `diff --git`）
// - 工具名未识别时只做**强形状兜底**：参数里带权威 patch 文本（`*** Begin Patch`/`@@`/
//   `+++ `）、或 edits 数组、或 file + old/new 这类"字面就是编辑语义"的强键同时出现，才
//   认定为编辑。弱别名（search/find/replace）只在工具名已确认是编辑类时才认，非编辑类
//   工具（Read/Grep/Bash{command:"ls"} 等）一律返回 null。
// - args 通常是工具入参的 JSON 字符串；也接受**原始命令文本**（codex 的 Bash 工具直接给
//   shell 命令，apply_patch 走 heredoc）——此时只在文本里存在 patch 特征才认定。
// - JSON 解析失败 → 返回 null（未识别工具另按上面的 patch 文本特征兜底）。
// - 字符串字段各 64KB（65536 字符，代码基本 ASCII）上限，超限截断并置 truncated。
//   patch 的 +/- 行统计只认行首标记：hunk 之前的 `--- `/`+++ ` 视为文件头跳过；
//   多文件 unified diff 以 `diff `/`Index: ` 复位 hunk 状态。
import type { ToolEditMeta } from '../../shared/types'

/** 单个字符串字段（content/oldString/newString）的截断上限 */
export const EDIT_FIELD_LIMIT = 64 * 1024

type Rec = Record<string, unknown>
type ToolClass = 'write' | 'edit' | 'multi' | 'patch' | 'unknown'

const FILE_KEYS = [
  'file_path', 'filePath', 'filepath', 'path', 'file', 'filename', 'fileName',
  'notebook_path', 'notebookPath', 'target_file', 'targetFile', 'relative_path', 'relativePath'
] as const

const OLD_STRONG_KEYS = [
  'old_string', 'oldString', 'old_str', 'old_text', 'oldText', 'old', 'original', 'before'
] as const

const NEW_STRONG_KEYS = [
  'new_string', 'newString', 'new_str', 'new_text', 'newText', 'new', 'replaced_with',
  'replacement', 'after', 'new_code', 'newCode'
] as const

/** 弱别名：只在工具名已确认是编辑类时才认（`Grep{search,path}` 这类不能被误判成编辑） */
const OLD_WEAK_KEYS = ['search', 'find', 'original_text', 'originalText'] as const
const NEW_WEAK_KEYS = ['replace'] as const

const OLD_KEYS = [...OLD_STRONG_KEYS, ...OLD_WEAK_KEYS]
const NEW_KEYS = [...NEW_STRONG_KEYS, ...NEW_WEAK_KEYS]

/** 写文件类的正文键（**不含 command/input**：否则 `Bash{command:"ls"}` 会被误判成写文件） */
const CONTENT_KEYS = [
  'content', 'contents', 'file_text', 'fileText', 'text', 'code', 'source', 'body',
  'new_source', 'newSource', 'written_content'
] as const

/** patch 文本可能挂在这些入参键上（codex 的 Bash apply_patch 走 command） */
const PATCH_TEXT_KEYS = ['patch', 'patch_text', 'patchText', 'diff', 'text', 'input', 'content', 'command', 'cmd', 'body'] as const

const PATCH_MARKER = /^\*\*\* (?:Begin|End|Update|Add|Delete|Move)/m
const HUNK_MARKER = /^@@/m
const UNIFIED_HEADER = /^(?:\+\+\+ |--- |diff --git )/m

function isRecord(value: unknown): value is Rec {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** 入参一律规整成字符串：字符串原样返回，对象 JSON 序列化，失败/空值给空串 */
export function stringifyToolArgs(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  try {
    const serialized = JSON.stringify(value)
    return typeof serialized === 'string' ? serialized : ''
  } catch {
    return ''
  }
}

function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
}

/**
 * 文本行数：单个结尾换行不算新行（`"a\nb\n"` = 2 行），CRLF 归一。
 * 注意 `""` = 0 行，`"\n"` = 1 行（一个空行）。
 */
export function countEditLines(value: string): number {
  if (!value) return 0
  const normalized = value.replace(/\r\n?/g, '\n')
  const trimmed = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized
  return trimmed.split('\n').length
}

/** 工具名 → 行为分类（分隔符/大小写不敏感） */
function classifyToolName(raw: string): ToolClass {
  const name = raw.toLowerCase().replace(/[\s_.\-:/]+/g, '')
  if (!name) return 'unknown'
  if (name.includes('multiedit') || name.includes('multireplace') || name.includes('batchedit') || name.includes('bulkedit')) return 'multi'
  if (
    name.includes('applypatch') || name.includes('applydiff') || name.includes('patchfile') ||
    name === 'patch' || name === 'diff' || name === 'replace' || name === 'replacestring' ||
    name.endsWith('replacefile') || name.endsWith('applypatch')
  ) return 'patch'
  if (
    name === 'write' || name.includes('writefile') || name.includes('createfile') || name.includes('newfile') ||
    name.includes('savefile') || name.includes('notebookedit') || name.includes('overwritefile') || name.includes('writetofile')
  ) return 'write'
  if (
    name === 'edit' || name === 'applyedit' || name.includes('editfile') || name.includes('editfilechunk') ||
    name.includes('strreplace') || name.includes('stringreplace') || name.includes('replaceinfile') ||
    name.includes('updatefile') || name.includes('editnotebook')
  ) return 'edit'
  return 'unknown'
}

function pickString(obj: Rec | undefined, keys: readonly string[], allowEmpty = false): string | undefined {
  if (!obj) return undefined
  for (const key of keys) {
    const value = obj[key]
    if (typeof value === 'string' && (allowEmpty || value.length > 0)) return value
  }
  return undefined
}

function truncateString(value: string): { value: string; truncated: boolean } {
  if (value.length <= EDIT_FIELD_LIMIT) return { value, truncated: false }
  let end = EDIT_FIELD_LIMIT
  // 不劈开代理对（emoji 等）：半个代理对会让落盘 JSON / 渲染层拿到非法字符
  const code = value.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) end -= 1
  return { value: value.slice(0, end), truncated: true }
}

function buildMeta(file: string, additions: number, deletions: number, parts: { content?: string; oldString?: string; newString?: string }): ToolEditMeta {
  const meta: ToolEditMeta = { file, additions, deletions }
  let truncated = false
  const take = (value: string | undefined): string | undefined => {
    if (value === undefined) return undefined
    const result = truncateString(value)
    if (result.truncated) truncated = true
    return result.value
  }
  const content = take(parts.content)
  if (content !== undefined) meta.content = content
  const oldString = take(parts.oldString)
  if (oldString !== undefined) meta.oldString = oldString
  const newString = take(parts.newString)
  if (newString !== undefined) meta.newString = newString
  if (truncated) meta.truncated = true
  return meta
}

/** Write / NotebookEdit 类：file_path|path + content */
function fromWriteContent(obj: Rec | undefined): ToolEditMeta | null {
  if (!obj) return null
  const file = pickString(obj, FILE_KEYS)
  const content = pickString(obj, CONTENT_KEYS, true)
  if (!file || content === undefined) return null
  return buildMeta(file, countEditLines(content), 0, { content })
}

/** Edit / str_replace 类：file_path + old_string/new_string；strict = 工具名未识别时只认强键 */
function fromOldNew(obj: Rec | undefined, strict = false): ToolEditMeta | null {
  if (!obj) return null
  const oldString = pickString(obj, strict ? OLD_STRONG_KEYS : OLD_KEYS, true)
  const newString = pickString(obj, strict ? NEW_STRONG_KEYS : NEW_KEYS, true)
  if (oldString === undefined && newString === undefined) return null
  const additions = countEditLines(newString ?? '')
  const deletions = countEditLines(oldString ?? '')
  // 两边都空 = 没有实际改动，不值得挂角标
  if (!additions && !deletions) return null
  const file = pickString(obj, FILE_KEYS)
  if (!file) return null
  return buildMeta(file, additions, deletions, { oldString, newString })
}

/** MultiEdit 类：edits[] 逐项累加，newString 多段拼接 */
function fromEditsArray(obj: Rec | undefined): ToolEditMeta | null {
  const edits = obj?.edits
  if (!Array.isArray(edits) || edits.length === 0) return null
  const first = isRecord(edits[0]) ? edits[0] : undefined
  const file = pickString(obj, FILE_KEYS) ?? pickString(first, FILE_KEYS)
  if (!file) return null
  let additions = 0
  let deletions = 0
  const segments: string[] = []
  for (const item of edits) {
    if (!isRecord(item)) continue
    const oldString = pickString(item, OLD_KEYS, true)
    const newString = pickString(item, NEW_KEYS, true)
    additions += countEditLines(newString ?? '')
    deletions += countEditLines(oldString ?? '')
    if (newString) segments.push(newString)
  }
  if (!additions && !deletions) return null
  // 多段拼接后再统一按上限截断（单段超长同样被截）
  return buildMeta(file, additions, deletions, { newString: segments.length ? segments.join('\n') : undefined })
}

function patchFileOf(text: string, obj: Rec | undefined): string | undefined {
  const unquote = (value: string | undefined): string | undefined => {
    if (!value) return undefined
    const trimmed = value.trim().replace(/^"(.*)"$/, '$1')
    return trimmed && trimmed !== '/dev/null' ? trimmed : undefined
  }
  const patterns = [
    /^\*\*\* (?:Update|Add|Delete) File: (.+)$/m,
    /^\*\*\* (?:Move to|Rename to): (.+)$/m,
    /^\+\+\+ (?:b\/)?(.+)$/m,
    /^--- (?:a\/)?(.+)$/m,
    /^diff --git a\/(.+?) b\//m,
    /^Index: (.+)$/m
  ]
  for (const pattern of patterns) {
    const matched = unquote(pattern.exec(text)?.[1])
    if (matched) return matched
  }
  return pickString(obj, FILE_KEYS)
}

/** patch 文本里的 +/- 行统计（以 patch 文本为权威） */
function countPatchLines(text: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  let inHunk = false
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (line.startsWith('***')) {
      inHunk = true // codex patch 段头；其正文行只带一个 +/- 前缀
      continue
    }
    if (line.startsWith('@@')) {
      inHunk = true
      continue
    }
    if (/^(?:diff |index |Index: |new file mode|deleted file mode|similarity index|rename |old mode|new mode)/.test(line)) {
      inHunk = false // 多文件 unified diff：下一个文件从文件头重新开始
      continue
    }
    if (!inHunk && (line.startsWith('--- ') || line.startsWith('+++ '))) continue // 文件头
    if (line.startsWith('\\')) continue // "\ No newline at end of file"
    if (line.startsWith('+')) additions++
    else if (line.startsWith('-')) deletions++
  }
  return { additions, deletions }
}

function isPatchText(text: string): boolean {
  return PATCH_MARKER.test(text) || HUNK_MARKER.test(text) || UNIFIED_HEADER.test(text)
}

/** apply_patch / diff / replace 类：从 patch 文本统计 */
function fromPatchText(obj: Rec | undefined, raw: string): ToolEditMeta | null {
  const candidates: string[] = []
  if (raw) candidates.push(raw)
  for (const key of PATCH_TEXT_KEYS) {
    const value = obj?.[key]
    if (typeof value === 'string' && value) candidates.push(value)
  }
  for (const text of candidates) {
    if (!isPatchText(text)) continue
    const file = patchFileOf(text, obj)
    if (!file) continue
    const { additions, deletions } = countPatchLines(text)
    if (!additions && !deletions) continue
    return buildMeta(file, additions, deletions, {})
  }
  return null
}

/**
 * 工具事件 → `data.edit` 元数据。非编辑类工具 / 参数不可解析 → null，绝不 throw。
 * @param toolName 工具名（zcode 取 payload.toolName，claude/codex/opencode 取 part.tool / item.name）
 * @param rawArgs  **未截断**的原始入参（JSON 字符串；codex 的 Bash 为原始命令文本）
 */
export function parseEditMeta(toolName: string, rawArgs?: string | null): ToolEditMeta | null {
  try {
    const kind = classifyToolName(typeof toolName === 'string' ? toolName : '')
    const raw = typeof rawArgs === 'string' ? rawArgs : ''
    if (!raw) return null
    const parsed = tryParseJson(raw)
    const obj = isRecord(parsed) ? parsed : undefined

    // patch 文本自描述：名称命中 patch 类，或名称未识别时靠特征兜底（codex Bash apply_patch）
    if (kind === 'patch' || kind === 'unknown') {
      const patch = fromPatchText(obj, raw)
      if (patch) return patch
    }
    if (kind === 'multi' || kind === 'unknown') {
      const multi = fromEditsArray(obj)
      if (multi) return multi
    }
    // patch 类名但文本里没有 patch 特征时，继续按 old/new、content 形状兜底
    if (kind === 'edit' || kind === 'multi' || kind === 'unknown' || kind === 'patch') {
      // 工具名未识别时只认"字面就是编辑语义"的强键（old/new 系列）
      const edit = fromOldNew(obj, kind === 'unknown')
      if (edit) return edit
    }
    // 未识别工具不做"file + content"兜底：那会把普通工具的正文参数误判成写文件
    if (kind === 'write' || kind === 'edit' || kind === 'patch') {
      const write = fromWriteContent(obj)
      if (write) return write
    }
    return null
  } catch {
    return null
  }
}
