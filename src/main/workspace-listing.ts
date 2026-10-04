// 工作区目录清单（@ 文件引用的补全数据源）+ 文件读取（文件浏览 tab）：纯 fs、零 electron 依赖，可独立冒烟。
// 边界：subdir/path 必须是相对段且不得越出 base；重目录按名单跳过；单目录条目上限防大仓卡顿。
import fs from 'node:fs'
import path from 'node:path'
import type { WorkspaceEntriesResult, WorkspaceFileRead } from '../shared/contracts'

/** 单目录条目上限：超出置 truncated（补全面板照常工作，只是不无限列） */
export const WORKSPACE_LISTING_CAP = 500

/** 重目录跳过名单：这些目录对「给 agent 圈文件上下文」没有价值且动辄上万条 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', 'coverage', 'release', '.agentdeck-worktrees', '.agentdeck-reports'])

function bad(code: WorkspaceEntriesResult['code'], error: string): WorkspaceEntriesResult {
  return { ok: false, code, error, entries: [], truncated: false }
}

/** 列 base/subdir 的直接子项：目录在前文件在后、字典序；不读 .gitignore（名单制跳过重目录） */
export function listWorkspaceEntries(baseDir: string, subdir: string): WorkspaceEntriesResult {
  const relative = subdir.trim().replace(/\\/g, '/')
  if (relative.includes('\0')) return bad('bad-subdir', '子目录路径含空字节')
  if (path.isAbsolute(relative)) return bad('bad-subdir', '子目录必须是相对路径')
  const segments = relative.split('/').filter((segment) => segment.length > 0)
  if (segments.some((segment) => segment === '..')) return bad('bad-subdir', '子目录不允许包含 ..')
  const base = path.resolve(baseDir)
  const target = path.resolve(base, ...segments)
  // 双保险：拼出来的目标必须仍在 base 内（Windows 盘符差异等极端写法在此拦下）
  const containment = path.relative(base, target)
  if (containment.startsWith('..') || path.isAbsolute(containment)) return bad('escapes-root', '子目录越出工作区根目录')
  let dirents: fs.Dirent[]
  try {
    dirents = fs.readdirSync(target, { withFileTypes: true })
  } catch (cause) {
    return bad('list-failed', cause instanceof Error ? cause.message : String(cause))
  }
  const dirs: Array<{ name: string; kind: 'dir' }> = []
  const files: Array<{ name: string; kind: 'file' }> = []
  for (const dirent of dirents) {
    if (dirent.isDirectory()) {
      if (SKIP_DIRS.has(dirent.name)) continue
      dirs.push({ name: dirent.name, kind: 'dir' })
    } else if (dirent.isFile()) {
      files.push({ name: dirent.name, kind: 'file' })
    }
  }
  // 补全面板的字典序按不区分大小写排（README 与 readme 同级时退回码点序保证稳定）
  const byName = (a: { name: string }, b: { name: string }) => {
    const la = a.name.toLowerCase()
    const lb = b.name.toLowerCase()
    if (la !== lb) return la < lb ? -1 : 1
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  }
  const entries = [...dirs.sort(byName), ...files.sort(byName)]
  const truncated = entries.length > WORKSPACE_LISTING_CAP
  return { ok: true, entries: truncated ? entries.slice(0, WORKSPACE_LISTING_CAP) : entries, truncated }
}

/** 文件读取上限：超出拒绝（CodeViewer 分页渲染的上界，也防误点大文件卡 IO） */
export const WORKSPACE_READ_CAP = 512 * 1024

/** 二进制嗅探窗口：前 8KB 出现 NUL 字节即判二进制（git 同款启发式） */
const BINARY_SNIFF = 8 * 1024

function badRead(code: WorkspaceFileRead['code'], error: string, rel: string): WorkspaceFileRead {
  return { ok: false, code, error, path: rel }
}

/** 读 base/relative 的文本内容：realpath 双向解析防符号链接逃逸，512KB 上限，NUL 嗅探拒二进制 */
export function readWorkspaceFile(baseDir: string, relative: string): WorkspaceFileRead {
  const rel = relative.trim().replace(/\\/g, '/')
  if (rel.includes('\0')) return badRead('bad-path', '文件路径含空字节', rel)
  if (path.isAbsolute(rel)) return badRead('bad-path', '文件路径必须是相对路径', rel)
  const segments = rel.split('/').filter((segment) => segment.length > 0)
  if (segments.some((segment) => segment === '..')) return badRead('bad-path', '文件路径不允许包含 ..', rel)
  if (!segments.length) return badRead('bad-path', '文件路径为空', rel)
  const base = fs.realpathSync(fs.existsSync(baseDir) ? baseDir : path.resolve(baseDir))
  const joined = path.resolve(base, ...segments)
  let real: string
  try {
    real = fs.realpathSync(joined)
  } catch {
    return badRead('missing', '文件不存在或不可访问', rel)
  }
  // realpath 后仍在 base 内：符号链接指向工作区外的逃逸在此拦下
  const containment = path.relative(base, real)
  if (containment.startsWith('..') || path.isAbsolute(containment)) return badRead('escapes-root', '文件越出工作区根目录', rel)
  let stat: fs.Stats
  try {
    stat = fs.statSync(real)
  } catch {
    return badRead('missing', '文件不可访问', rel)
  }
  if (stat.isDirectory()) return badRead('bad-path', '目标是目录，不是文件', rel)
  if (stat.size > WORKSPACE_READ_CAP) {
    return badRead('too-large', `文件超过 ${(WORKSPACE_READ_CAP / 1024) | 0}KB 上限（实际 ${(stat.size / 1024) | 0}KB）`, rel)
  }
  let buffer: Buffer
  try {
    buffer = fs.readFileSync(real)
  } catch (cause) {
    return badRead('read-failed', cause instanceof Error ? cause.message : String(cause), rel)
  }
  if (buffer.subarray(0, BINARY_SNIFF).includes(0)) {
    return { ok: true, code: 'binary', path: rel, size: stat.size }
  }
  return { ok: true, path: rel, content: buffer.toString('utf8'), size: stat.size }
}
