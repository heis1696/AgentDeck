// 共享目录 Hook 库：<root>/hooks/<name>/（HOOK.md frontmatter 说明文档 + hook.json 事件定义）
// （纯 Node，目录由参数注入；frontmatter 解析复用 skills.ts，序列化同款格式本地实现）
import fs from 'node:fs'
import path from 'node:path'
import type { HookDef, HookDetail, HookGroup, HookMeta } from '../shared/extensions'
import { assertInside, isValidSkillName, parseFrontmatter } from './skills'

/** 事件名（如 PreToolUse/PostToolUse/Stop…） */
const EVENT_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/

function assertName(name: string): string {
  if (typeof name !== 'string' || !isValidSkillName(name)) throw new Error(`Hook 名非法（需匹配 ${/^[a-z0-9][a-z0-9._-]{0,127}$/.source}）: ${name}`)
  return name
}

export function hooksDir(root: string): string {
  return path.join(root, 'hooks')
}

function hookDir(root: string, name: string): string {
  const dir = path.join(hooksDir(root), assertName(name))
  // 纵深防御：即使 name 合法，也确认解析结果仍在共享目录内
  assertInside(hooksDir(root), dir)
  return dir
}

/** events 校验：事件名非空且合法；值为匹配组数组，组内拒绝未知字段 */
export function assertHookEvents(value: unknown): Record<string, HookGroup[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('events 必须是对象')
  const input = value as Record<string, unknown>
  const result: Record<string, HookGroup[]> = {}
  for (const [event, groups] of Object.entries(input)) {
    if (!EVENT_NAME_PATTERN.test(event)) throw new Error(`事件名非法: ${JSON.stringify(event)}`)
    if (!Array.isArray(groups)) throw new Error(`events.${event} 必须是数组`)
    result[event] = groups.map((group, index): HookGroup => {
      if (!group || typeof group !== 'object' || Array.isArray(group)) throw new Error(`events.${event}[${index}] 必须是对象`)
      const raw = group as Record<string, unknown>
      for (const key of Object.keys(raw)) {
        if (key !== 'matcher' && key !== 'hooks') throw new Error(`events.${event}[${index}] 包含未知字段: ${key}`)
      }
      if (raw.matcher !== undefined && (typeof raw.matcher !== 'string' || !raw.matcher)) throw new Error(`events.${event}[${index}].matcher 必须是非空字符串`)
      if (!Array.isArray(raw.hooks)) throw new Error(`events.${event}[${index}].hooks 必须是数组`)
      const hooks = raw.hooks.map((entry, hookIndex) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`events.${event}[${index}].hooks[${hookIndex}] 必须是对象`)
        const hook = entry as Record<string, unknown>
        for (const key of Object.keys(hook)) {
          if (key !== 'type' && key !== 'command' && key !== 'timeoutMs') throw new Error(`events.${event}[${index}].hooks[${hookIndex}] 包含未知字段: ${key}`)
        }
        if (hook.type !== 'command') throw new Error(`events.${event}[${index}].hooks[${hookIndex}].type 必须是 command`)
        if (typeof hook.command !== 'string' || !hook.command.trim()) throw new Error(`events.${event}[${index}].hooks[${hookIndex}].command 必须是非空字符串`)
        if (hook.timeoutMs !== undefined && (typeof hook.timeoutMs !== 'number' || !Number.isFinite(hook.timeoutMs) || hook.timeoutMs <= 0)) {
          throw new Error(`events.${event}[${index}].hooks[${hookIndex}].timeoutMs 必须是正数`)
        }
        return hook.timeoutMs === undefined
          ? { type: 'command' as const, command: hook.command }
          : { type: 'command' as const, command: hook.command, timeoutMs: hook.timeoutMs }
      })
      return raw.matcher === undefined ? { hooks } : { matcher: raw.matcher, hooks }
    })
  }
  return result
}

