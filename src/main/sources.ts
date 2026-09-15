// 扩展源仓库：<root>/sources/sources.json 注册表 + <root>/sources/<id>/ git clone（local 源不落目录）
// 浏览发现可导入资产（SKILL.md / marketplace.json / 根 README）；纯 Node，git 走 spawnSync（Windows shell:true + 手工引号），不联网才能测——smoke 用本地 fixture 仓库
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { DiscoveredAsset, ExtSourceMeta, MarketplacePluginInfo, MarketplaceRegisterResult, SkillDiscoveryGroup, SkillsFromUrlResult, SourceKind } from '../shared/extensions'
import { claudeSettingsFile, readJsonSafe, registerMarketplaceToClaude, registerMarketplaceToZcode } from './config-editor'
import { assertInside, importSkill, isValidSkillName, parseFrontmatter, skillsDir } from './skills'

/** 源 id 与技能名同一套字符集（杜绝路径逃逸） */
function assertId(id: string): string {
  if (typeof id !== 'string' || !isValidSkillName(id)) throw new Error(`源 id 非法: ${id}`)
  return id
}

/** 与 skills.ts 的 sanitizeSkillName 同款折叠：小写化、非法字符折叠为 - */
function sanitizeSourceId(raw: string): string {
  const folded = raw.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-._]+|[-._]+$/g, '').slice(0, 128)
  return isValidSkillName(folded) ? folded : `source-${folded}`.slice(0, 128)
}

export function sourcesDir(root: string): string {
  return path.join(root, 'sources')
}

function registryFile(root: string): string {
  return path.join(sourcesDir(root), 'sources.json')
}

function sourceDir(root: string, id: string): string {
  const dir = path.join(sourcesDir(root), assertId(id))
  assertInside(sourcesDir(root), dir)
  return dir
}

function readRegistry(root: string): ExtSourceMeta[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(registryFile(root), 'utf8'))
    return Array.isArray(parsed) ? (parsed as ExtSourceMeta[]) : []
  } catch {
    return []
  }
}

function writeRegistry(root: string, sources: ExtSourceMeta[]): void {
  fs.mkdirSync(sourcesDir(root), { recursive: true })
  const file = registryFile(root)
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(sources, null, 2) + '\n')
  fs.renameSync(tmp, file)
}

function getSource(root: string, id: string): ExtSourceMeta {
  const source = readRegistry(root).find((item) => item.id === id)
  if (!source) throw new Error(`扩展源不存在: ${id}`)
  return source
}

/** Windows 下经 shell 调 git（PATH 垫片场景），含空格等特殊字符的参数手工加引号 */
function runGit(args: string[]): void {
  const windows = process.platform === 'win32'
  const finalArgs = windows ? args.map((arg) => (/^[\w.@:/\\-]+$/.test(arg) ? arg : `"${arg}"`)) : args
  const result = spawnSync('git', finalArgs, { shell: windows, encoding: 'utf8' })
  if (result.error) throw new Error(`git 执行失败: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} 失败: ${(result.stderr || result.stdout || '').trim()}`)
}

function isGitRef(ref: string): boolean {
  return ref.endsWith('.git') || /^https?:\/\//.test(ref)
}

function deriveName(ref: string): string {
  const trimmed = ref.replace(/[\\/]+$/, '')
  const last = trimmed.split(/[\\/]/).pop() ?? 'source'
  return last.replace(/\.git$/, '') || 'source'
}

/** 添加源：git URL（.git 结尾或 http(s)）立即浅克隆；存在的本地目录 → local（不 clone）；否则报错。id 用名字折叠 + 重名 -2 */
export function addSource(root: string, ref: string, name?: string): ExtSourceMeta {
  if (typeof ref !== 'string' || !ref.trim()) throw new Error('源 ref 不能为空')
  let kind: SourceKind
  if (isGitRef(ref)) kind = 'git'
  else if (fs.existsSync(ref) && fs.statSync(ref).isDirectory()) kind = 'local'
  else throw new Error(`源 ref 必须是 git URL 或存在的本地目录: ${ref}`)
  const display = (name ?? '').trim() || deriveName(ref)
  const sources = readRegistry(root)
  const baseId = sanitizeSourceId(display)
  let id = baseId
  for (let n = 2; sources.some((source) => source.id === id); n++) id = `${baseId}-${n}`
  if (kind === 'git') {
    const dir = sourceDir(root, id)
    fs.mkdirSync(sourcesDir(root), { recursive: true })
    try {
      runGit(['clone', '--depth', '1', ref, dir])
    } catch (error) {
      fs.rmSync(dir, { recursive: true, force: true })
      throw error
    }
  }
  const source: ExtSourceMeta = {
    id,
    name: display,
    kind,
    ref,
    category: 'custom',
    description: '',
    addedAt: Date.now(),
    lastSyncedAt: kind === 'git' ? Date.now() : null
  }
  writeRegistry(root, [...sources, source])
  return source
}

