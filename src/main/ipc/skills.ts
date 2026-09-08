// 技能库 IPC：共享目录 CRUD/导入 + 安装目标同步（渲染层先 dialog:pick-dir 选目录再 import）
import { ipcMain } from 'electron'
import os from 'node:os'
import { deleteSkill, ensureSharedDir, importSkill, listSkills, readSkill, saveSkill } from '../skills'
import { installSkill, resolveSkillTargets, skillSyncState, uninstallSkill } from '../skill-targets'
import { parseContent, parseId } from '../ipc-validation'
import type { IpcContext } from './context'

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 必须是对象`)
  return value as Record<string, unknown>
}

function assertKeys(input: Record<string, unknown>, allowed: readonly string[], label: string) {
  const keys = new Set(allowed)
  for (const key of Object.keys(input)) if (!keys.has(key)) throw new Error(`${label}包含未知字段: ${key}`)
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`${label} 必须是字符串`)
  return value
}

export function registerSkillsIpc(ctx: IpcContext) {
  ipcMain.handle('skills:list', () => {
    ensureSharedDir(ctx.sharedDir)
    return { root: ctx.sharedDir, skills: listSkills(ctx.sharedDir) }
  })
  ipcMain.handle('skills:get', (_e, name: unknown) => {
    ensureSharedDir(ctx.sharedDir)
    return readSkill(ctx.sharedDir, parseId(name, 'name'))
  })
  ipcMain.handle('skills:save', (_e, name: unknown, input: unknown) => {
    const body = record(input, '技能参数')
    assertKeys(body, ['description', 'body', 'originName'], '技能参数')
    const description = optionalString(body.description, 'description')
    const content = optionalString(body.body, 'body')
    if (description === undefined || content === undefined) throw new Error('description/body 不能缺省')
    return saveSkill(ctx.sharedDir, parseId(name, 'name'), {
      description,
      body: content,
      ...(body.originName !== undefined ? { originName: optionalString(body.originName, 'originName') } : {})
    })
  })
  ipcMain.handle('skills:delete', (_e, name: unknown) => {
    deleteSkill(ctx.sharedDir, parseId(name, 'name'))
    return { ok: true }
  })
  ipcMain.handle('skills:import', (_e, sourcePath: unknown) => {
    const source = parseContent(sourcePath, 'sourcePath')
    return importSkill(ctx.sharedDir, source)
  })
  ipcMain.handle('skills:targets', () => {
    ensureSharedDir(ctx.sharedDir)
    const targets = resolveSkillTargets(os.homedir())
    const states: Record<string, Record<string, string>> = {}
    for (const skill of listSkills(ctx.sharedDir)) {
      states[skill.name] = Object.fromEntries(
        targets.map((target) => [target.id, skillSyncState(skill.dir, target.dir, skill.name)])
      )
    }
    return { targets, states }
  })
  ipcMain.handle('skills:install', (_e, name: unknown, targetId: unknown) => {
    installSkill(ctx.sharedDir, parseId(targetId, 'targetId'), parseId(name, 'name'))
    return { ok: true }
  })
  ipcMain.handle('skills:uninstall', (_e, name: unknown, targetId: unknown) => {
    uninstallSkill(parseId(targetId, 'targetId'), parseId(name, 'name'), os.homedir())
    return { ok: true }
  })
  ipcMain.handle('skills:open-dir', async () => {
    ensureSharedDir(ctx.sharedDir)
    const { shell } = await import('electron')
    await shell.openPath(ctx.sharedDir)
  })
}
