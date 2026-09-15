// 扩展模块 IPC：MCP/Hooks 资产 CRUD + 三 CLI 用户级配置安装、插件盘点/启停、扩展源仓库
// 目标路径全部由主进程从 os.homedir() 推导（渲染层不传路径）；targetId 只接受注册表白名单
import { ipcMain } from 'electron'
import os from 'node:os'
import path from 'node:path'
import {
  claudeConfigFile,
  claudeMcpContainer,
  hookState,
  installHookToClaude,
  installHookToZcode,
  installMcpToClaude,
  installMcpToCodex,
  installMcpToZcode,
  mcpState,
  setClaudePluginEnabled,
  uninstallHookFromClaude,
  uninstallHookFromZcode,
  uninstallMcpFromCodex,
  uninstallMcpFromJson,
  zcodeConfigFile,
  zcodeMcpContainer
} from '../config-editor'
import { assertMcpTransport, deleteMcp, listMcp, readMcp, saveMcp } from '../mcp-store'
import { assertHookEvents, deleteHook, listHooks, readHook, saveHook } from '../hook-store'
import { marketplaceStatus, pluginInventory, registeredMarketplaces } from '../plugin-inventory'
import { installClaudePlugin, uninstallClaudePlugin } from '../plugin-cli'
import { EXTENSION_CATALOG } from '../extension-catalog'
import { addSource, browseSource, importSkillFromSource, installSkillsFromUrl, listMarketplacePlugins, listSkillGroups, listSources, quickAddSource, registerMarketplaceAsset, removeSource, syncSource } from '../sources'
import { ensureSharedDir } from '../skills'
import { parseContent, parseId } from '../ipc-validation'
import type { HookTarget, McpTarget } from '../../shared/extensions'
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

/** MCP 目标注册表（§3.8：claude/zcode/codex） */
const MCP_TARGET_IDS = ['claude', 'zcode', 'codex'] as const
const MCP_TARGET_META: Record<(typeof MCP_TARGET_IDS)[number], { label: string; hint: string }> = {
  claude: { label: 'Claude Code', hint: '~/.claude.json' },
  zcode: { label: 'ZCode', hint: '~/.zcode/cli/config.json' },
  codex: { label: 'Codex', hint: '~/.codex/config.toml' }
}

function mcpTargetById(targetId: string): McpTarget {
  const id = MCP_TARGET_IDS.find((item) => item === targetId)
  if (!id) throw new Error(`未知安装目标: ${targetId}`)
  return { id, ...MCP_TARGET_META[id] }
}

/** Hook 目标注册表（v1：claude/zcode，两者结构同形；codex 无 hook 目标） */
const HOOK_TARGET_IDS = ['claude', 'zcode'] as const
const HOOK_TARGET_META: Record<(typeof HOOK_TARGET_IDS)[number], { label: string; hint: string }> = {
  claude: { label: 'Claude Code', hint: '~/.claude/settings.json' },
  zcode: { label: 'ZCode', hint: '~/.zcode/cli/config.json' }
}

function hookTargetById(targetId: string): HookTarget {
  const id = HOOK_TARGET_IDS.find((item) => item === targetId)
  if (!id) throw new Error(`未知安装目标: ${targetId}`)
  return { id, ...HOOK_TARGET_META[id] }
}

const PLUGIN_CLI_DIRS = { claude: '.claude', zcode: '.zcode/cli/plugins', codex: '.codex/plugins' } as const