function serializeFrontmatter(name: string, description: string): string {
  const lines = ['---', `name: ${name}`]
  if (description.trim()) lines.push(`description: ${description.trim().replace(/\r?\n/g, ' ')}`)
  lines.push('---')
  return lines.join('\n')
}

function toMeta(root: string, name: string): HookMeta | null {
  const dir = path.join(hooksDir(root), name)
  let raw: string
  let eventsRaw: string
  try {
    raw = fs.readFileSync(path.join(dir, 'HOOK.md'), 'utf8')
    eventsRaw = fs.readFileSync(path.join(dir, 'hook.json'), 'utf8')
  } catch {
    return null
  }
  let parsed: HookDef
  try {
    parsed = JSON.parse(eventsRaw) as HookDef
  } catch {
    return null
  }
  let updatedAt = 0
  try {
    updatedAt = fs.statSync(path.join(dir, 'HOOK.md')).mtimeMs
  } catch {}
  const { data } = parseFrontmatter(raw)
  return {
    name,
    description: data.description ?? '',
    events: parsed.events ?? {},
    dir,
    updatedAt
  }
}

/** 列出共享目录全部 Hook（名字升序；缺文件或非法名目录跳过） */
export function listHooks(root: string): HookMeta[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(hooksDir(root), { withFileTypes: true })
  } catch {
    return []
  }
  const metas: HookMeta[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !isValidSkillName(entry.name)) continue
    const meta = toMeta(root, entry.name)
    if (meta) metas.push(meta)
  }
  return metas.sort((a, b) => a.name.localeCompare(b.name))
}

/** 读取 Hook 详情（body 为 HOOK.md 去 frontmatter 后正文）；不存在返回 null */
export function readHook(root: string, name: string): HookDetail | null {
  const meta = toMeta(root, name)
  if (!meta) return null
  const raw = fs.readFileSync(path.join(meta.dir, 'HOOK.md'), 'utf8')
  return { name: meta.name, description: meta.description, events: meta.events, body: parseFrontmatter(raw).body }
}

/** 写入 HOOK.md + hook.json（均 tmp + rename）；originName 存在 = 重命名（目录改名，附加文件跟随），冲突报错 */
export function saveHook(
  root: string,
  name: string,
  input: { description: string; body: string; events: Record<string, HookGroup[]>; originName?: string }
): HookMeta {
  assertName(name)
  if (typeof input.description !== 'string' || typeof input.body !== 'string') throw new Error('description/body 必须是字符串')
  const events = assertHookEvents(input.events)
  const sourceName = input.originName === undefined ? name : assertName(input.originName)
  const target = hookDir(root, name)
  if (sourceName !== name) {
    if (fs.existsSync(target)) throw new Error(`Hook 目录已存在，无法重命名: ${name}`)
    const source = hookDir(root, sourceName)
    if (fs.existsSync(source)) {
      // 整目录改名，附加文件跟随
      fs.mkdirSync(hooksDir(root), { recursive: true })
      fs.renameSync(source, target)
    }
  }
  fs.mkdirSync(target, { recursive: true })
  const hookFile = path.join(target, 'HOOK.md')
  const hookContent = `${serializeFrontmatter(name, input.description)}\n\n${input.body.replace(/^\n+/, '')}`
  const tmpMd = `${hookFile}.tmp`
  fs.writeFileSync(tmpMd, hookContent)
  fs.renameSync(tmpMd, hookFile)
  const jsonFile = path.join(target, 'hook.json')
  const tmpJson = `${jsonFile}.tmp`
  fs.writeFileSync(tmpJson, JSON.stringify({ events }, null, 2) + '\n')
  fs.renameSync(tmpJson, jsonFile)
  const meta = toMeta(root, name)
  if (!meta) throw new Error(`Hook 保存后读取失败: ${name}`)
  return meta
}

/** 删除 Hook 目录（幂等） */
export function deleteHook(root: string, name: string): void {
  fs.rmSync(hookDir(root, name), { recursive: true, force: true })
}
