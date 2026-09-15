// 用户配置安全合并器：把共享目录的 MCP/Hook 资产装/卸到各 CLI 的用户级配置
// 铁律：写任何用户配置前先备份 <file>.agentdeck-bak（已存在 .bak 不覆盖，保住用户最初状态）；
// JSON 配置只增删自己的键、其余键原样保留（引用不动的键，不做深合并覆盖）；codex TOML 用块级文本操作，不引入 toml 依赖
// （纯 Node，home 由参数注入——smoke 全程用假家目录）
import fs from 'node:fs'
import path from 'node:path'
import type { HookGroup, McpTransport } from '../shared/extensions'
import type { SyncState } from '../shared/skills'

/** 备份文件后缀（file + '.agentdeck-bak'） */
export const BACKUP_SUFFIX = '.agentdeck-bak'

export function claudeConfigFile(home: string): string {
  return path.join(home, '.claude.json')
}
export function claudeSettingsFile(home: string): string {
  return path.join(home, '.claude', 'settings.json')
}
export function zcodeConfigFile(home: string): string {
  return path.join(home, '.zcode', 'cli', 'config.json')
}
export function codexConfigFile(home: string): string {
  return path.join(home, '.codex', 'config.toml')
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

/** 读 JSON 配置：不存在 → {}；存在但解析失败 → 抛错（宁可失败也不能把坏内容当空配置覆盖回去） */
export function readJsonSafe(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return {}
  const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
  const record = asRecord(parsed)
  if (!record) throw new Error(`配置文件顶层必须是 JSON 对象: ${file}`)
  return record
}

function backupOnce(file: string): void {
  if (fs.existsSync(file) && !fs.existsSync(file + BACKUP_SUFFIX)) fs.copyFileSync(file, file + BACKUP_SUFFIX)
}

function writeFileAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, content)
  fs.renameSync(tmp, file)
}

/** 备份 + tmp/rename 写回 JSON（keys 保持插入序：仅新增键追加在尾部，原键序不动） */
export function writeJsonWithBackup(file: string, value: unknown): void {
  backupOnce(file)
  writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n')
}

/** 深剥离 undefined 字段（IPC 往返/手写对象都可能带 undefined） */
function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUndefined)
  const record = asRecord(value)
  if (record) {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(record)) if (item !== undefined) out[key] = stripUndefined(item)
    return out
  }
  return value
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]))
  const ra = asRecord(a)
  const rb = asRecord(b)
  if (ra && rb) {
    const keys = Object.keys(ra)
    return keys.length === Object.keys(rb).length && keys.every((key) => key in rb && deepEqual(ra[key], rb[key]))
  }
  return false
}

// === MCP：claude / zcode（JSON） ===

/** claude 写入值 = transport 原样（剥 undefined） */
function claudeMcpValue(transport: McpTransport): Record<string, unknown> {
  return stripUndefined(transport) as Record<string, unknown>
}

/** zcode schema 严格：只写 canonical 字段（stdio: type/command/args/env/cwd；http/sse: type/url/headers），timeoutMs 以外的一切未知字段剥离 */
function zcodeMcpValue(transport: McpTransport): Record<string, unknown> {
  const input = transport as unknown as Record<string, unknown>
  const out: Record<string, unknown> = { type: transport.type }
  if (transport.type === 'stdio') {
    out.command = transport.command
    if (transport.args !== undefined) out.args = transport.args
    if (transport.env !== undefined) out.env = transport.env
    if (transport.cwd !== undefined) out.cwd = transport.cwd
  } else {
    out.url = transport.url
    if (transport.headers !== undefined) out.headers = transport.headers
  }
  if (typeof input.timeoutMs === 'number') out.timeoutMs = input.timeoutMs
  return out
}

/** 装到 claude：~/.claude.json 顶层 mcpServers[name] = transport（剥 undefined） */
export function installMcpToClaude(home: string, name: string, transport: McpTransport): void {
  const file = claudeConfigFile(home)
  const config = readJsonSafe(file)
  const container = asRecord(config.mcpServers) ?? (config.mcpServers = {})
  container[name] = claudeMcpValue(transport)
  writeJsonWithBackup(file, config)
}

/** 装到 zcode：~/.zcode/cli/config.json 的 mcp.servers[name]（嵌套两级，只写 canonical 字段） */
export function installMcpToZcode(home: string, name: string, transport: McpTransport): void {
  const file = zcodeConfigFile(home)
  const config = readJsonSafe(file)
  const mcp = asRecord(config.mcp) ?? {}
  config.mcp = mcp
  const container = asRecord(mcp.servers) ?? (mcp.servers = {})
  container[name] = zcodeMcpValue(transport)
  writeJsonWithBackup(file, config)
}

