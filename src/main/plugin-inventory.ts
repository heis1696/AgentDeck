// 插件/市场只读盘点（claude/zcode/codex 三 CLI）+ claude 插件启停
// （全部 try/catch 容错——任何 CLI 未安装/无配置就跳过该 CLI，不报错；home 由参数注入）
import fs from 'node:fs'
import path from 'node:path'
import type { MarketplacePluginInfo, MarketplaceStatus, PluginInventoryItem, RegisteredMarketplace } from '../shared/extensions'
import { claudeSettingsFile, readJsonSafe, zcodeKnownMarketplacesFile } from './config-editor'
import { browseSource, claudePluginKeys, listMarketplacePlugins, listSources, mapMarketplacePlugins, readMarketplaceAsset } from './sources'

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

/** 最高语义化版本（版本段按数字逐段比，取降序第一个；非数字段按字符串比） */
function highestVersion(versions: string[]): string {
  const key = (version: string) => version.split(/[.\-+]/).map((part) => (/^\d+$/.test(part) ? Number(part) : part))
  return versions.sort((a, b) => {
    const ka = key(a)
    const kb = key(b)
    for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
      const x = ka[i]
      const y = kb[i]
      if (x === undefined) return 1
      if (y === undefined) return -1
      if (x === y) continue
      if (typeof x === 'number' && typeof y === 'number') return y - x
      return String(x) > String(y) ? -1 : 1
    }
    return 0
  })[0]
}

// === claude：settings.json 的 enabledPlugins + extraKnownMarketplaces ===

/** installed_plugins.json 的已装插件键集（结构 {version, plugins: {'name@marketplace': [...]}}；读失败/无文件 → 空集容错） */
function claudeInstalledKeys(home: string): Set<string> {
  try {
    const installed = asRecord(readJsonSafe(path.join(home, '.claude', 'plugins', 'installed_plugins.json')).plugins)
    return new Set(Object.keys(installed ?? {}))
  } catch {
    return new Set()
  }
}

function claudeInventory(home: string): PluginInventoryItem[] {
  // 无 settings.json = claude 未配置 → 跳过该 CLI（容错规则优先于固定官方市场项）
  const settingsFile = claudeSettingsFile(home)
  if (!fs.existsSync(settingsFile)) return []
  const settings = readJsonSafe(settingsFile)
  const items: PluginInventoryItem[] = []
  const enabledPlugins = asRecord(settings.enabledPlugins)
  if (enabledPlugins) {
    // 与 installed_plugins.json 交叉：enabledPlugins 有键而 plugins 无对应 = 卸载残留幽灵键 → installed:false
    const installedKeys = claudeInstalledKeys(home)
    for (const [key, value] of Object.entries(enabledPlugins)) {
      const at = key.lastIndexOf('@')
      if (at <= 0) continue
      items.push({ cli: 'claude', kind: 'plugin', name: key.slice(0, at), marketplace: key.slice(at + 1), enabled: value === true, installed: installedKeys.has(key) })
    }
  }
  const marketplaces = asRecord(settings.extraKnownMarketplaces)
  if (marketplaces) {
    for (const [name, entry] of Object.entries(marketplaces)) {
      const description = asRecord(entry)?.description
      items.push({ cli: 'claude', kind: 'marketplace', name, description: typeof description === 'string' ? description : undefined })
    }
  }
  if (!items.some((item) => item.kind === 'marketplace' && item.name === 'claude-plugins-official')) {
    items.push({ cli: 'claude', kind: 'marketplace', name: 'claude-plugins-official', description: 'Claude Code 官方插件市场' })
  }
  return items
}

// === zcode：known_marketplaces.json + cache/<marketplace>/<plugin>/<version> ===

function zcodeInventory(home: string): PluginInventoryItem[] {
  const pluginsRoot = path.join(home, '.zcode', 'cli', 'plugins')
  const items: PluginInventoryItem[] = []
  let registry: Record<string, unknown> = {}
  try {
    registry = readJsonSafe(path.join(pluginsRoot, 'known_marketplaces.json'))
  } catch {
    // 无/坏注册表 → 只盘点 cache
  }
  const marketplaces = Array.isArray(registry.marketplaces) ? registry.marketplaces : []
  for (const entry of marketplaces) {
    const record = asRecord(entry)
    if (!record) continue
    const name = typeof record.name === 'string' ? record.name : typeof record.id === 'string' ? record.id : undefined
    if (!name) continue
    const pluginCount = typeof record.pluginCount === 'number' ? record.pluginCount : undefined
    items.push({ cli: 'zcode', kind: 'marketplace', name, description: pluginCount === undefined ? undefined : `${pluginCount} 个插件` })
  }
  const cacheRoot = path.join(pluginsRoot, 'cache')
  let marketplaceDirs: fs.Dirent[] = []
  try {
    marketplaceDirs = fs.readdirSync(cacheRoot, { withFileTypes: true })
  } catch {
    return items
  }
  for (const marketplaceDir of marketplaceDirs.filter((entry) => entry.isDirectory())) {
    let pluginDirs: fs.Dirent[] = []
    try {
      pluginDirs = fs.readdirSync(path.join(cacheRoot, marketplaceDir.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const pluginDir of pluginDirs.filter((entry) => entry.isDirectory())) {
      const pluginPath = path.join(cacheRoot, marketplaceDir.name, pluginDir.name)
      let versions: string[] = []
      try {
        versions = fs.readdirSync(pluginPath, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
      } catch {
        continue
      }
      items.push({ cli: 'zcode', kind: 'plugin', name: pluginDir.name, marketplace: marketplaceDir.name, version: versions.length ? highestVersion(versions) : undefined, dir: pluginPath })
    }
  }
  return items
}

// === codex：~/.codex/plugins/cache/ 一级子目录 ===

function codexInventory(home: string): PluginInventoryItem[] {
  const cacheRoot = path.join(home, '.codex', 'plugins', 'cache')
  let dirs: fs.Dirent[] = []
  try {
    dirs = fs.readdirSync(cacheRoot, { withFileTypes: true })
  } catch {
    return []
  }
  return dirs
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ cli: 'codex' as const, kind: 'plugin' as const, name: entry.name, dir: path.join(cacheRoot, entry.name) }))
}