export function listSources(root: string): ExtSourceMeta[] {
  return readRegistry(root)
}

/** git 源 pull --ff-only（失败上抛、注册表不动）；local 源仅刷新 lastSyncedAt */
export function syncSource(root: string, id: string): ExtSourceMeta {
  const source = getSource(root, id)
  if (source.kind === 'git') {
    const dir = sourceDir(root, id)
    if (!fs.existsSync(dir)) throw new Error(`源目录缺失，请移除后重新添加: ${id}`)
    runGit(['-C', dir, 'pull', '--ff-only'])
  }
  source.lastSyncedAt = Date.now()
  writeRegistry(root, readRegistry(root).map((item) => (item.id === source.id ? source : item)))
  return source
}

/** 移除源：删注册表项 + git clone 目录；local 源不删原目录 */
export function removeSource(root: string, id: string): void {
  const source = getSource(root, id)
  writeRegistry(root, readRegistry(root).filter((item) => item.id !== source.id))
  if (source.kind === 'git') fs.rmSync(sourceDir(root, source.id), { recursive: true, force: true })
}

/** 源内容根：git → clone 目录（必须已克隆）；local → ref 路径（必须存在） */
function sourceRoot(root: string, source: ExtSourceMeta): string {
  if (source.kind === 'local') {
    if (!fs.existsSync(source.ref) || !fs.statSync(source.ref).isDirectory()) throw new Error(`本地源目录不存在: ${source.ref}`)
    return source.ref
  }
  const dir = sourceDir(root, source.id)
  if (!fs.existsSync(dir)) throw new Error(`源尚未克隆，请先同步: ${source.id}`)
  return dir
}

// === 浏览发现 ===

const WALK_MAX_DEPTH = 6
const WALK_MAX_FILES = 20000

interface WalkState {
  skills: DiscoveredAsset[]
  marketplaces: DiscoveredAsset[]
  visitedFiles: number
  truncated: boolean
}

function toPosix(rel: string): string {
  return rel.split(path.sep).join('/')
}

function walkSourceDir(dir: string, base: string, depth: number, state: WalkState): void {
  if (state.truncated || depth > WALK_MAX_DEPTH) return
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return
  }
  for (const entry of entries) {
    if (state.truncated) return
    if (entry.name === '.git' || entry.name === 'node_modules') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walkSourceDir(full, base, depth + 1, state)
      continue
    }
    if (!entry.isFile()) continue
    state.visitedFiles++
    if (state.visitedFiles > WALK_MAX_FILES) {
      state.truncated = true
      return
    }
    if (entry.name === 'SKILL.md') {
      const parent = path.dirname(full)
      let description = ''
      try {
        description = parseFrontmatter(fs.readFileSync(full, 'utf8')).data.description ?? ''
      } catch {
        // 坏 SKILL.md 仍列出，描述留空
      }
      state.skills.push({ kind: 'skill', name: path.basename(parent), path: toPosix(path.relative(base, parent)), description })
      continue
    }
    if (entry.name === 'marketplace.json' && path.basename(path.dirname(full)) === '.claude-plugin') {
      let name = path.basename(path.dirname(path.dirname(full)))
      let description = ''
      let pluginCount: number | undefined
      try {
        const parsed = JSON.parse(fs.readFileSync(full, 'utf8')) as Record<string, unknown>
        if (typeof parsed.name === 'string' && parsed.name.trim()) name = parsed.name.trim()
        if (typeof parsed.description === 'string') description = parsed.description
        if (Array.isArray(parsed.plugins)) pluginCount = parsed.plugins.length
      } catch {
        // 坏 marketplace.json 用目录名兜底
      }
      const asset: DiscoveredAsset = { kind: 'marketplace', name, path: toPosix(path.relative(base, full)), description }
      if (pluginCount !== undefined) asset.pluginCount = pluginCount
      state.marketplaces.push(asset)
    }
  }
}