/** 容器取值器：claude 顶层 mcpServers（导出供 IPC/状态判定复用） */
export function claudeMcpContainer(config: Record<string, unknown>): unknown {
  return config.mcpServers
}

/** 容器取值器：zcode mcp.servers（嵌套两级） */
export function zcodeMcpContainer(config: Record<string, unknown>): unknown {
  return asRecord(config.mcp)?.servers
}

/** JSON 配置卸 MCP：删除后容器为空对象则保留空对象（不删键，避免惊扰其它工具）；文件/容器/键不存在则不动 */
export function uninstallMcpFromJson(file: string, getter: (config: Record<string, unknown>) => unknown, name: string): boolean {
  if (!fs.existsSync(file)) return false
  const config = readJsonSafe(file)
  const container = asRecord(getter(config))
  if (!container || !(name in container)) return false
  delete container[name]
  writeJsonWithBackup(file, config)
  return true
}

/** JSON 目标状态判定：installed 与 expected 归一化（剥 undefined）深比较 */
export function mcpJsonState(file: string, getter: (config: Record<string, unknown>) => unknown, name: string, expected: Record<string, unknown>): SyncState {
  if (!fs.existsSync(file)) return 'missing'
  const container = asRecord(getter(readJsonSafe(file)))
  const installed = container?.[name]
  if (installed === undefined) return 'missing'
  return deepEqual(stripUndefined(installed), stripUndefined(expected)) ? 'in-sync' : 'outdated'
}

// === MCP：codex（TOML 块级文本操作） ===