/** 三 CLI 聚合盘点（单个 CLI 失败跳过该 CLI） */
export function pluginInventory(home: string): PluginInventoryItem[] {
  const items: PluginInventoryItem[] = []
  for (const scan of [claudeInventory, zcodeInventory, codexInventory]) {
    try {
      items.push(...scan(home))
    } catch {
      // 该 CLI 配置不可读 → 跳过，不影响其它 CLI
    }
  }
  return items
}

/** 两 CLI 已注册市场名清单（渲染层「已注册」态判定）；任一侧配置不可读 → 该侧空数组容错 */
export function marketplaceStatus(home: string): MarketplaceStatus {
  const claude: string[] = []
  try {
    const marketplaces = asRecord(readJsonSafe(claudeSettingsFile(home)).extraKnownMarketplaces)
    if (marketplaces) claude.push(...Object.keys(marketplaces))
  } catch {
    // 无/坏 settings.json → claude 侧按未注册
  }
  const zcode: string[] = []
  try {
    const registry = readJsonSafe(zcodeKnownMarketplacesFile(home))
    const list = Array.isArray(registry.marketplaces) ? registry.marketplaces : []
    for (const entry of list) {
      const id = asRecord(entry)?.id
      if (typeof id === 'string') zcode.push(id)
    }
  } catch {
    // 无/坏注册表 → zcode 侧按未注册
  }
  return { claude, zcode }
}

// === §8.6 已注册市场聚合（AgentDeck 源内 marketplace.json + claude/zcode 市场缓存，渲染层「浏览市场」用） ===

type RegisteredCli = RegisteredMarketplace['clis'][number]

/** claude/zcode 市场缓存目录扫描：<dir>/marketplace.json 优先，兼容 git clone 原始布局 <dir>/.claude-plugin/marketplace.json；
 *  目录不可读/坏 JSON/缺 name → 跳过该市场（容错），命中任一候选文件即停 */
function scanMarketplaceCache(marketplacesRoot: string, cli: RegisteredCli, installedKeys: Set<string>, add: (name: string, cli: RegisteredCli, plugins: MarketplacePluginInfo[]) => void): void {
  let dirs: fs.Dirent[]
  try {
    dirs = fs.readdirSync(marketplacesRoot, { withFileTypes: true })
  } catch {
    return
  }
  for (const dir of dirs.filter((entry) => entry.isDirectory())) {
    for (const rel of ['marketplace.json', path.join('.claude-plugin', 'marketplace.json')]) {
      const file = path.join(marketplacesRoot, dir.name, rel)
      if (!fs.existsSync(file)) continue
      let parsed: Record<string, unknown> | undefined
      try {
        parsed = asRecord(JSON.parse(fs.readFileSync(file, 'utf8')))
      } catch {
        // 坏 JSON → 跳过该市场
      }
      const name = typeof parsed?.name === 'string' ? parsed.name.trim() : ''
      if (parsed && name) add(name, cli, mapMarketplacePlugins(parsed.plugins, name, installedKeys))
      break
    }
  }
}

/** 三来源聚合已注册市场（按市场名去重合并：clis 取并集，plugins 以首个成功读取的 json 为准）：
 *  ① AgentDeck 源内 marketplace.json（browseSource 扫描，未注册到任何 CLI 时 clis 为空）
 *  ② claude ~/.claude/plugins/marketplaces/<name>/marketplace.json
 *  ③ zcode ~/.zcode/cli/plugins/marketplaces/<id>/marketplace.json
 *  任一来源/市场读失败容错跳过；plugins 的 installed 交叉复用 claude 已装键集 */
export function registeredMarketplaces(root: string, home: string): RegisteredMarketplace[] {
  const byName = new Map<string, { clis: Set<RegisteredCli>; plugins: MarketplacePluginInfo[] }>()
  const add = (name: string, cli: RegisteredCli | null, plugins: MarketplacePluginInfo[]) => {
    const found = byName.get(name)
    if (found) {
      if (cli) found.clis.add(cli)
      return
    }
    byName.set(name, { clis: new Set(cli ? [cli] : []), plugins })
  }
  for (const source of listSources(root)) {
    let assets: ReturnType<typeof browseSource>
    try {
      assets = browseSource(root, source.id)
    } catch {
      continue
    }
    for (const asset of assets) {
      if (asset.kind !== 'marketplace') continue
      try {
        const info = readMarketplaceAsset(root, source.id, asset.path)
        add(info.name, null, listMarketplacePlugins(root, home, source.id, asset.path))
      } catch {
        // 坏 marketplace.json / 缺 name → 跳过该市场
      }
    }
  }
  const installedKeys = claudePluginKeys(home)
  scanMarketplaceCache(path.join(home, '.claude', 'plugins', 'marketplaces'), 'claude', installedKeys, add)
  scanMarketplaceCache(path.join(home, '.zcode', 'cli', 'plugins', 'marketplaces'), 'zcode', installedKeys, add)
  return [...byName.entries()]
    .map(([name, found]) => ({ name, clis: [...found.clis], plugins: found.plugins }))
    .sort((a, b) => a.name.localeCompare(b.name))
}
