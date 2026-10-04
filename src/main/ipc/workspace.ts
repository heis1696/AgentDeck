// 工作区通道：派单前「看清目录现在长什么样」的只读探测。
// 权限边界与 dialog:pick-dir / shell:open 同级——目录都来自用户选择或任务绑定，不做任意遍历。
import fs from 'node:fs'
import { ipcMain } from 'electron'
import { workspaceGitSummary } from '../git'
import type { WorkspaceGitSummary } from '../../shared/contracts'

function badDir(dir: unknown, reason: string): WorkspaceGitSummary {
  return { ok: false, code: 'bad-dir', error: `工作目录不可用：${reason}` }
}

export function registerWorkspaceIpc() {
  // 渲染契约：workspace:gitSummary(dir) —— 分支/领先落后/未提交计数（暂存/未暂存/未跟踪）/最近提交。
  //   非仓库 → ok:false code:'not-a-repo'（UI 灰态「非 git 仓库，可正常派单」，不报错）；
  //   目录不存在/不是目录/含空字节/超长 → bad-dir；git 探测失败 → git-failed。一律不 reject。
  ipcMain.handle('workspace:gitSummary', (_e, dir: unknown): Promise<WorkspaceGitSummary> => {
    if (typeof dir !== 'string' || !dir.trim()) return Promise.resolve(badDir(dir, '路径为空'))
    const target = dir.trim()
    if (target.includes('\0')) return Promise.resolve(badDir(target, '路径含空字节'))
    if (target.length > 400) return Promise.resolve(badDir(target, '路径超长'))
    let stat: fs.Stats
    try {
      stat = fs.statSync(target)
    } catch {
      return Promise.resolve(badDir(target, '目录不存在或不可访问'))
    }
    if (!stat.isDirectory()) return Promise.resolve(badDir(target, '不是目录'))
    return workspaceGitSummary(target)
  })
}
