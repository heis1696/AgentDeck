// 工作区通道：派单前「看清目录现在长什么样」的只读探测。
// 权限边界与 dialog:pick-dir / shell:open 同级——目录都来自用户选择或任务绑定，不做任意遍历。
import fs from 'node:fs'
import { ipcMain } from 'electron'
import { workspaceGitSummary } from '../git'
import { listWorkspaceEntries } from '../workspace-listing'
import type { WorkspaceEntriesResult, WorkspaceGitSummary } from '../../shared/contracts'

function badDir(dir: unknown, reason: string): WorkspaceGitSummary {
  return { ok: false, code: 'bad-dir', error: `工作目录不可用：${reason}` }
}

/** 基目录校验（gitSummary / listEntries 共用）：非空字符串、无空字节、不超长、存在且是目录 */
function validBaseDir(dir: unknown): { ok: true; value: string } | { ok: false; reason: string } {
  if (typeof dir !== 'string' || !dir.trim()) return { ok: false, reason: '路径为空' }
  const target = dir.trim()
  if (target.includes('\0')) return { ok: false, reason: '路径含空字节' }
  if (target.length > 400) return { ok: false, reason: '路径超长' }
  let stat: fs.Stats
  try {
    stat = fs.statSync(target)
  } catch {
    return { ok: false, reason: '目录不存在或不可访问' }
  }
  if (!stat.isDirectory()) return { ok: false, reason: '不是目录' }
  return { ok: true, value: target }
}

export function registerWorkspaceIpc() {
  // 渲染契约：workspace:gitSummary(dir) —— 分支/领先落后/未提交计数（暂存/未暂存/未跟踪）/最近提交。
  //   非仓库 → ok:false code:'not-a-repo'（UI 灰态「非 git 仓库，可正常派单」，不报错）；
  //   目录不存在/不是目录/含空字节/超长 → bad-dir；git 探测失败 → git-failed。一律不 reject。
  ipcMain.handle('workspace:gitSummary', (_e, dir: unknown): Promise<WorkspaceGitSummary> => {
    const base = validBaseDir(dir)
    if (!base.ok) return Promise.resolve(badDir(dir, base.reason))
    return workspaceGitSummary(base.value)
  })

  // 渲染契约：workspace:listEntries(dir, subdir) —— @ 文件引用补全的目录清单。
  //   subdir 必须相对且不越出 base（.. / 绝对路径 / 盘符差异全拒）；重目录名单跳过、上限截断。
  //   失败一律 ok:false 带码，不 reject。
  ipcMain.handle('workspace:listEntries', (_e, dir: unknown, subdir: unknown): WorkspaceEntriesResult => {
    const base = validBaseDir(dir)
    if (!base.ok) return { ok: false, code: 'bad-dir', error: `工作目录不可用：${base.reason}`, entries: [] }
    return listWorkspaceEntries(base.value, typeof subdir === 'string' ? subdir : '')
  })
}
