import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, FileText, FolderOpen, Folder, RefreshCw } from 'lucide-react'
import { ui } from '../../ui/interaction-center'
import { workspaceListEntries, workspaceReadFile } from '../../api'
import type { WorkspaceEntry } from '../../../../shared/contracts'

/**
 * 工作区文件树（SideDock 浏览 tab）：任务产物不出应用就能看——
 * 目录懒加载展开（复用 workspace:listEntries，重目录名单跳过），文件点击读取内容
 * （workspace:readFile，realpath 防逃逸 + 512KB 上限 + 二进制嗅探）并以 file 页签
 * 打开（CodeViewer 语法高亮）。刷新按钮清缓存重拉（agent 执行后想看新产物）。
 */
export function FilesPane({ taskId, workdir }: { taskId: string; workdir: string }) {
  const [cache, setCache] = useState(new Map<string, WorkspaceEntry[]>())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState<string | null>(null)
  const [opening, setOpening] = useState<string | null>(null)
  const rootName = useMemo(() => workdir.split(/[\\/]/).filter(Boolean).pop() ?? workdir, [workdir])

  const load = useCallback(async (subdir: string) => {
    setLoading(subdir)
    try {
      const result = await workspaceListEntries(workdir, subdir)
      setCache((current) => new Map(current).set(subdir, result.ok ? result.entries : []))
      return result.ok
    } catch {
      setCache((current) => new Map(current).set(subdir, []))
      return false
    } finally {
      setLoading(null)
    }
  }, [workdir])

  useEffect(() => { void load('') }, [load])

  const toggle = (path: string) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
    if (!cache.has(path)) void load(path)
  }

  const openFile = async (path: string) => {
    if (opening) return
    setOpening(path)
    try {
      const result = await workspaceReadFile(workdir, path)
      const name = path.split('/').pop() ?? path
      if (!result.ok) {
        ui.toast.error(`无法读取 ${name}：${result.error ?? result.code ?? '失败'}`)
        return
      }
      if (result.code === 'binary') {
        ui.dock.open({ id: `file:${taskId}:${path}`, kind: 'file', title: name, payload: { taskId, file: path, additions: 0, deletions: 0, binary: true, diffNote: `二进制文件 · ${result.size ?? 0} B` } })
        return
      }
      ui.dock.open({ id: `file:${taskId}:${path}`, kind: 'file', title: name, payload: { taskId, file: path, additions: 0, deletions: 0, content: result.content, truncated: result.truncated } })
    } catch (cause) {
      ui.toast.error(cause instanceof Error ? cause.message : '读取失败')
    } finally {
      setOpening(null)
    }
  }

  const renderDir = (subdir: string, depth: number): React.ReactNode => {
    const entries = cache.get(subdir)
    if (!entries) return null
    const prefix = subdir ? `${subdir}/` : ''
    return entries.map((entry) => entry.kind === 'dir'
      ? <div key={entry.name} className="files-node">
          <button type="button" className="files-row files-dir" style={{ paddingLeft: 8 + depth * 14 }} aria-expanded={expanded.has(prefix + entry.name)} onClick={() => toggle(prefix + entry.name)}>
            {expanded.has(prefix + entry.name) ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
            <Folder size={13} aria-hidden="true" />
            <span className="files-name">{entry.name}</span>
          </button>
          {expanded.has(prefix + entry.name) && (loading === prefix + entry.name
            ? <div className="files-status" style={{ paddingLeft: 8 + (depth + 1) * 14 }}>加载中…</div>
            : renderDir(prefix + entry.name, depth + 1))}
        </div>
      : <button type="button" key={entry.name} className="files-row files-file" style={{ paddingLeft: 8 + depth * 14 + 16 }} title={`${prefix}${entry.name}`} disabled={opening === prefix + entry.name} onClick={() => void openFile(prefix + entry.name)}>
          <FileText size={13} aria-hidden="true" />
          <span className="files-name">{entry.name}</span>
          {opening === prefix + entry.name && <span className="files-status-inline">读取中…</span>}
        </button>)
  }

  const rootEntries = cache.get('')
  return <div className="files-pane" aria-label="工作区文件树">
    <div className="files-head">
      <FolderOpen size={13} aria-hidden="true" />
      <span className="files-root mono" title={workdir}>{rootName}</span>
      <button type="button" className="icon-btn files-refresh" title="刷新（清缓存重拉，agent 执行后看新产物）" aria-label="刷新文件树" onClick={() => { setCache(new Map()); setExpanded(new Set()); void load('') }}><RefreshCw size={12} aria-hidden="true" /></button>
    </div>
    <div className="files-tree" role="tree" aria-label={rootName}>
      {!rootEntries && <div className="files-status">加载中…</div>}
      {rootEntries && rootEntries.length === 0 && <div className="files-status">空目录（或不可读）</div>}
      {renderDir('', 0)}
    </div>
  </div>
}
