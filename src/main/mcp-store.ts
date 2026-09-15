// 共享目录 MCP 服务器库：<root>/mcp/<name>.mcp.json，每项一个 JSON 文件
// （纯 Node，不 import electron，目录由参数注入——便于 smoke 测试；名字/逃逸校验沿用 skills.ts 风格）
import fs from 'node:fs'
import path from 'node:path'
import type { McpDef, McpMeta, McpTransport } from '../shared/extensions'
import { assertInside, isValidSkillName } from './skills'

function assertName(name: string): string {
  if (typeof name !== 'string' || !isValidSkillName(name)) throw new Error(`MCP 服务器名非法（需匹配 ${/^[a-z0-9][a-z0-9._-]{0,127}$/.source}）: ${name}`)
  return name
}

export function mcpDir(root: string): string {
  return path.join(root, 'mcp')
}

function mcpFile(root: string, name: string): string {
  const file = path.join(mcpDir(root), `${assertName(name)}.mcp.json`)
  // 纵深防御：即使 name 合法，也确认解析结果仍在共享目录内
  assertInside(mcpDir(root), file)
  return file
}

/** 字符串表：键值都必须是字符串（env/headers 共用） */
function assertStringTable(value: unknown, label: string): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 必须是字符串表`)
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') throw new Error(`${label}.${key} 必须是字符串`)
  }
  return value as Record<string, string>
}

/** transport 校验：stdio 必有 command；http/sse 必有 url；拒绝未知 type 与未知字段 */
export function assertMcpTransport(value: unknown): McpTransport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('transport 必须是对象')
  const input = value as Record<string, unknown>
  const type = input.type
  if (type !== 'stdio' && type !== 'http' && type !== 'sse') throw new Error(`transport.type 必须是 stdio/http/sse: ${String(type)}`)
  if (type === 'stdio') {
    for (const key of Object.keys(input)) {
      if (key !== 'type' && key !== 'command' && key !== 'args' && key !== 'env' && key !== 'cwd') throw new Error(`stdio transport 包含未知字段: ${key}`)
    }
    if (typeof input.command !== 'string' || !input.command.trim()) throw new Error('stdio transport.command 必须是非空字符串')
    if (input.args !== undefined) {
      if (!Array.isArray(input.args) || input.args.some((item) => typeof item !== 'string')) throw new Error('transport.args 必须是字符串数组')
    }
    if (input.env !== undefined) assertStringTable(input.env, 'transport.env')
    if (input.cwd !== undefined && typeof input.cwd !== 'string') throw new Error('transport.cwd 必须是字符串')
  } else {
    for (const key of Object.keys(input)) {
      if (key !== 'type' && key !== 'url' && key !== 'headers') throw new Error(`${type} transport 包含未知字段: ${key}`)
    }
    if (typeof input.url !== 'string' || !input.url.trim()) throw new Error(`${type} transport.url 必须是非空字符串`)
    if (input.headers !== undefined) assertStringTable(input.headers, 'transport.headers')
  }
  return input as unknown as McpTransport
}

function assertDescription(description: unknown): string {
  if (typeof description !== 'string') throw new Error('description 必须是字符串')
  return description
}

function toMeta(root: string, name: string): McpMeta | null {
  const file = path.join(mcpDir(root), `${name}.mcp.json`)
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
  let parsed: McpDef
  try {
    parsed = JSON.parse(raw) as McpDef
  } catch {
    return null
  }
  let updatedAt = 0
  try {
    updatedAt = fs.statSync(file).mtimeMs
  } catch {}
  return {
    name,
    description: typeof parsed.description === 'string' ? parsed.description : '',
    transport: parsed.transport,
    file,
    updatedAt
  }
}

/** 列出共享目录全部 MCP 服务器（名字升序；坏文件/非法名跳过） */
export function listMcp(root: string): McpMeta[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(mcpDir(root), { withFileTypes: true })
  } catch {
    return []
  }
  const metas: McpMeta[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.mcp.json')) continue
    const name = entry.name.slice(0, -'.mcp.json'.length)
    if (!isValidSkillName(name)) continue
    const meta = toMeta(root, name)
    if (meta) metas.push(meta)
  }
  return metas.sort((a, b) => a.name.localeCompare(b.name))
}

/** 读取单个 MCP 服务器定义；不存在返回 null */
export function readMcp(root: string, name: string): McpDef | null {
  let raw: string
  try {
    raw = fs.readFileSync(mcpFile(root, name), 'utf8')
  } catch {
    return null
  }
  const parsed = JSON.parse(raw) as McpDef
  return { name: assertName(parsed.name ?? name), description: assertDescription(parsed.description), transport: assertMcpTransport(parsed.transport) }
}

/** 写入 <name>.mcp.json（tmp + rename）；originName 存在 = 重命名（文件改名），目标已存在且与 originName 不同 → 报错 */
export function saveMcp(root: string, def: McpDef, originName?: string): McpMeta {
  const name = assertName(def?.name)
  assertDescription(def.description)
  assertMcpTransport(def.transport)
  const sourceName = originName === undefined ? name : assertName(originName)
  const target = mcpFile(root, name)
  if (sourceName !== name) {
    if (fs.existsSync(target)) throw new Error(`MCP 服务器已存在，无法重命名: ${name}`)
    const source = mcpFile(root, sourceName)
    if (fs.existsSync(source)) {
      fs.mkdirSync(mcpDir(root), { recursive: true })
      fs.renameSync(source, target)
    }
  }
  fs.mkdirSync(mcpDir(root), { recursive: true })
  const content = JSON.stringify({ name, description: def.description, transport: def.transport }, null, 2) + '\n'
  const tmp = `${target}.tmp`
  fs.writeFileSync(tmp, content)
  fs.renameSync(tmp, target)
  const meta = toMeta(root, name)
  if (!meta) throw new Error(`MCP 服务器保存后读取失败: ${name}`)
  return meta
}

/** 删除 <name>.mcp.json（幂等） */
export function deleteMcp(root: string, name: string): void {
  fs.rmSync(mcpFile(root, name), { force: true })
}