/** TOML 基本字符串转义 */
function tomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`
}

/** TOML 键：bare-key 字符集外的名字加引号（如带点的服务器名 [mcp_servers."my.server"]） */
function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key)
}

function codexTablePrefix(name: string): string {
  return `mcp_servers.${tomlKey(name)}`
}

/** 生成 [mcp_servers.<name>] 块（codex 仅 stdio；cwd 不在 v1 块格式内）；非 stdio 返回 null */
function codexMcpBlock(name: string, transport: McpTransport): string | null {
  if (transport.type !== 'stdio') return null
  const prefix = codexTablePrefix(name)
  const lines = [`[${prefix}]`, `command = ${tomlString(transport.command)}`, `args = [${(transport.args ?? []).map(tomlString).join(', ')}]`]
  if (transport.env && Object.keys(transport.env).length > 0) {
    lines.push(`[${prefix}.env]`)
    for (const [key, value] of Object.entries(transport.env)) lines.push(`${tomlKey(key)} = ${tomlString(value)}`)
  }
  return lines.join('\n') + '\n'
}

/** 块头判定：[table] 或 [[table]]，table 为 mcp_servers.<name> 本体或其子表 */
function isTargetBlockHeader(trimmedLine: string, prefix: string): boolean {
  const match = /^\[\[?([^\]]+?)\]?\s*$/.exec(trimmedLine)
  if (!match) return false
  const table = match[1].trim()
  return table === prefix || table.startsWith(`${prefix}.`)
}

/** 删除既有 [mcp_servers.<name>] 与子表块（从块头到下一个块头或文件尾）；按 \n 切分保留原行尾 */
function removeCodexBlocks(text: string, name: string): { text: string; removed: boolean } {
  const prefix = codexTablePrefix(name)
  const lines = text.split('\n')
  const kept: string[] = []
  let skipping = false
  let removed = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('[')) skipping = isTargetBlockHeader(trimmed, prefix)
    if (skipping) {
      removed = true
      continue
    }
    kept.push(line)
  }
  return removed ? { text: kept.join('\n').replace(/\s*$/, '\n'), removed } : { text, removed }
}

/** 文本末尾规整后追加块（块自身已带结尾换行） */
function appendCodexBlock(text: string, block: string): string {
  const trimmed = text.replace(/\s+$/, '')
  return trimmed ? `${trimmed}\n\n${block}` : block
}

/** 装到 codex：非 stdio 跳过并在返回中注明（codex 仅支持 stdio MCP） */
export function installMcpToCodex(home: string, name: string, transport: McpTransport): { ok: boolean; skipped?: boolean; reason?: string } {
  const block = codexMcpBlock(name, transport)
  if (!block) return { ok: false, skipped: true, reason: 'codex 仅支持 stdio MCP，已跳过该目标' }
  const file = codexConfigFile(home)
  const original = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  const updated = appendCodexBlock(removeCodexBlocks(original, name).text, block)
  backupOnce(file)
  writeFileAtomic(file, updated)
  return { ok: true }
}

/** 从 codex 卸载：删除块；块不存在/文件不存在则不动 */
export function uninstallMcpFromCodex(home: string, name: string): boolean {
  const file = codexConfigFile(home)
  if (!fs.existsSync(file)) return false
  const { text, removed } = removeCodexBlocks(fs.readFileSync(file, 'utf8'), name)
  if (!removed) return false
  backupOnce(file)
  writeFileAtomic(file, text)
  return true
}

/** codex 目标期望值：块格式同形对象（command/args 恒有，env 仅非空时出现） */
function codexMcpValue(transport: McpTransport): Record<string, unknown> {
  if (transport.type !== 'stdio') return {}
  const value: Record<string, unknown> = { command: transport.command, args: transport.args ?? [] }
  if (transport.env && Object.keys(transport.env).length > 0) value.env = transport.env
  return value
}

/** 解析 TOML 标量/字符串数组（够用即可：值形态受限且由本模块生成；基本字符串转义与 JSON 兼容） */
function parseTomlValue(raw: string): unknown {
  const text = raw.trim()
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) return JSON.parse(text)
  if (text.startsWith('[') && text.endsWith(']')) {
    const inner = text.slice(1, -1)
    const items: string[] = []
    let current = ''
    let inString = false
    let depth = 0
    for (let i = 0; i < inner.length; i++) {
      const char = inner[i]
      if (inString) {
        current += char
        if (char === '\\') {
          current += inner[i + 1] ?? ''
          i++
        } else if (char === '"') inString = false
        continue
      }
      if (char === '"') {
        inString = true
        current += char
        continue
      }
      if (char === '[') depth++
      if (char === ']') depth--
      if (char === ',' && depth === 0) {
        items.push(current)
        current = ''
        continue
      }
      current += char
    }
    items.push(current)
    return items.map((item) => item.trim()).filter(Boolean).map((item) => parseTomlValue(item))
  }
  if (text === 'true') return true
  if (text === 'false') return false
  const num = Number(text)
  if (text && Number.isFinite(num)) return num
  return text
}

function splitTomlKeyValue(line: string): [string, unknown] | null {
  const match = /^(.+?)\s*=\s*(.*)$/.exec(line.trim())
  if (!match) return null
  const key = match[1].trim()
  const name = /^"((?:[^"\\]|\\.)*)"$/.exec(key)
  return [name ? JSON.parse(name[0]) : key, parseTomlValue(match[2])]
}

/** 把 codex 的 [mcp_servers.<name>] 块解析回同形对象（含 env 子表；意外子表记为 foreign → 永远 outdated）；无块返回 null */
export function readCodexMcpBlock(home: string, name: string): Record<string, unknown> | null {
  const file = codexConfigFile(home)
  if (!fs.existsSync(file)) return null
  const prefix = codexTablePrefix(name)
  const parsed: Record<string, unknown> = {}
  let section: 'main' | 'env' | 'foreign' | null = null
  let found = false
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('[')) {
      section = null
      if (isTargetBlockHeader(trimmed, prefix)) {
        found = true
        section = trimmed === `[${prefix}]` ? 'main' : trimmed === `[${prefix}.env]` ? 'env' : 'foreign'
      }
      continue
    }
    if (!section || !trimmed || trimmed.startsWith('#')) continue
    const pair = splitTomlKeyValue(line)
    if (!pair) continue
    if (section === 'env') {
      const env = asRecord(parsed.env) ?? {}
      env[pair[0]] = pair[1]
      parsed.env = env
    } else if (section === 'main') {
      parsed[pair[0]] = pair[1]
    } else {
      parsed['<foreign>'] = true
    }
  }
  return found ? parsed : null
}

// === MCP：统一状态判定 ===

/** 未知 targetId 抛错；codex 把 TOML 块解析回同形对象再比较 */
export function mcpState(home: string, targetId: string, name: string, transport: McpTransport): SyncState {
  if (targetId === 'claude') return mcpJsonState(claudeConfigFile(home), claudeMcpContainer, name, claudeMcpValue(transport))
  if (targetId === 'zcode') return mcpJsonState(zcodeConfigFile(home), zcodeMcpContainer, name, zcodeMcpValue(transport))
  if (targetId === 'codex') {
    const installed = readCodexMcpBlock(home, name)
    if (!installed) return 'missing'
    return deepEqual(stripUndefined(installed), codexMcpValue(transport)) ? 'in-sync' : 'outdated'
  }
  throw new Error(`未知 MCP 安装目标: ${targetId}`)
}

// === Hooks：claude settings.json / zcode config.json（结构同形） ===

/** 组内 hooks[].command 集合与我们的完全一致 → 该组由本 hook 安装 */
function groupIsOurs(group: unknown, ourCommands: string[]): boolean {
  const record = asRecord(group)
  const hooks = record && Array.isArray(record.hooks) ? record.hooks : undefined
  if (!hooks) return false
  const installed: string[] = []
  for (const hook of hooks) {
    const command = asRecord(hook)?.command
    if (typeof command !== 'string') return false
    installed.push(command)
  }
  if (installed.length !== ourCommands.length) return false
  const a = [...installed].sort()
  const b = [...ourCommands].sort()
  return a.every((command, index) => command === b[index])
}

function ourCommandsOf(groups: HookGroup[]): string[] {
  return groups.flatMap((group) => group.hooks.map((hook) => hook.command))
}

/** 事件组容器：claude = hooks.<Event> 直挂；zcode = hooks.events.<Event>（结构同形但多一层） */
function hookEventContainer(hooks: Record<string, unknown>, zcode: boolean): Record<string, unknown> | undefined {
  return zcode ? asRecord(hooks.events) : asRecord(hooks)
}

/** 合并我们的事件组：先删除本 hook 已装组再 append；zcode 侧强制 hooks.enabled = true */
function mergeHookEvents(config: Record<string, unknown>, events: Record<string, HookGroup[]>, zcode: boolean): void {
  const hooks = asRecord(config.hooks) ?? {}
  config.hooks = hooks
  if (zcode) {
    hooks.enabled = true
    if (!asRecord(hooks.events)) hooks.events = {}
  }
  const eventsContainer = hookEventContainer(hooks, zcode)!
  for (const [event, ourGroups] of Object.entries(events)) {
    const existing = Array.isArray(eventsContainer[event]) ? (eventsContainer[event] as unknown[]) : []
    const commands = ourCommandsOf(ourGroups)
    eventsContainer[event] = [...existing.filter((group) => !groupIsOurs(group, commands)), ...(stripUndefined(ourGroups) as HookGroup[])]
  }
}

/** 卸载我们的事件组（command 集合匹配）；事件数组删空删该事件键；zcode 侧 events 删空删整个 hooks 键 */
function unmergeHookEvents(config: Record<string, unknown>, events: Record<string, HookGroup[]>, zcode: boolean): boolean {
  const hooks = asRecord(config.hooks)
  const eventsContainer = hooks ? hookEventContainer(hooks, zcode) : undefined
  if (!hooks || !eventsContainer) return false
  let changed = false
  for (const [event, ourGroups] of Object.entries(events)) {
    const existing = eventsContainer[event]
    if (!Array.isArray(existing)) continue
    const commands = ourCommandsOf(ourGroups)
    const kept = existing.filter((group) => !groupIsOurs(group, commands))
    if (kept.length === existing.length) continue
    changed = true
    if (kept.length > 0) eventsContainer[event] = kept
    else delete eventsContainer[event]
  }
  if (zcode && asRecord(hooks.events) && Object.keys(hooks.events as Record<string, unknown>).length === 0) delete config.hooks
  return changed
}

function hookTargetFile(home: string, targetId: string): string {
  if (targetId === 'claude') return claudeSettingsFile(home)
  if (targetId === 'zcode') return zcodeConfigFile(home)
  throw new Error(`未知 Hook 安装目标: ${targetId}`)
}

export function installHookToClaude(home: string, name: string, events: Record<string, HookGroup[]>): void {
  const file = hookTargetFile(home, 'claude')
  const config = readJsonSafe(file)
  mergeHookEvents(config, events, false)
  writeJsonWithBackup(file, config)
}

export function installHookToZcode(home: string, name: string, events: Record<string, HookGroup[]>): void {
  const file = hookTargetFile(home, 'zcode')
  const config = readJsonSafe(file)
  mergeHookEvents(config, events, true)
  writeJsonWithBackup(file, config)
}

export function uninstallHookFromClaude(home: string, name: string, events: Record<string, HookGroup[]>): boolean {
  const file = hookTargetFile(home, 'claude')
  if (!fs.existsSync(file)) return false
  const config = readJsonSafe(file)
  if (!unmergeHookEvents(config, events, false)) return false
  writeJsonWithBackup(file, config)
  return true
}

export function uninstallHookFromZcode(home: string, name: string, events: Record<string, HookGroup[]>): boolean {
  const file = hookTargetFile(home, 'zcode')
  if (!fs.existsSync(file)) return false
  const config = readJsonSafe(file)
  if (!unmergeHookEvents(config, events, true)) return false
  writeJsonWithBackup(file, config)
  return true
}

/** Hook 状态判定：每个事件在目标配置里存在 command 集合完全一致的组；全有=in-sync、全无=missing、部分=outdated */
export function hookState(home: string, targetId: string, events: Record<string, HookGroup[]>): SyncState {
  const file = hookTargetFile(home, targetId)
  if (!fs.existsSync(file)) return 'missing'
  const config = readJsonSafe(file)
  const hooks = asRecord(config.hooks)
  const eventsContainer = hooks ? hookEventContainer(hooks, targetId === 'zcode') : undefined
  const eventNames = Object.keys(events)
  const matched = eventNames.filter((event) => {
    const existing = eventsContainer?.[event]
    if (!Array.isArray(existing)) return false
    const commands = ourCommandsOf(events[event])
    return existing.some((group) => groupIsOurs(group, commands))
  }).length
  if (matched === 0) return 'missing'
  return matched === eventNames.length ? 'in-sync' : 'outdated'
}

// === 插件启停（claude settings.json） ===

/** 改 enabledPlugins['name@marketplace']；文件不存在则创建（走备份写回） */
export function setClaudePluginEnabled(home: string, name: string, marketplace: string, enabled: boolean): void {
  const file = claudeSettingsFile(home)
  const config = readJsonSafe(file)
  const plugins = asRecord(config.enabledPlugins) ?? {}
  config.enabledPlugins = plugins
  plugins[`${name}@${marketplace}`] = enabled
  writeJsonWithBackup(file, config)
}

// === 插件市场注册（claude settings.json / zcode known_marketplaces.json） ===

/** zcode 市场注册表（ZCode CLI 维护，纯 JSON 对象表，append 安全） */
export function zcodeKnownMarketplacesFile(home: string): string {
  return path.join(home, '.zcode', 'cli', 'plugins', 'known_marketplaces.json')
}

/** claude/zcode 市场仅支持 github 仓库源：repo 必须 owner/repo 形式 */
function assertGithubRepo(repo: string): string {
  if (typeof repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`市场仓库必须是 github owner/repo 形式: ${repo}`)
  return repo
}

/** 注册 claude 市场：settings.json extraKnownMarketplaces[name] = { source: { repo, source: 'github' } }；
 *  键已存在 = 幂等成功不覆盖（不写盘） */
export function registerMarketplaceToClaude(home: string, name: string, repo: string): { alreadyRegistered: boolean } {
  assertGithubRepo(repo)
  const file = claudeSettingsFile(home)
  const config = readJsonSafe(file)
  const marketplaces = asRecord(config.extraKnownMarketplaces) ?? {}
  if (name in marketplaces) return { alreadyRegistered: true }
  config.extraKnownMarketplaces = marketplaces
  marketplaces[name] = { source: { repo, source: 'github' } }
  writeJsonWithBackup(file, config)
  return { alreadyRegistered: false }
}

export interface ZcodeMarketplaceMeta {
  repo: string
  name: string
  description?: string
  pluginCount?: number
}

/** 注册 zcode 市场：known_marketplaces.json 的 marketplaces 数组 append（不写 lastUpdated/cacheTransactionId，
 *  那两个由 ZCode CLI 下次同步自己补）；同 id 已存在 = 幂等成功不覆盖 */
export function registerMarketplaceToZcode(home: string, id: string, meta: ZcodeMarketplaceMeta): { alreadyRegistered: boolean } {
  assertGithubRepo(meta.repo)
  const file = zcodeKnownMarketplacesFile(home)
  const config = readJsonSafe(file)
  const list: unknown[] = Array.isArray(config.marketplaces) ? config.marketplaces : []
  if (list.some((entry) => asRecord(entry)?.id === id)) return { alreadyRegistered: true }
  list.push(
    stripUndefined({
      id,
      source: { source: 'github', repo: meta.repo },
      name: meta.name,
      description: meta.description,
      addedAt: new Date().toISOString(),
      pluginCount: meta.pluginCount
    })
  )
  config.marketplaces = list
  writeJsonWithBackup(file, config)
  return { alreadyRegistered: false }
}
