// 技能安装目标注册表与同步状态（纯 Node；home 由参数注入，install 未传时用 os.homedir()）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SkillTarget, SyncState } from '../shared/skills'
import { assertInside, isValidSkillName, skillsDir } from './skills'

/** 固定四项目标：三大 CLI 的用户级技能目录 + 跨工具中立共享位 */
export function resolveSkillTargets(home: string): SkillTarget[] {
  const at = (...segments: string[]) => path.join(home, ...segments)
  return [
    { id: 'claude', label: 'Claude Code', dir: at('.claude', 'skills'), hint: '~/.claude/skills' },
    { id: 'codex', label: 'Codex', dir: at('.codex', 'skills'), hint: '~/.codex/skills' },
    { id: 'zcode', label: 'ZCode', dir: at('.zcode', 'skills'), hint: '~/.zcode/skills' },
    { id: 'agents', label: '跨工具共享', dir: at('.agents', 'skills'), hint: '~/.agents/skills' }
  ]
}

function targetById(home: string, targetId: string): SkillTarget {
  const target = resolveSkillTargets(home).find((item) => item.id === targetId)
  if (!target) throw new Error(`未知安装目标: ${targetId}`)
  return target
}

function assertSkillName(name: string): string {
  if (typeof name !== 'string' || !isValidSkillName(name)) throw new Error(`技能名非法: ${name}`)
  return name
}

/** CRLF→LF 归一后的 Buffer 比较：Windows 换行差异不误报 outdated */
function sameSkillFile(a: Buffer, b: Buffer): boolean {
  const normalize = (buf: Buffer) => buf.toString('utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  return normalize(a) === normalize(b)
}

/** 目标 <targetDir>/<name>/SKILL.md 与源技能目录的 SKILL.md 比较 */
export function skillSyncState(skillDir: string, targetDir: string, name: string): SyncState {
  assertSkillName(name)
  assertInside(targetDir, path.join(targetDir, name))
  let source: Buffer
  try {
    source = fs.readFileSync(path.join(skillDir, 'SKILL.md'))
  } catch {
    return 'missing'
  }
  let installed: Buffer
  try {
    installed = fs.readFileSync(path.join(targetDir, name, 'SKILL.md'))
  } catch {
    return 'missing'
  }
  return sameSkillFile(source, installed) ? 'in-sync' : 'outdated'
}

/** 整目录安装（含附加文件）；目标已存在先删后拷 */
export function installSkill(root: string, targetId: string, name: string, home = os.homedir()): void {
  assertSkillName(name)
  const target = targetById(home, targetId)
  const source = path.join(skillsDir(root), name)
  assertInside(skillsDir(root), source)
  if (!fs.existsSync(path.join(source, 'SKILL.md'))) throw new Error(`技能不存在或缺少 SKILL.md: ${name}`)
  const destination = path.join(target.dir, name)
  assertInside(target.dir, destination)
  fs.rmSync(destination, { recursive: true, force: true })
  fs.mkdirSync(target.dir, { recursive: true })
  fs.cpSync(source, destination, { recursive: true })
}

/** 只删 <target>/<name>/；name 先做合法性校验，目录越界一律拒绝 */
export function uninstallSkill(targetId: string, name: string, home: string): void {
  assertSkillName(name)
  const target = targetById(home, targetId)
  const destination = path.join(target.dir, name)
  assertInside(target.dir, destination)
  fs.rmSync(destination, { recursive: true, force: true })
}