/** 扫描源发现资产：根 README 简介锚点 + marketplace.json + 全部 SKILL.md（名字已入共享技能库 → importedAs 提示） */
export function browseSource(root: string, id: string): DiscoveredAsset[] {
  const base = sourceRoot(root, getSource(root, id))
  const state: WalkState = { skills: [], marketplaces: [], visitedFiles: 0, truncated: false }
  walkSourceDir(base, base, 1, state)
  const assets: DiscoveredAsset[] = []
  const readme = path.join(base, 'README.md')
  if (fs.existsSync(readme)) {
    let description = ''
    try {
      description = /^#\s+(.+)$/m.exec(fs.readFileSync(readme, 'utf8'))?.[1]?.trim() ?? ''
    } catch {
      // README 不可读 → 简介留空
    }
    assets.push({ kind: 'readme', name: path.basename(base), path: 'README.md', description })
  }
  assets.push(...state.marketplaces, ...state.skills)
  for (const asset of assets) {
    if (asset.kind === 'skill' && fs.existsSync(path.join(skillsDir(root), asset.name))) asset.importedAs = asset.name
  }
  return assets
}

/** §8.5 从 URL 一键安装：addSource + browseSource 编排（粘贴 URL 一步到浏览）；任一步失败按原错误上抛（clone 失败不落注册表语义不变） */
export function quickAddSource(root: string, ref: string, name?: string): { source: ExtSourceMeta; assets: DiscoveredAsset[] } {
  const source = addSource(root, ref, name)
  return { source, assets: browseSource(root, source.id) }
}

/** 从源导入技能：relPath 必须落在源根内且目录含 SKILL.md；复用 importSkill（自动 -2 去重） */
export function importSkillFromSource(root: string, id: string, relPath: string): { name: string } {
  const base = sourceRoot(root, getSource(root, id))
  if (typeof relPath !== 'string' || !relPath.trim()) throw new Error('relPath 不能为空')
  const target = path.resolve(base, relPath)
  // 源根本身（relPath='.'，整个源就是一个技能）合法；其余路径必须严格落在源内
  if (path.relative(base, target) !== '') assertInside(base, target)
  if (!fs.existsSync(path.join(target, 'SKILL.md'))) throw new Error(`目录缺少 SKILL.md，无法导入: ${relPath}`)
  return { name: importSkill(root, target).name }
}

/** §8.6 从 URL 一键装技能：quickAddSource 一步克隆+扫描后，对 skill 型资产循环 importSkillFromSource；
 *  已在共享技能库的（browseSource 的 importedAs 提示）跳过不重复；源照常登记（仓库 tab 可管理）；
 *  非法 ref / clone 失败按既有错误上抛（失败不落注册表语义同 quickAdd） */
export function installSkillsFromUrl(root: string, ref: string): SkillsFromUrlResult {
  const { source, assets } = quickAddSource(root, ref)
  const skills: string[] = []
  for (const asset of assets) {
    if (asset.kind !== 'skill' || asset.importedAs) continue
    skills.push(importSkillFromSource(root, source.id, asset.path).name)
  }
  return { skills, sourceName: source.name, sourceId: source.id }
}

/** §8.7 技能 tab「发现」区：注册表逐源 browseSource，只保留 skill 型资产按源分组（README/marketplace 不入组）；
 *  单源扫描失败容错跳过（坏 ref/clone 缺失不炸整表），无 skill 资产的源不出组；注册表缺失/坏 JSON → 空数组 */
export function listSkillGroups(root: string): SkillDiscoveryGroup[] {
  const groups: SkillDiscoveryGroup[] = []
  for (const source of readRegistry(root)) {
    try {
      const skills = browseSource(root, source.id).filter((asset) => asset.kind === 'skill')
      if (skills.length > 0) groups.push({ source: { id: source.id, name: source.name, ref: source.ref, kind: source.kind }, skills })
    } catch {
      // 坏源跳过：技能发现是聚合展示，单源不可用不必报错
    }
  }
  return groups
}

// === marketplace.json 资产 → 注册为 Claude/ZCode 插件市场（§8.1） ===

export interface MarketplaceAssetInfo {
  name: string
  description: string
  pluginCount: number
  /** github owner/repo（git 源且 ref 可解析为 github.com 仓库）；local/非 github 源为 null */
  repo: string | null
}

/** github 仓库 URL → owner/repo（仅 github.com，容忍 .git 后缀与尾斜杠；其余 null） */
function githubRepoOf(ref: string): string | null {
  const match = /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(ref)
  return match ? `${match[1]}/${match[2]}` : null
}