export function registerExtensionsIpc(ctx: IpcContext) {
  // 用户级配置的路径一律主进程推导，渲染层只见 targetId
  const home = () => os.homedir()

  // === MCP ===
  ipcMain.handle('mcp:list', () => {
    ensureSharedDir(ctx.sharedDir)
    return { servers: listMcp(ctx.sharedDir) }
  })
  ipcMain.handle('mcp:save', (_e, def: unknown, originName: unknown) => {
    const body = record(def, 'MCP 参数')
    assertKeys(body, ['name', 'description', 'transport'], 'MCP 参数')
    if (typeof body.description !== 'string') throw new Error('description 必须是字符串')
    return saveMcp(
      ctx.sharedDir,
      { name: parseId(body.name, 'name'), description: body.description, transport: assertMcpTransport(body.transport) },
      optionalString(originName, 'originName')
    )
  })
  ipcMain.handle('mcp:delete', (_e, name: unknown) => {
    deleteMcp(ctx.sharedDir, parseId(name, 'name'))
    return { ok: true }
  })
  ipcMain.handle('mcp:targets', () => {
    ensureSharedDir(ctx.sharedDir)
    const targets = MCP_TARGET_IDS.map((id) => mcpTargetById(id))
    const states: Record<string, Record<string, string>> = {}
    for (const server of listMcp(ctx.sharedDir)) {
      states[server.name] = Object.fromEntries(targets.map((target) => [target.id, mcpState(home(), target.id, server.name, server.transport)]))
    }
    return { targets, states }
  })
  ipcMain.handle('mcp:install', (_e, name: unknown, targetId: unknown) => {
    const target = mcpTargetById(parseId(targetId, 'targetId'))
    const def = readMcp(ctx.sharedDir, parseId(name, 'name'))
    if (!def) throw new Error(`MCP 服务器不存在: ${String(name)}`)
    if (target.id === 'claude') installMcpToClaude(home(), def.name, def.transport)
    else if (target.id === 'zcode') installMcpToZcode(home(), def.name, def.transport)
    else {
      const result = installMcpToCodex(home(), def.name, def.transport)
      if (result.skipped) return { ok: false, error: result.reason }
    }
    return { ok: true }
  })
  ipcMain.handle('mcp:uninstall', (_e, name: unknown, targetId: unknown) => {
    const target = mcpTargetById(parseId(targetId, 'targetId'))
    const def = readMcp(ctx.sharedDir, parseId(name, 'name'))
    if (!def) throw new Error(`MCP 服务器不存在: ${String(name)}`)
    if (target.id === 'claude') uninstallMcpFromJson(claudeConfigFile(home()), claudeMcpContainer, def.name)
    else if (target.id === 'zcode') uninstallMcpFromJson(zcodeConfigFile(home()), zcodeMcpContainer, def.name)
    else uninstallMcpFromCodex(home(), def.name)
    return { ok: true }
  })

  // === Hooks ===
  ipcMain.handle('hooks:list', () => {
    ensureSharedDir(ctx.sharedDir)
    return { hooks: listHooks(ctx.sharedDir) }
  })
  ipcMain.handle('hooks:get', (_e, name: unknown) => {
    ensureSharedDir(ctx.sharedDir)
    return readHook(ctx.sharedDir, parseId(name, 'name'))
  })
  ipcMain.handle('hooks:save', (_e, name: unknown, input: unknown) => {
    const body = record(input, 'Hook 参数')
    assertKeys(body, ['description', 'body', 'events', 'originName'], 'Hook 参数')
    const description = optionalString(body.description, 'description')
    const hookBody = optionalString(body.body, 'body')
    if (description === undefined || hookBody === undefined) throw new Error('description/body 不能缺省')
    return saveHook(
      ctx.sharedDir,
      parseId(name, 'name'),
      {
        description,
        body: hookBody,
        events: assertHookEvents(body.events),
        ...(body.originName !== undefined ? { originName: optionalString(body.originName, 'originName') } : {})
      }
    )
  })
  ipcMain.handle('hooks:delete', (_e, name: unknown) => {
    deleteHook(ctx.sharedDir, parseId(name, 'name'))
    return { ok: true }
  })
  ipcMain.handle('hooks:targets', () => {
    ensureSharedDir(ctx.sharedDir)
    const targets = HOOK_TARGET_IDS.map((id) => hookTargetById(id))
    const states: Record<string, Record<string, string>> = {}
    for (const hook of listHooks(ctx.sharedDir)) {
      states[hook.name] = Object.fromEntries(targets.map((target) => [target.id, hookState(home(), target.id, hook.events)]))
    }
    return { targets, states }
  })
  ipcMain.handle('hooks:install', (_e, name: unknown, targetId: unknown) => {
    const target = hookTargetById(parseId(targetId, 'targetId'))
    const def = readHook(ctx.sharedDir, parseId(name, 'name'))
    if (!def) throw new Error(`Hook 不存在: ${String(name)}`)
    if (target.id === 'claude') installHookToClaude(home(), def.name, def.events)
    else installHookToZcode(home(), def.name, def.events)
    return { ok: true }
  })
  ipcMain.handle('hooks:uninstall', (_e, name: unknown, targetId: unknown) => {
    const target = hookTargetById(parseId(targetId, 'targetId'))
    const def = readHook(ctx.sharedDir, parseId(name, 'name'))
    if (!def) throw new Error(`Hook 不存在: ${String(name)}`)
    if (target.id === 'claude') uninstallHookFromClaude(home(), def.name, def.events)
    else uninstallHookFromZcode(home(), def.name, def.events)
    return { ok: true }
  })

  // === 插件 ===
  ipcMain.handle('plugins:inventory', () => ({ items: pluginInventory(home()) }))
  ipcMain.handle('plugins:set-enabled', (_e, input: unknown) => {
    const body = record(input, '插件参数')
    assertKeys(body, ['cli', 'name', 'marketplace', 'enabled'], '插件参数')
    if (body.cli !== 'claude') throw new Error('插件启停仅支持 claude 目标')
    if (typeof body.enabled !== 'boolean') throw new Error('enabled 必须是布尔值')
    setClaudePluginEnabled(home(), parseId(body.name, 'name'), parseId(body.marketplace, 'marketplace'), body.enabled)
    return { ok: true }
  })
  ipcMain.handle('plugins:open-dir', async (_e, cli: unknown) => {
    if (typeof cli !== 'string' || !(cli in PLUGIN_CLI_DIRS)) throw new Error(`未知 CLI: ${String(cli)}`)
    const { shell } = await import('electron')
    await shell.openPath(path.join(home(), PLUGIN_CLI_DIRS[cli as keyof typeof PLUGIN_CLI_DIRS]))
  })
  // 装卸借 claude 官方 CLI 代跑（v1 仅 claude；spec 形状在 plugin-cli 内再校验一次）
  ipcMain.handle('plugins:install', (_e, input: unknown) => {
    const body = record(input, '插件参数')
    assertKeys(body, ['cli', 'spec'], '插件参数')
    if (body.cli !== 'claude') throw new Error('插件装卸 v1 仅支持 claude')
    return installClaudePlugin(home(), parseContent(body.spec, 'spec'))
  })
  ipcMain.handle('plugins:uninstall', (_e, input: unknown) => {
    const body = record(input, '插件参数')
    assertKeys(body, ['cli', 'spec'], '插件参数')
    if (body.cli !== 'claude') throw new Error('插件装卸 v1 仅支持 claude')
    return uninstallClaudePlugin(home(), parseContent(body.spec, 'spec'))
  })

  // === 插件市场 ===
  ipcMain.handle('marketplaces:status', () => marketplaceStatus(home()))
  // §8.6 聚合三来源已注册市场（AgentDeck 源 + claude/zcode 市场缓存），渲染层「浏览市场」
  ipcMain.handle('marketplaces:list-registered', () => ({ marketplaces: registeredMarketplaces(ctx.sharedDir, home()) }))
  ipcMain.handle('marketplaces:register', (_e, sourceId: unknown, assetPath: unknown) =>
    registerMarketplaceAsset(ctx.sharedDir, home(), parseId(sourceId, 'sourceId'), parseContent(assetPath, 'assetPath'))
  )
  ipcMain.handle('marketplaces:list-plugins', (_e, sourceId: unknown, assetPath: unknown) => ({
    plugins: listMarketplacePlugins(ctx.sharedDir, home(), parseId(sourceId, 'sourceId'), parseContent(assetPath, 'assetPath'))
  }))

  // === 扩展源仓库 ===
  ipcMain.handle('sources:catalog', () => ({ entries: EXTENSION_CATALOG }))
  ipcMain.handle('sources:list', () => {
    ensureSharedDir(ctx.sharedDir)
    return { sources: listSources(ctx.sharedDir) }
  })
  // §8.7 技能 tab「发现」区：全部已添加源的技能资产按源聚合（无参）
  ipcMain.handle('sources:list-skills', () => {
    ensureSharedDir(ctx.sharedDir)
    return { groups: listSkillGroups(ctx.sharedDir) }
  })
  ipcMain.handle('sources:add', (_e, ref: unknown, name: unknown) => {
    return addSource(ctx.sharedDir, parseContent(ref, 'ref'), optionalString(name, 'name'))
  })
  ipcMain.handle('sources:quick-add', (_e, ref: unknown, name: unknown) => {
    return quickAddSource(ctx.sharedDir, parseContent(ref, 'ref'), optionalString(name, 'name'))
  })
  // §8.6 从 URL 一键装技能（校验同 sources:add 的 ref）
  ipcMain.handle('skills:install-from-url', (_e, ref: unknown) => installSkillsFromUrl(ctx.sharedDir, parseContent(ref, 'ref')))
  ipcMain.handle('sources:remove', (_e, id: unknown) => {
    removeSource(ctx.sharedDir, parseId(id, 'id'))
    return { ok: true }
  })
  ipcMain.handle('sources:sync', (_e, id: unknown) => syncSource(ctx.sharedDir, parseId(id, 'id')))
  ipcMain.handle('sources:browse', (_e, id: unknown) => ({ assets: browseSource(ctx.sharedDir, parseId(id, 'id')) }))
  ipcMain.handle('sources:import-skill', (_e, id: unknown, relPath: unknown) => {
    return importSkillFromSource(ctx.sharedDir, parseId(id, 'id'), parseContent(relPath, 'relPath'))
  })
}