/** 校验并解析源内 marketplace.json（register/listPlugins 共用）：assetPath 必须 assertInside 源根、文件名为 marketplace.json、顶层有 name */
function readMarketplaceJson(root: string, id: string, assetPath: string): { source: ExtSourceMeta; parsed: Record<string, unknown>; name: string } {
  const source = getSource(root, id)
  const base = sourceRoot(root, source)
  if (typeof assetPath !== 'string' || !assetPath.trim()) throw new Error('assetPath 不能为空')
  const target = path.resolve(base, assetPath)
  assertInside(base, target)
  if (path.basename(target) !== 'marketplace.json') throw new Error(`不是 marketplace.json 资产: ${assetPath}`)
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(fs.readFileSync(target, 'utf8')) as Record<string, unknown>
  } catch {
    throw new Error(`marketplace.json 读取失败: ${assetPath}`)
  }
  const name = typeof parsed.name === 'string' ? parsed.name.trim() : ''
  if (!name) throw new Error(`marketplace.json 缺少 name 字段: ${assetPath}`)
  return { source, parsed, name }
}

/** 解析源内 marketplace.json 资产（marketplaces:register 入口） */
export function readMarketplaceAsset(root: string, id: string, assetPath: string): MarketplaceAssetInfo {
  const { source, parsed, name } = readMarketplaceJson(root, id, assetPath)
  return {
    name,
    description: typeof parsed.description === 'string' ? parsed.description : '',
    pluginCount: Array.isArray(parsed.plugins) ? parsed.plugins.length : 0,
    repo: source.kind === 'git' ? githubRepoOf(source.ref) : null
  }
}

/** claude 侧已装插件键（installed_plugins.json 的 plugins ∪ settings.json 的 enabledPlugins；任一来源缺失/坏 JSON 按未命中容错；plugin-inventory 的市场聚合复用） */
export function claudePluginKeys(home: string): Set<string> {
  const keys = new Set<string>()
  const collect = (file: string, container: string) => {
    try {
      const record = readJsonSafe(file)[container]
      if (record && typeof record === 'object' && !Array.isArray(record)) for (const key of Object.keys(record)) keys.add(key)
    } catch {
      // 读失败容错：该来源按未命中处理
    }
  }
  collect(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), 'plugins')
  collect(claudeSettingsFile(home), 'enabledPlugins')
  return keys
}

/** §8.4/§8.6 marketplace.json 的 plugins[] 宽松映射（listMarketplacePlugins 与 registeredMarketplaces 共用）：
 *  name 必填（缺 name/非对象条目跳过；其余字符串字段缺失省略），installed 与 claude 已装键交叉（name@市场名 命中即 true） */
export function mapMarketplacePlugins(entries: unknown, marketName: string, installedKeys: Set<string>): MarketplacePluginInfo[] {
  const plugins: MarketplacePluginInfo[] = []
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    const name = typeof record.name === 'string' ? record.name.trim() : ''
    if (!name) continue
    const info: MarketplacePluginInfo = { name }
    for (const field of ['description', 'category', 'version', 'author'] as const) {
      if (typeof record[field] === 'string') info[field] = record[field]
    }
    if (installedKeys.has(`${name}@${marketName}`)) info.installed = true
    plugins.push(info)
  }
  return plugins
}

/** §8.4 市场插件清单：plugins[] 宽松映射 + installed 与 claude 已装键交叉 */
export function listMarketplacePlugins(root: string, home: string, id: string, assetPath: string): MarketplacePluginInfo[] {
  const { parsed, name: marketName } = readMarketplaceJson(root, id, assetPath)
  return mapMarketplacePlugins(parsed.plugins, marketName, claudePluginKeys(home))
}

/** 一键注册为插件市场：claude/zcode 各自成败独立返回；已注册 = 该侧幂等成功不覆盖 */
export function registerMarketplaceAsset(root: string, home: string, id: string, assetPath: string): MarketplaceRegisterResult {
  const asset = readMarketplaceAsset(root, id, assetPath)
  const result: MarketplaceRegisterResult = { claudeName: null, zcodeId: null, pluginCount: asset.pluginCount }
  if (!asset.repo) {
    const reason = '仅支持 github 仓库源（owner/repo），local/非 github 源无法注册为插件市场'
    result.claudeError = reason
    result.zcodeError = reason
    return result
  }
  try {
    registerMarketplaceToClaude(home, asset.name, asset.repo)
    result.claudeName = asset.name
  } catch (error) {
    result.claudeError = error instanceof Error ? error.message : String(error)
  }
  try {
    registerMarketplaceToZcode(home, asset.name, {
      repo: asset.repo,
      name: asset.name,
      description: asset.description,
      pluginCount: asset.pluginCount
    })
    result.zcodeId = asset.name
  } catch (error) {
    result.zcodeError = error instanceof Error ? error.message : String(error)
  }
  return result
}
