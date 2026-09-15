// smoke-extensions.mjs：扩展模块冒烟（按 docs/EXTENSIONS-HUB.md §5 + §8.1 + §8.4 + §8.5 + §8.6 + §8.7）
// 覆盖：mcp-store CRUD/非法 transport/逃逸、config-editor JSON 与 codex TOML（.agentdeck-bak 备份）、
// hook-store + 双目标安装卸载、plugin-inventory 三 CLI 容错、sources local/git 全链路（本地 fixture 仓库，不联网）、catalog、
// 插件市场闭环（注册/状态/装卸：假 home + 假 claude CLI 垫片，绝不 spawn 真 claude）
// 目录/家目录全部参数注入临时目录，绝不碰真实 ~/.claude ~/.zcode ~/.codex
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-ext-smoke-'))
const bundles = {}
for (const name of ['mcp-store', 'hook-store', 'config-editor', 'plugin-inventory', 'plugin-cli', 'sources', 'extension-catalog']) {
  const file = path.join(outDir, `${name}.cjs`)
  await build({ entryPoints: [path.join(root, 'src/main', `${name}.ts`)], outfile: file, bundle: true, platform: 'node', format: 'cjs', target: 'node18' })
  bundles[name] = await import(pathToFileURL(file).href)
}
const mcp = bundles['mcp-store']
const hooks = bundles['hook-store']
const editor = bundles['config-editor']
const plugins = bundles['plugin-inventory']
const pluginCli = bundles['plugin-cli']
const sources = bundles['sources']
const catalog = bundles['extension-catalog']

let failed = 0
const ok = (condition, label) => {
  console.log(`  ${condition ? 'OK' : 'FAIL'} ${label}`)
  if (!condition) failed++
}
const expectReject = (fn, label) => {
  try { fn(); ok(false, `${label}（应拒绝却通过了）`) } catch { ok(true, label) }
}
const expectRejectAsync = async (fn, label) => {
  try { await fn(); ok(false, `${label}（应拒绝却通过了）`) } catch { ok(true, label) }
}
const shared = path.join(outDir, 'shared')
const home = path.join(outDir, 'home')

// === 场景 1：mcp-store save/list/read/rename/delete + 非法 transport + 名字逃逸 ===
console.log('场景 1：mcp-store')
const stdio = { type: 'stdio', command: 'uvx', args: ['mcp-server-git'], env: { RUST_LOG: 'info' } }
const meta = mcp.saveMcp(shared, { name: 'git-mcp', description: 'Git 仓库 MCP', transport: stdio })
ok(meta.name === 'git-mcp' && meta.file.endsWith(path.join('mcp', 'git-mcp.mcp.json')) && meta.updatedAt > 0, 'saveMcp 返回 McpMeta')
ok(mcp.readMcp(shared, 'git-mcp').transport.command === 'uvx', 'readMcp transport 往返')
mcp.saveMcp(shared, { name: 'remote', description: '远端', transport: { type: 'http', url: 'https://mcp.example/sse', headers: { Authorization: 'Bearer t' } } })
mcp.saveMcp(shared, { name: 'legacy', description: 'sse', transport: { type: 'sse', url: 'https://mcp.example/legacy' } })
const metas = mcp.listMcp(shared)
ok(metas.map((item) => item.name).join(',') === 'git-mcp,legacy,remote', 'listMcp 名字升序')
ok(mcp.readMcp(shared, 'remote').transport.type === 'http' && mcp.readMcp(shared, 'legacy').transport.type === 'sse', 'http/sse 往返')
mcp.saveMcp(shared, { name: 'renamed', description: '改名', transport: stdio, }, 'git-mcp')
ok(!fs.existsSync(path.join(shared, 'mcp', 'git-mcp.mcp.json')) && fs.existsSync(path.join(shared, 'mcp', 'renamed.mcp.json')), '重命名即文件改名')
expectReject(() => mcp.saveMcp(shared, { name: 'remote', description: '', transport: stdio }, 'renamed'), '重命名到已存在名字被拒绝')
for (const [label, transport] of [
  ['未知 type', { type: 'ws', url: 'wss://x' }],
  ['stdio 缺 command', { type: 'stdio' }],
  ['stdio 未知字段', { type: 'stdio', command: 'x', junk: 1 }],
  ['stdio args 非字符串数组', { type: 'stdio', command: 'x', args: [1] }],
  ['stdio env 值非字符串', { type: 'stdio', command: 'x', env: { A: 2 } }],
  ['http 缺 url', { type: 'http' }],
  ['http 未知字段', { type: 'http', url: 'https://x', timeoutMs: 5 }]
]) {
  expectReject(() => mcp.saveMcp(shared, { name: 'bad', description: '', transport }), `saveMcp 拒绝非法 transport（${label}）`)
}
for (const bad of ['../evil', 'a/b', 'a\\b', '', 'Upper']) {
  expectReject(() => mcp.saveMcp(shared, { name: bad, description: '', transport: stdio }), `saveMcp 拒绝非法名: ${JSON.stringify(bad)}`)
}
expectReject(() => mcp.deleteMcp(shared, '../evil'), 'deleteMcp 拒绝 .. 逃逸')
ok(!fs.existsSync(path.join(shared, 'evil.mcp.json')) && !fs.existsSync(path.join(outDir, 'evil.mcp.json')), '逃逸尝试没有在共享目录外留下文件')
fs.writeFileSync(path.join(shared, 'mcp', 'broken.mcp.json'), '{oops')
ok(!mcp.listMcp(shared).some((item) => item.name === 'broken'), '坏 JSON 文件被 list 跳过')
mcp.deleteMcp(shared, 'renamed')
mcp.deleteMcp(shared, 'legacy')
ok(!mcp.listMcp(shared).some((item) => item.name === 'renamed'), 'deleteMcp 移除条目')

// === 场景 2：config-editor JSON（claude / zcode）+ .agentdeck-bak ===
console.log('场景 2：config-editor JSON')
fs.mkdirSync(home, { recursive: true })
const claudeJson = path.join(home, '.claude.json')
fs.writeFileSync(claudeJson, JSON.stringify({ model: 'opus', mcpServers: { other: { type: 'stdio', command: 'keep-me' } } }))
editor.installMcpToClaude(home, 'git-mcp', stdio)
const claudeConfig = JSON.parse(fs.readFileSync(claudeJson, 'utf8'))
ok(claudeConfig.model === 'opus' && claudeConfig.mcpServers.other.command === 'keep-me', 'claude 装入后其它键/服务器原样')
ok(claudeConfig.mcpServers['git-mcp'].args[0] === 'mcp-server-git', 'claude mcpServers[name] 写入')
const claudeBak = path.join(home, '.claude.json.agentdeck-bak')
ok(fs.existsSync(claudeBak), '.agentdeck-bak 备份生成')
ok(JSON.parse(fs.readFileSync(claudeBak, 'utf8')).mcpServers && !JSON.parse(fs.readFileSync(claudeBak, 'utf8')).mcpServers['git-mcp'], '备份内容是装入前状态')
// 已存在 .bak 不覆盖：再改配置再装入，备份仍是最初状态
editor.installMcpToClaude(home, 'git-mcp', { ...stdio, args: ['changed'] })
ok(JSON.parse(fs.readFileSync(claudeBak, 'utf8')).mcpServers.other.command === 'keep-me' && !JSON.parse(fs.readFileSync(claudeBak, 'utf8')).mcpServers['git-mcp'], '已存在 .bak 不被覆盖')
// undefined 字段剥离：args undefined 不落盘
editor.installMcpToClaude(home, 'no-args', { type: 'stdio', command: 'x', args: undefined })
ok(!('args' in JSON.parse(fs.readFileSync(claudeJson, 'utf8')).mcpServers['no-args']), 'claude 装入剥离 undefined 字段')
// zcode：嵌套 mcp.servers + 严格 canonical（未知字段剥离，cwd 保留）
const zcodeJson = path.join(home, '.zcode', 'cli', 'config.json')
fs.mkdirSync(path.dirname(zcodeJson), { recursive: true })
fs.writeFileSync(zcodeJson, JSON.stringify({ theme: 'dark', other: { nested: true } }))
editor.installMcpToZcode(home, 'git-mcp', { type: 'stdio', command: 'uvx', args: ['a'], env: { K: 'V' }, cwd: '/work', junk: 'strip-me' })
const zcodeConfig = JSON.parse(fs.readFileSync(zcodeJson, 'utf8'))
ok(zcodeConfig.theme === 'dark' && zcodeConfig.other.nested === true, 'zcode 装入后其它键原样')
const zInstalled = zcodeConfig.mcp.servers['git-mcp']
ok(zInstalled && zInstalled.command === 'uvx' && zInstalled.cwd === '/work', 'zcode mcp.servers 嵌套两级写入')
ok(!('junk' in zInstalled) && !('timeoutMs' in zInstalled), 'zcode 剥离 canonical 以外字段')
editor.installMcpToZcode(home, 'remote-mcp', { type: 'http', url: 'https://mcp.example', headers: { A: 'b' } })
ok(JSON.parse(fs.readFileSync(zcodeJson, 'utf8')).mcp.servers['remote-mcp'].url === 'https://mcp.example', 'zcode http canonical（type/url/headers）')
// 状态判定：装后 in-sync，改动 outdated
ok(editor.mcpState(home, 'claude', 'git-mcp', { ...stdio, args: ['changed'] }) === 'in-sync', 'claude 状态 in-sync')
ok(editor.mcpState(home, 'zcode', 'git-mcp', { type: 'stdio', command: 'uvx', args: ['a'], env: { K: 'V' }, cwd: '/work', junk: 'x' }) === 'in-sync', 'zcode 状态 in-sync（canonical 归一化剥 junk）')
ok(editor.mcpState(home, 'claude', 'git-mcp', { ...stdio, args: ['changed'], env: { RUST_LOG: 'debug' } }) === 'outdated', '改动后 outdated')
ok(editor.mcpState(home, 'claude', 'absent', stdio) === 'missing' && editor.mcpState(home, 'codex', 'git-mcp', stdio) === 'missing', '未安装为 missing')
// 卸载：删自己的键，保留其它键；删空保留空容器
ok(editor.uninstallMcpFromJson(claudeJson, editor.claudeMcpContainer, 'git-mcp'), 'claude 卸载发生删除')
const afterUninstall = JSON.parse(fs.readFileSync(claudeJson, 'utf8'))
ok(!afterUninstall.mcpServers['git-mcp'] && afterUninstall.mcpServers.other.command === 'keep-me' && afterUninstall.model === 'opus', 'claude 卸载只删自己的键')
editor.uninstallMcpFromJson(claudeJson, editor.claudeMcpContainer, 'no-args')
ok(JSON.parse(fs.readFileSync(claudeJson, 'utf8')).mcpServers.other.command === 'keep-me', '卸载不惊扰其它键')
// 容器删空保留空对象（专用文件验证，不受种子里的 other 服务器影响）
const soloJson = path.join(home, 'solo.json')
fs.writeFileSync(soloJson, JSON.stringify({ mcpServers: { only: { type: 'stdio', command: 'x' } }, note: 'keep' }))
editor.uninstallMcpFromJson(soloJson, editor.claudeMcpContainer, 'only')
const emptied = JSON.parse(fs.readFileSync(soloJson, 'utf8'))
ok(emptied.mcpServers && Object.keys(emptied.mcpServers).length === 0 && emptied.note === 'keep', 'mcpServers 删空保留空对象')

// === 场景 3：config-editor TOML（codex 块级文本操作） ===
console.log('场景 3：config-editor TOML')
const codexToml = path.join(home, '.codex', 'config.toml')
fs.mkdirSync(path.dirname(codexToml), { recursive: true })
fs.writeFileSync(codexToml, '# 用户手工注释\n[profile.dev]\nmodel = "gpt"\n\n[mcp_servers.keep]\ncommand = "keep-cmd"\n')
const tricky = { type: 'stdio', command: 'C:\\tools\\my tool.exe', args: ['--flag "quoted"', 'a\nb'], env: { TOKEN: 'a"b' } }
ok(editor.installMcpToCodex(home, 'tricky', tricky).ok === true, 'codex 装入 stdio 返回 ok')
const tomlText = fs.readFileSync(codexToml, 'utf8')
ok(tomlText.includes('[mcp_servers.tricky]') && tomlText.includes('[mcp_servers.tricky.env]'), 'codex 生成块头与 env 子表')
ok(tomlText.includes('"C:\\\\tools\\\\my tool.exe"') && tomlText.includes('"--flag \\"quoted\\""') && tomlText.includes('"a\\nb"'), 'codex 字符串/数组转义正确')
ok(tomlText.includes('[profile.dev]') && tomlText.includes('command = "keep-cmd"') && tomlText.includes('# 用户手工注释'), 'codex 其它 TOML 内容不动')
ok(editor.mcpState(home, 'codex', 'tricky', tricky) === 'in-sync', 'codex 状态 in-sync（TOML 块解析回同形对象）')
ok(editor.mcpState(home, 'codex', 'tricky', { ...tricky, args: ['changed'] }) === 'outdated', 'codex 改动后 outdated')
// 重装替换不残留
editor.installMcpToCodex(home, 'tricky', { type: 'stdio', command: 'new-cmd', args: ['only'] })
const reinstalled = fs.readFileSync(codexToml, 'utf8')
ok(reinstalled.includes('command = "new-cmd"') && !reinstalled.includes('my tool.exe') && !reinstalled.includes('TOKEN'), 'codex 重装替换不残留旧块')
ok((reinstalled.match(/\[mcp_servers\.tricky]/g) || []).length === 1, 'codex 重装只保留一个块')
// http/sse 跳过并注明
const skipped = editor.installMcpToCodex(home, 'remote-mcp', { type: 'http', url: 'https://mcp.example' })
ok(skipped.ok === false && skipped.skipped === true && skipped.reason.includes('stdio'), 'codex 对非 stdio 跳过并注明')
ok(!fs.readFileSync(codexToml, 'utf8').includes('mcp_servers.remote-mcp'), '跳过不落盘')
// 备份 + 卸载
ok(fs.existsSync(path.join(home, '.codex', 'config.toml.agentdeck-bak')), 'codex .agentdeck-bak 备份生成')
ok(editor.uninstallMcpFromCodex(home, 'tricky'), 'codex 卸载删除块')
const afterCodexUninstall = fs.readFileSync(codexToml, 'utf8')
ok(!afterCodexUninstall.includes('mcp_servers.tricky') && afterCodexUninstall.includes('command = "keep-cmd"') && afterCodexUninstall.includes('[profile.dev]'), 'codex 卸载不伤其它块')
ok(editor.mcpState(home, 'codex', 'tricky', tricky) === 'missing', 'codex 卸载后 missing')

// === 场景 4：hook-store + 双目标安装/卸载 ===
console.log('场景 4：hook-store 与安装')
const events = {
  PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node guard.js', timeoutMs: 30 }, { type: 'command', command: 'node log.js' }] }],
  Stop: [{ hooks: [{ type: 'command', command: 'node stop.js' }] }]
}
const hookMeta = hooks.saveHook(shared, 'guard', { description: '命令守卫', body: '# 说明\n守卫所有 Bash 调用', events })
ok(hookMeta.name === 'guard' && hookMeta.events.PreToolUse.length === 1 && hookMeta.dir.endsWith(path.join('hooks', 'guard')), 'saveHook 返回 HookMeta')
const hookDetail = hooks.readHook(shared, 'guard')
ok(hookDetail.body === '# 说明\n守卫所有 Bash 调用' && hookDetail.description === '命令守卫', 'readHook body 为去 frontmatter 正文')
const hookMd = fs.readFileSync(path.join(shared, 'hooks', 'guard', 'HOOK.md'), 'utf8')
ok(hookMd.startsWith('---\nname: guard\ndescription: 命令守卫\n---'), 'HOOK.md frontmatter 落盘')
ok(JSON.parse(fs.readFileSync(path.join(shared, 'hooks', 'guard', 'hook.json'), 'utf8')).events.Stop.length === 1, 'hook.json 事件定义落盘')
for (const [label, input] of [
  ['事件名非法', { description: '', body: '', events: { '1bad': [{ hooks: [{ type: 'command', command: 'x' }] }] } }],
  ['组缺 hooks', { description: '', body: '', events: { Stop: [{ matcher: 'A' }] } }],
  ['未知字段', { description: '', body: '', events: { Stop: [{ hooks: [], junk: 1 }] } }],
  ['type 非 command', { description: '', body: '', events: { Stop: [{ hooks: [{ type: 'prompt', command: 'x' }] }] } }],
  ['command 空', { description: '', body: '', events: { Stop: [{ hooks: [{ type: 'command', command: ' ' }] }] } }],
  ['timeoutMs 非正数', { description: '', body: '', events: { Stop: [{ hooks: [{ type: 'command', command: 'x', timeoutMs: 0 }] }] } }]
]) {
  expectReject(() => hooks.saveHook(shared, 'bad-hook', input), `saveHook 拒绝非法 events（${label}）`)
}
hooks.saveHook(shared, 'guard-renamed', { description: '', body: '', events: {}, originName: 'guard' })
ok(!fs.existsSync(path.join(shared, 'hooks', 'guard')) && fs.existsSync(path.join(shared, 'hooks', 'guard-renamed')), '重命名即目录改名')
hooks.saveHook(shared, 'guard', { description: '命令守卫', body: '# 说明\n守卫所有 Bash 调用', events, originName: 'guard-renamed' })
// 安装：claude + zcode
editor.installHookToClaude(home, 'guard', events)
const claudeSettings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'))
ok(claudeSettings.hooks.PreToolUse.some((group) => group.matcher === 'Bash' && group.hooks.length === 2), 'claude settings.json hooks 组写入')
editor.installHookToZcode(home, 'guard', events)
const zcodeHooks = JSON.parse(fs.readFileSync(zcodeJson, 'utf8')).hooks
ok(zcodeHooks.enabled === true, 'zcode hooks.enabled = true')
ok(zcodeHooks.events.Stop.length === 1 && zcodeHooks.events.PreToolUse.length === 1, 'zcode hooks.events 同形合并')
ok(editor.hookState(home, 'claude', events) === 'in-sync' && editor.hookState(home, 'zcode', events) === 'in-sync', 'hook 状态 in-sync')
expectReject(() => editor.hookState(home, 'codex', events), 'hookState 拒绝未知目标')
// 用户手工加的其它组保留 + 卸载按 command 集合匹配
claudeSettings.hooks.PreToolUse.push({ matcher: 'Write', hooks: [{ type: 'command', command: 'user-own.js' }] })
fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify(claudeSettings))
ok(editor.uninstallHookFromClaude(home, 'guard', events), 'claude 卸载发生删除')
const claudeAfter = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'))
ok(!claudeAfter.hooks.PreToolUse.some((group) => group.hooks.some((hook) => hook.command === 'node guard.js')), 'claude 卸载移除我们的组')
ok(claudeAfter.hooks.PreToolUse.some((group) => group.hooks.some((hook) => hook.command === 'user-own.js')), '用户手工组保留')
ok(!('Stop' in claudeAfter.hooks), '事件数组删空则删除该事件键')
// zcode 卸载：events 删空 → 整个 hooks 键删除
ok(editor.uninstallHookFromZcode(home, 'guard', events), 'zcode 卸载发生删除')
const zcodeAfter = JSON.parse(fs.readFileSync(zcodeJson, 'utf8'))
ok(!('hooks' in zcodeAfter), 'zcode events 删空删除整个 hooks 键')
ok(editor.hookState(home, 'claude', events) === 'missing', 'hook 卸载后 missing')

// === 场景 5：plugin-inventory 三 CLI + 容错 + claude 启停 ===
console.log('场景 5：plugin-inventory')
fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({
  // cadence@cadence：enabledPlugins 有键而 installed_plugins.json 无对应（真实环境 `claude plugin uninstall` 残留的幽灵键）
  enabledPlugins: { 'superpowers@claude-plugins-official': true, 'hud@claude-hud': false, 'cadence@cadence': true },
  extraKnownMarketplaces: { 'claude-hud': { source: { source: 'github', repo: 'x/hud' } } }
}))
fs.mkdirSync(path.join(home, '.claude', 'plugins'), { recursive: true })
fs.writeFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({
  version: 2,
  plugins: {
    'superpowers@claude-plugins-official': [{ scope: 'user', installPath: path.join(home, '.claude', 'plugins', 'cache', 'superpowers'), version: '1.2.0' }],
    'hud@claude-hud': [{ scope: 'user', installPath: path.join(home, '.claude', 'plugins', 'cache', 'hud'), version: '0.4.1' }]
  }
}))
fs.mkdirSync(path.join(home, '.zcode', 'cli', 'plugins', 'cache', 'zcode-plugins-official', 'browser-use', '0.2.1'), { recursive: true })
fs.mkdirSync(path.join(home, '.zcode', 'cli', 'plugins', 'cache', 'zcode-plugins-official', 'browser-use', '0.10.0'), { recursive: true })
fs.writeFileSync(path.join(home, '.zcode', 'cli', 'plugins', 'known_marketplaces.json'), JSON.stringify({ version: 1, marketplaces: [{ id: 'zcode-plugins-official', name: 'zcode-plugins-official', pluginCount: 24 }] }))
fs.mkdirSync(path.join(home, '.codex', 'plugins', 'cache', 'codex-skill'), { recursive: true })
const items = plugins.pluginInventory(home)
const claudeItems = items.filter((item) => item.cli === 'claude')
const zcodeItems = items.filter((item) => item.cli === 'zcode')
const codexItems = items.filter((item) => item.cli === 'codex')
ok(claudeItems.some((item) => item.kind === 'plugin' && item.name === 'superpowers' && item.marketplace === 'claude-plugins-official' && item.enabled === true), 'claude 插件项（enabled）')
ok(claudeItems.some((item) => item.kind === 'plugin' && item.name === 'hud' && item.enabled === false), 'claude 禁用插件项')
ok(claudeItems.some((item) => item.kind === 'plugin' && item.name === 'superpowers' && item.installed === true), 'claude 正常插件键交叉 installed_plugins.json → installed:true')
ok(claudeItems.some((item) => item.kind === 'plugin' && item.name === 'cadence' && item.enabled === true && item.installed === false), 'claude 幽灵键（enabledPlugins 有而 installed_plugins.json 无）→ installed:false')
ok(claudeItems.some((item) => item.kind === 'marketplace' && item.name === 'claude-hud') && claudeItems.some((item) => item.kind === 'marketplace' && item.name === 'claude-plugins-official'), 'claude 市场项（extraKnownMarketplaces + 官方固定）')
ok(zcodeItems.some((item) => item.kind === 'marketplace' && item.name === 'zcode-plugins-official' && item.description.includes('24')), 'zcode 市场项（pluginCount 入 description）')
const zPlugin = zcodeItems.find((item) => item.kind === 'plugin' && item.name === 'browser-use')
ok(zPlugin && zPlugin.version === '0.10.0' && zPlugin.marketplace === 'zcode-plugins-official', 'zcode 插件项取最高版本')
ok(codexItems.length === 1 && codexItems[0].name === 'codex-skill', 'codex 插件项（cache 一级目录）')
// 缺 CLI 容错：空家目录不报错
const emptyItems = plugins.pluginInventory(path.join(outDir, 'empty-home'))
ok(Array.isArray(emptyItems) && emptyItems.length === 0, '未安装任何 CLI 容错（空清单）')
// claude 启停写回（走备份写回）
editor.setClaudePluginEnabled(home, 'hud', 'claude-hud', true)
ok(JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')).enabledPlugins['hud@claude-hud'] === true, 'setClaudePluginEnabled 写回 true')
editor.setClaudePluginEnabled(home, 'hud', 'claude-hud', false)
ok(JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')).enabledPlugins['hud@claude-hud'] === false, 'setClaudePluginEnabled 写回 false')

// === 场景 6：sources（local + 本地 git fixture） ===
console.log('场景 6：sources')
// local fixture：2 个 SKILL.md + 2 个 marketplace.json（一个带 plugins、一个不带）+ README；.git/node_modules 必须被跳过
const localSrc = path.join(outDir, 'local-source')
fs.mkdirSync(path.join(localSrc, 'skill-one'), { recursive: true })
fs.mkdirSync(path.join(localSrc, 'docs', 'skill-two'), { recursive: true })
fs.mkdirSync(path.join(localSrc, '.claude-plugin'), { recursive: true })
fs.mkdirSync(path.join(localSrc, 'nested', '.claude-plugin'), { recursive: true })
fs.mkdirSync(path.join(localSrc, '.git', 'refs'), { recursive: true })
fs.mkdirSync(path.join(localSrc, 'node_modules', 'fake-skill'), { recursive: true })
fs.writeFileSync(path.join(localSrc, 'README.md'), '# 本地示例源\n\n介绍')
fs.writeFileSync(path.join(localSrc, 'skill-one', 'SKILL.md'), '---\nname: skill-one\ndescription: 第一个技能\n---\nhi')
fs.writeFileSync(path.join(localSrc, 'docs', 'skill-two', 'SKILL.md'), '---\nname: skill-two\ndescription: 第二个技能\n---\nhi')
fs.writeFileSync(path.join(localSrc, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'local-market', description: '本地市场', owner: 'me', plugins: [{ name: 'p1' }, { name: 'p2' }] }))
fs.writeFileSync(path.join(localSrc, 'nested', '.claude-plugin', 'marketplace.json'), JSON.stringify({ description: '无 name 无 plugins' }))
fs.writeFileSync(path.join(localSrc, '.git', 'HEAD'), 'ref: refs/heads/main')
fs.writeFileSync(path.join(localSrc, 'node_modules', 'fake-skill', 'SKILL.md'), '---\nname: fake\ndescription: 不该被发现\n---\n')
const local = sources.addSource(shared, localSrc)
ok(local.kind === 'local' && local.id === 'local-source' && local.name === 'local-source', 'local 源添加（名字取目录名，不 clone）')
ok(!fs.existsSync(path.join(shared, 'sources', 'local-source')), 'local 源不落 clone 目录')
// 已入库技能 → importedAs 提示
fs.mkdirSync(path.join(shared, 'skills', 'skill-one'), { recursive: true })
fs.writeFileSync(path.join(shared, 'skills', 'skill-one', 'SKILL.md'), '---\nname: skill-one\ndescription: 已在库\n---\n')
const assets = sources.browseSource(shared, local.id)
const skillAssets = assets.filter((asset) => asset.kind === 'skill')
ok(assets.some((asset) => asset.kind === 'readme' && asset.description === '本地示例源'), 'browse 发现根 README（首个 # 标题）')
ok(assets.some((asset) => asset.kind === 'marketplace' && asset.name === 'local-market' && asset.path.includes('marketplace.json')), 'browse 发现 marketplace.json')
ok(assets.some((asset) => asset.kind === 'marketplace' && asset.name === 'local-market' && asset.pluginCount === 2), 'browse marketplace 资产解析 pluginCount')
ok(assets.some((asset) => asset.kind === 'marketplace' && asset.pluginCount === undefined), 'plugins 缺失 → pluginCount 省略')
ok(skillAssets.length === 2 && skillAssets.every((asset) => asset.path !== 'node_modules/fake-skill' && asset.path !== '.git'), 'browse 发现 2 个 SKILL.md 且跳过 .git/node_modules')
ok(skillAssets.find((asset) => asset.name === 'skill-one')?.importedAs === 'skill-one', '已入库技能 importedAs 提示')
ok(skillAssets.find((asset) => asset.name === 'skill-two')?.description === '第二个技能', 'SKILL.md description 提取')
// 导入与 -2 去重
ok(sources.importSkillFromSource(shared, local.id, 'skill-one').name === 'skill-one-2', '导入已占名技能自动 -2')
ok(sources.importSkillFromSource(shared, local.id, 'docs/skill-two').name === 'skill-two', '导入嵌套目录技能')
expectReject(() => sources.importSkillFromSource(shared, local.id, '../../outside'), '导入拒绝 .. 逃逸')
expectReject(() => sources.importSkillFromSource(shared, local.id, 'docs'), '导入缺 SKILL.md 目录被拒绝')
ok(!fs.existsSync(path.join(shared, 'skills', 'outside')), '逃逸导入没有落盘')
// 非法 ref
expectReject(() => sources.addSource(shared, 'not-a-url-nor-dir'), 'addSource 拒绝非法 ref')
// 本地 git fixture：目录以 .git 结尾 → git 源 → clone/pull/remove
const gitOrigin = path.join(outDir, 'origin.git')
const git = (args) => {
  const result = spawnSync('git', args, { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout
}
fs.mkdirSync(gitOrigin, { recursive: true })
git(['init', gitOrigin])
fs.writeFileSync(path.join(gitOrigin, 'README.md'), '# Git fixture 源')
git(['-C', gitOrigin, 'add', '-A'])
git(['-C', gitOrigin, '-c', 'user.name=fixture', '-c', 'user.email=fixture@local', 'commit', '-m', 'init'])
const gitSrc = sources.addSource(shared, gitOrigin, 'Git Fixture')
ok(gitSrc.kind === 'git' && gitSrc.id === 'git-fixture', 'git 源添加（本地 fixture，不联网）')
ok(fs.existsSync(path.join(shared, 'sources', 'git-fixture', 'README.md')), 'git 源立即 clone')
const firstSync = gitSrc.lastSyncedAt
// 上游前移 + sync → pull --ff-only
fs.writeFileSync(path.join(gitOrigin, 'NEW.md'), 'new content')
git(['-C', gitOrigin, 'add', '-A'])
git(['-C', gitOrigin, '-c', 'user.name=fixture', '-c', 'user.email=fixture@local', 'commit', '-m', 'update'])
const synced = sources.syncSource(shared, gitSrc.id)
ok(synced.lastSyncedAt !== null && synced.lastSyncedAt >= firstSync, 'sync 刷新 lastSyncedAt')
ok(fs.existsSync(path.join(shared, 'sources', 'git-fixture', 'NEW.md')), 'sync pull --ff-only 拉到上游新提交')
expectReject(() => sources.syncSource(shared, 'no-such-source'), 'sync 未知源被拒绝')
// 注册表往返 + 重名 -2
const listed = sources.listSources(shared)
ok(listed.map((item) => item.id).join(',') === 'local-source,git-fixture', 'sources.json 注册表往返')
const anotherLocal = path.join(outDir, 'another-local')
fs.mkdirSync(anotherLocal, { recursive: true })
const dup = sources.addSource(shared, anotherLocal, 'Local Source')
ok(dup.id === 'local-source-2', '重名源 id 自动 -2')
expectReject(() => sources.syncSource(shared, '../evil'), '源 id 逃逸被拒绝')
// remove：git 删 clone 目录，local 不删原目录
sources.removeSource(shared, gitSrc.id)
ok(!fs.existsSync(path.join(shared, 'sources', 'git-fixture')) && fs.existsSync(path.join(gitOrigin, 'NEW.md')), 'removeSource 删 clone 保留 origin')
sources.removeSource(shared, local.id)
ok(!sources.listSources(shared).some((item) => item.id === local.id) && fs.existsSync(path.join(localSrc, 'README.md')), 'removeSource 不删本地源目录内容')
// §8.5 quick-add：addSource + browseSource 一步编排（本地 fixture 仓库，不联网）；给 origin 补技能/市场资产再前移一次提交
fs.mkdirSync(path.join(gitOrigin, 'quick-skill'), { recursive: true })
fs.mkdirSync(path.join(gitOrigin, '.claude-plugin'), { recursive: true })
fs.writeFileSync(path.join(gitOrigin, 'quick-skill', 'SKILL.md'), '---\nname: quick-skill\ndescription: 一键安装技能\n---\nhi')
fs.writeFileSync(path.join(gitOrigin, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'quick-market', plugins: [{ name: 'qp1' }] }))
git(['-C', gitOrigin, 'add', '-A'])
git(['-C', gitOrigin, '-c', 'user.name=fixture', '-c', 'user.email=fixture@local', 'commit', '-m', 'assets'])
const quick = sources.quickAddSource(shared, gitOrigin, 'Quick Add')
ok(quick.source.kind === 'git' && quick.source.id === 'quick-add' && quick.source.name === 'Quick Add', 'quickAdd 返回源（git fixture，一步克隆+浏览）')
ok(fs.existsSync(path.join(shared, 'sources', 'quick-add', 'quick-skill', 'SKILL.md')), 'quickAdd 立即 clone 落目录')
ok(quick.assets.some((asset) => asset.kind === 'readme' && asset.description === 'Git fixture 源'), 'quickAdd 资产：根 README')
ok(quick.assets.some((asset) => asset.kind === 'skill' && asset.name === 'quick-skill'), 'quickAdd 资产：SKILL.md')
ok(quick.assets.some((asset) => asset.kind === 'marketplace' && asset.name === 'quick-market' && asset.pluginCount === 1), 'quickAdd 资产：marketplace.json（pluginCount）')
expectReject(() => sources.quickAddSource(shared, 'not-a-url-nor-dir'), 'quickAdd 拒绝非法 ref')
ok(!sources.listSources(shared).some((item) => item.ref === 'not-a-url-nor-dir'), 'quickAdd 失败不落注册表')
sources.removeSource(shared, quick.source.id)
ok(!fs.existsSync(path.join(shared, 'sources', 'quick-add')), 'quickAdd 产出的源可正常移除')

// === 场景 7：catalog ===
console.log('场景 7：catalog')
ok(catalog.EXTENSION_CATALOG.length >= 5, 'EXTENSION_CATALOG 至少 5 项')
ok(catalog.EXTENSION_CATALOG.every((entry) => /^https:\/\//.test(entry.repo)), 'catalog repo 均为 https URL')
ok(new Set(catalog.EXTENSION_CATALOG.map((entry) => entry.id)).size === catalog.EXTENSION_CATALOG.length, 'catalog id 唯一')

// === 场景 8：插件市场闭环（§8.1：注册/状态/装卸；假 home + 假 claude CLI 垫片，不 spawn 真 claude） ===
console.log('场景 8：插件市场闭环')
const claudeSettingsPath = path.join(home, '.claude', 'settings.json')

// 直接注册：claude extraKnownMarketplaces（owner/repo 形式，走备份写回）
const registeredClaude = editor.registerMarketplaceToClaude(home, 'local-market', 'first/one')
ok(registeredClaude.alreadyRegistered === false, 'registerMarketplaceToClaude 首次注册')
const settingsAfter = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf8'))
ok(settingsAfter.extraKnownMarketplaces['local-market'].source.repo === 'first/one' && settingsAfter.extraKnownMarketplaces['local-market'].source.source === 'github', 'claude extraKnownMarketplaces 键写入')
ok(settingsAfter.enabledPlugins['hud@claude-hud'] === false && settingsAfter.extraKnownMarketplaces['claude-hud'].source.repo === 'x/hud', 'claude 其它键（enabledPlugins/既有市场）原样')
const settingsBak = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json.agentdeck-bak'), 'utf8'))
ok(!(settingsBak.extraKnownMarketplaces && settingsBak.extraKnownMarketplaces['local-market']), 'settings .agentdeck-bak 保持注册前状态')
// 幂等：同 id 再注册不覆盖（repo 不同也不动）
ok(editor.registerMarketplaceToClaude(home, 'local-market', 'other/repo').alreadyRegistered === true, 'claude alreadyRegistered 幂等')
ok(JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf8')).extraKnownMarketplaces['local-market'].source.repo === 'first/one', 'claude 已注册键不被覆盖')
for (const bad of ['https://github.com/owner/repo', 'owner', '/owner/repo', 'owner/', 'a b/c']) {
  expectReject(() => editor.registerMarketplaceToClaude(home, 'bad-market', bad), `repo 非 owner/repo 形式被拒绝: ${JSON.stringify(bad)}`)
}

// 直接注册：zcode known_marketplaces.json 数组 append
const zRegistryPath = path.join(home, '.zcode', 'cli', 'plugins', 'known_marketplaces.json')
editor.registerMarketplaceToZcode(home, 'direct-market', { repo: 'acme/direct', name: 'direct-market', description: '直注市场', pluginCount: 3 })
const zRegistry = JSON.parse(fs.readFileSync(zRegistryPath, 'utf8'))
ok(zRegistry.version === 1, 'zcode 注册表其它顶层键原样')
ok(zRegistry.marketplaces.length === 2, 'zcode marketplaces 数组 append')
ok(zRegistry.marketplaces[0].id === 'zcode-plugins-official' && zRegistry.marketplaces[0].pluginCount === 24, 'zcode 既有条目原样')
const direct = zRegistry.marketplaces[1]
ok(direct.id === 'direct-market' && direct.source.source === 'github' && direct.source.repo === 'acme/direct' && direct.name === 'direct-market' && direct.description === '直注市场' && direct.pluginCount === 3 && !Number.isNaN(Date.parse(direct.addedAt)), 'zcode append 条目形状（id/source/name/description/addedAt/pluginCount）')
ok(!('lastUpdated' in direct) && !('cacheTransactionId' in direct), '不写 ZCode CLI 自维护字段')
ok(editor.registerMarketplaceToZcode(home, 'direct-market', { repo: 'other/x', name: 'x' }).alreadyRegistered === true, 'zcode alreadyRegistered 幂等')
ok(JSON.parse(fs.readFileSync(zRegistryPath, 'utf8')).marketplaces.length === 2, 'zcode 幂等不追加')

// 全链：源内 marketplace.json → 注册（git 源 ref 解析为 owner/repo；registry 手工伪造免联网）
const localAgain = sources.addSource(shared, localSrc)
ok(localAgain.id === 'local-source', '重新添加 local 源')
const localInfo = sources.readMarketplaceAsset(shared, localAgain.id, '.claude-plugin/marketplace.json')
ok(localInfo.name === 'local-market' && localInfo.pluginCount === 2 && localInfo.repo === null, 'readMarketplaceAsset 解析（local 源 repo=null）')
const localResult = sources.registerMarketplaceAsset(shared, home, localAgain.id, '.claude-plugin/marketplace.json')
ok(localResult.claudeName === null && localResult.zcodeId === null && !!localResult.claudeError && !!localResult.zcodeError, 'local 源注册被拒（双侧错误独立返回）')
expectReject(() => sources.readMarketplaceAsset(shared, localAgain.id, '../../outside'), 'assetPath .. 逃逸被拒绝')
expectReject(() => sources.readMarketplaceAsset(shared, localAgain.id, 'README.md'), '非 marketplace.json 资产被拒绝')
expectReject(() => sources.readMarketplaceAsset(shared, localAgain.id, '.claude-plugin/missing.json'), '不存在的 marketplace.json 被拒绝')
expectReject(() => sources.readMarketplaceAsset(shared, localAgain.id, 'nested/.claude-plugin/marketplace.json'), '缺 name 字段的 marketplace.json 被拒绝')
const fakeGhDir = path.join(shared, 'sources', 'fake-gh')
fs.cpSync(localSrc, fakeGhDir, { recursive: true })
const registryPath = path.join(shared, 'sources', 'sources.json')
const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'))
registry.push({ id: 'fake-gh', name: 'Fake GH', kind: 'git', ref: 'https://github.com/acme/market-repo.git', category: 'custom', description: '', addedAt: Date.now(), lastSyncedAt: Date.now() })
fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n')
const chained = sources.registerMarketplaceAsset(shared, home, 'fake-gh', '.claude-plugin/marketplace.json')
ok(chained.claudeName === 'local-market' && chained.zcodeId === 'local-market' && chained.pluginCount === 2 && !chained.claudeError && !chained.zcodeError, '全链注册（.git 后缀 ref → owner/repo → 双侧成功）')
ok(JSON.parse(fs.readFileSync(zRegistryPath, 'utf8')).marketplaces.length === 3, '全链 zcode append 第三条')

// 状态判定
const status = plugins.marketplaceStatus(home)
ok(status.claude.includes('claude-hud') && status.claude.includes('local-market'), 'marketplaceStatus claude 侧（既有 + 新注册）')
ok(status.zcode.includes('zcode-plugins-official') && status.zcode.includes('direct-market') && status.zcode.includes('local-market'), 'marketplaceStatus zcode 侧')
const emptyStatus = plugins.marketplaceStatus(path.join(outDir, 'empty-home'))
ok(emptyStatus.claude.length === 0 && emptyStatus.zcode.length === 0, 'marketplaceStatus 空家目录容错（双侧空数组）')

// 装卸：假 claude CLI 垫片（.cmd shim → node_modules JS 入口，走 resolveCli 真实解析链）
const fakeBin = path.join(outDir, 'fake-bin')
fs.mkdirSync(path.join(fakeBin, 'node_modules', '@fake', 'claude'), { recursive: true })
fs.writeFileSync(path.join(fakeBin, 'claude.cmd'), '@ECHO OFF\r\nnode "%dp0%\\node_modules\\@fake\\claude\\cli.js" %*\r\n')
fs.writeFileSync(
  path.join(fakeBin, 'node_modules', '@fake', 'claude', 'cli.js'),
  [
    "const fs = require('fs')",
    'const args = process.argv.slice(2)',
    "if (process.env.FAKE_CLAUDE_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(args) + '\\n')",
    "if (process.env.FAKE_CLAUDE_MODE === 'fail') {",
    "  process.stderr.write('simulated claude failure\\n')",
    '  process.exit(4)',
    '}',
    "if (process.env.FAKE_CLAUDE_MODE === 'big') {",
    "  const big = 'x'.repeat(3000)",
    "  process.stdout.write(big + '\\n')",
    "  process.stderr.write(big + '\\n')",
    '  process.exit(1)',
    '}',
    "process.stdout.write('fake plugin ' + args.join(' ') + ' ok\\n')"
  ].join('\n')
)
const savedPath = process.env.PATH
process.env.PATH = fakeBin + path.delimiter + savedPath
const fakeLog = path.join(outDir, 'fake-claude.log')
process.env.FAKE_CLAUDE_LOG = fakeLog
const installResult = await pluginCli.installClaudePlugin(home, 'superpowers@claude-plugins-official')
ok(installResult.ok === true && installResult.output.includes('superpowers@claude-plugins-official'), 'install 走假 claude CLI 成功')
const calls = fs.readFileSync(fakeLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
ok(JSON.stringify(calls[0]) === JSON.stringify(['plugin', 'install', 'superpowers@claude-plugins-official']), 'CLI 参数 = plugin install <spec>（shim→node 入口解析正确）')
process.env.FAKE_CLAUDE_MODE = 'fail'
const failResult = await pluginCli.uninstallClaudePlugin(home, 'hud@claude-hud')
ok(failResult.ok === false && failResult.output.includes('simulated claude failure'), 'CLI 非零退出 → ok:false 带 stderr')
process.env.FAKE_CLAUDE_MODE = 'big'
const bigResult = await pluginCli.uninstallClaudePlugin(home, 'hud@claude-hud')
ok(bigResult.ok === false && bigResult.output.length <= 2000, 'CLI 失败输出尾部截断 ≤2000 字符')
// spec 校验在任何 spawn 之前拒绝（不会触发真 claude）
await expectRejectAsync(() => pluginCli.installClaudePlugin(home, 'has space@x'), 'install 拒绝非法 spec（空格）')
await expectRejectAsync(() => pluginCli.uninstallClaudePlugin(home, '../evil@x'), 'uninstall 拒绝路径逃逸 spec')
await expectRejectAsync(() => pluginCli.installClaudePlugin(home, 'plugin@'), 'install 拒绝缺市场名 spec')
await expectRejectAsync(() => pluginCli.uninstallClaudePlugin(home, '@market'), 'uninstall 拒绝缺插件名 spec')
process.env.PATH = ''
await expectRejectAsync(() => pluginCli.installClaudePlugin(home, 'x@y'), 'PATH 无 claude → 明确报错')
process.env.PATH = savedPath
delete process.env.FAKE_CLAUDE_LOG
delete process.env.FAKE_CLAUDE_MODE

// === 场景 9：市场插件清单（§8.4：映射正确 / installed 交叉 / assetPath 逃逸拒绝） ===
console.log('场景 9：市场插件清单（§8.4）')
const mpSrc = path.join(outDir, 'mp-src')
fs.mkdirSync(path.join(mpSrc, '.claude-plugin'), { recursive: true })
fs.writeFileSync(path.join(mpSrc, 'README.md'), '# 干扰项：非 marketplace.json')
fs.writeFileSync(
  path.join(mpSrc, '.claude-plugin', 'marketplace.json'),
  JSON.stringify({
    name: 'mp-market',
    description: '清单市场',
    plugins: [
      { name: 'full-plugin', description: '完整字段插件', category: 'productivity', version: '1.4.2', author: 'acme' },
      { name: 'categorized', category: 'testing', junk: '非映射字段应被剥掉' },
      { name: 'bare-plugin' },
      { description: '缺 name 的条目应被跳过' },
      'not-an-object'
    ]
  })
)
const mpSource = sources.addSource(shared, mpSrc)
// 种假 home：installed_plugins.json 与 enabledPlugins 各命中一项 → 两条交叉路径都验证
const mpHome = path.join(outDir, 'mp-home')
fs.mkdirSync(path.join(mpHome, '.claude', 'plugins'), { recursive: true })
fs.writeFileSync(path.join(mpHome, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'full-plugin@mp-market': [{ scope: 'user', version: '1.0.0' }] } }))
fs.writeFileSync(path.join(mpHome, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'bare-plugin@mp-market': true } }))
const listedPlugins = sources.listMarketplacePlugins(shared, mpHome, mpSource.id, '.claude-plugin/marketplace.json')
ok(listedPlugins.length === 3 && listedPlugins.map((item) => item.name).join(',') === 'full-plugin,categorized,bare-plugin', 'listPlugins 宽松映射（缺 name/非对象条目跳过，顺序保持）')
const full = listedPlugins[0]
ok(full.description === '完整字段插件' && full.category === 'productivity' && full.version === '1.4.2' && full.author === 'acme', 'name/description/category/version/author 映射正确')
ok(full.installed === true, 'installed 交叉命中 installed_plugins.json')
const categorized = listedPlugins[1]
ok(categorized.category === 'testing' && !('description' in categorized) && !('version' in categorized) && !('author' in categorized) && !('junk' in categorized), '无分类/缺失字段省略（junk 不进映射）')
ok(listedPlugins[2].installed === true && categorized.installed === undefined, 'installed 交叉命中 enabledPlugins，未命中省略')
// 读失败容错：home 缺失/坏 JSON → 不抛错、installed 全省略
const noHome = sources.listMarketplacePlugins(shared, path.join(outDir, 'no-such-home'), mpSource.id, '.claude-plugin/marketplace.json')
ok(noHome.length === 3 && noHome.every((item) => !('installed' in item)), 'home 缺失容错（installed 全省略）')
const badHome = path.join(outDir, 'bad-home')
fs.mkdirSync(path.join(badHome, '.claude', 'plugins'), { recursive: true })
fs.writeFileSync(path.join(badHome, '.claude', 'plugins', 'installed_plugins.json'), '{oops')
fs.writeFileSync(path.join(badHome, '.claude', 'settings.json'), '{oops')
const badHomeList = sources.listMarketplacePlugins(shared, badHome, mpSource.id, '.claude-plugin/marketplace.json')
ok(badHomeList.length === 3 && badHomeList.every((item) => !('installed' in item)), 'home 坏 JSON 容错（installed 全省略）')
// assetPath 校验同 register（assertInside 源根 + 必须是 marketplace.json）
expectReject(() => sources.listMarketplacePlugins(shared, mpHome, mpSource.id, '../../outside'), 'listPlugins 拒绝 assetPath .. 逃逸')
expectReject(() => sources.listMarketplacePlugins(shared, mpHome, mpSource.id, 'README.md'), 'listPlugins 拒绝非 marketplace.json 资产')

// === 场景 10：URL 一键装技能 + 已注册市场聚合（§8.6） ===
console.log('场景 10：install-from-url 与 list-registered（§8.6）')
// install-from-url：fixture git 仓库 2 技能（根 + 嵌套）+ README/marketplace 干扰项（不计入技能）
const urlOrigin = path.join(outDir, 'url-origin.git')
fs.mkdirSync(path.join(urlOrigin, 'url-skill-a'), { recursive: true })
fs.mkdirSync(path.join(urlOrigin, 'docs', 'url-skill-b'), { recursive: true })
fs.mkdirSync(path.join(urlOrigin, '.claude-plugin'), { recursive: true })
fs.writeFileSync(path.join(urlOrigin, 'README.md'), '# URL 直装 fixture')
fs.writeFileSync(path.join(urlOrigin, 'url-skill-a', 'SKILL.md'), '---\nname: url-skill-a\ndescription: URL 技能 A\n---\nhi')
fs.writeFileSync(path.join(urlOrigin, 'docs', 'url-skill-b', 'SKILL.md'), '---\nname: url-skill-b\ndescription: URL 技能 B\n---\nhi')
fs.writeFileSync(path.join(urlOrigin, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'url-market', plugins: [{ name: 'um1' }] }))
git(['init', urlOrigin])
git(['-C', urlOrigin, 'add', '-A'])
git(['-C', urlOrigin, '-c', 'user.name=fixture', '-c', 'user.email=fixture@local', 'commit', '-m', 'init'])
const urlResult = sources.installSkillsFromUrl(shared, urlOrigin)
ok(urlResult.sourceName === 'url-origin' && urlResult.sourceId === 'url-origin', 'installFromUrl 返回源名/源 id（git fixture 一步克隆）')
ok(urlResult.skills.length === 2 && [...urlResult.skills].sort().join(',') === 'url-skill-a,url-skill-b', 'installFromUrl 导入 2 个技能（实际落库名）')
ok(fs.existsSync(path.join(shared, 'skills', 'url-skill-a', 'SKILL.md')) && fs.existsSync(path.join(shared, 'skills', 'url-skill-b', 'SKILL.md')), '技能落共享库')
ok(!fs.existsSync(path.join(shared, 'skills', 'url-market')) && !fs.existsSync(path.join(shared, 'skills', 'url-origin')), 'README/marketplace 不误导入为技能')
ok(sources.listSources(shared).some((item) => item.id === 'url-origin') && fs.existsSync(path.join(shared, 'sources', 'url-origin', 'README.md')), '源照常登记（仓库 tab 可管理）')
// 重复调用：技能已存在 → 全部跳过不重复（不产生 -2 副本），源仍照常登记
const urlAgain = sources.installSkillsFromUrl(shared, urlOrigin)
ok(urlAgain.skills.length === 0, '重复调用跳过已导入技能（skills 空）')
ok(urlAgain.sourceId === 'url-origin-2', '重复调用源 id 自动 -2（源照常登记）')
ok(!fs.existsSync(path.join(shared, 'skills', 'url-skill-a-2')) && !fs.existsSync(path.join(shared, 'skills', 'url-skill-b-2')), '重复调用没有落重复技能')
sources.removeSource(shared, urlAgain.sourceId)
expectReject(() => sources.installSkillsFromUrl(shared, 'not-a-url-nor-dir'), 'installFromUrl 拒绝非法 ref（既有错误上抛）')
expectReject(() => sources.installSkillsFromUrl(shared, ''), 'installFromUrl 拒绝空 ref')
ok(!sources.listSources(shared).some((item) => item.ref === 'not-a-url-nor-dir'), 'installFromUrl 失败不落注册表')

// list-registered：假 home 种 claude/zcode 市场缓存 + AgentDeck 源市场 → 三来源聚合
const regHome = path.join(outDir, 'reg-home')
const claudeMarketsRoot = path.join(regHome, '.claude', 'plugins', 'marketplaces')
const zcodeMarketsRoot = path.join(regHome, '.zcode', 'cli', 'plugins', 'marketplaces')
// claude 缓存：dup-market（与 zcode 缓存重名）+ 与 AgentDeck 源同名的 mp-market + 坏 json + 无 json 空目录
fs.mkdirSync(path.join(claudeMarketsRoot, 'dup-market'), { recursive: true })
fs.mkdirSync(path.join(claudeMarketsRoot, 'mp-market'), { recursive: true })
fs.mkdirSync(path.join(claudeMarketsRoot, 'broken'), { recursive: true })
fs.mkdirSync(path.join(claudeMarketsRoot, 'empty-dir'), { recursive: true })
fs.writeFileSync(path.join(claudeMarketsRoot, 'dup-market', 'marketplace.json'), JSON.stringify({ name: 'dup-market', plugins: [{ name: 'p-claude' }, { name: 'p-both' }] }))
fs.writeFileSync(path.join(claudeMarketsRoot, 'mp-market', 'marketplace.json'), JSON.stringify({ name: 'mp-market', plugins: [{ name: 'claude-side-mp' }] }))
fs.writeFileSync(path.join(claudeMarketsRoot, 'broken', 'marketplace.json'), '{oops')
// installed 交叉种子：installed_plugins.json 与 enabledPlugins 各命中一项
fs.writeFileSync(path.join(regHome, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'p-both@dup-market': [{ scope: 'user', version: '1.0.0' }] } }))
fs.writeFileSync(path.join(regHome, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'p-claude@dup-market': true } }))
// zcode 缓存：dup-market 重名（plugins 不同 → 应以 claude 先读为准）+ 嵌套布局 zcode-only
fs.mkdirSync(path.join(zcodeMarketsRoot, 'dup-market'), { recursive: true })
fs.mkdirSync(path.join(zcodeMarketsRoot, 'zcode-only', '.claude-plugin'), { recursive: true })
fs.writeFileSync(path.join(zcodeMarketsRoot, 'dup-market', 'marketplace.json'), JSON.stringify({ name: 'dup-market', plugins: [{ name: 'p-zcode' }] }))
fs.writeFileSync(path.join(zcodeMarketsRoot, 'zcode-only', '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'zcode-only', plugins: [{ name: 'p-z' }] }))
const regs = plugins.registeredMarketplaces(shared, regHome)
const regByName = new Map(regs.map((item) => [item.name, item]))
const dupReg = regByName.get('dup-market')
ok(!!dupReg && dupReg.clis.join(',') === 'claude,zcode', '重名市场双 CLI 缓存去重合并（clis 并集）')
ok(!!dupReg && dupReg.plugins.map((item) => item.name).join(',') === 'p-claude,p-both', 'plugins 以首个成功读取的 json 为准（claude 先读，zcode 的 p-zcode 不混入）')
ok(dupReg?.plugins.find((item) => item.name === 'p-claude')?.installed === true, 'installed 交叉命中 enabledPlugins')
ok(dupReg?.plugins.find((item) => item.name === 'p-both')?.installed === true, 'installed 交叉命中 installed_plugins.json')
const zOnly = regByName.get('zcode-only')
ok(!!zOnly && zOnly.clis.join(',') === 'zcode' && zOnly.plugins.length === 1 && zOnly.plugins[0].name === 'p-z', 'zcode 缓存嵌套布局（.claude-plugin/）兼容')
const mpReg = regByName.get('mp-market')
ok(!!mpReg && mpReg.clis.join(',') === 'claude' && mpReg.plugins.map((item) => item.name).join(',') === 'full-plugin,categorized,bare-plugin', 'AgentDeck 源市场与 claude 缓存同名 → 源内 plugins 胜出（首个成功读取）+ clis 并集')
ok(mpReg !== undefined && mpReg.plugins.every((item) => !('installed' in item)), '源市场 plugins 不误交叉其它市场的已装键')
const localMarket = regByName.get('local-market')
ok(!!localMarket && localMarket.clis.length === 0 && localMarket.plugins.map((item) => item.name).join(',') === 'p1,p2', 'AgentDeck 多源同名市场去重（local-source 先读为准，clis 空 = 未注册到 CLI）')
ok(!regByName.has('broken') && !regByName.has('empty-dir'), '坏 JSON / 无 marketplace.json 缓存容错跳过')
// 空家目录容错：缓存来源全跳过，只剩 AgentDeck 源市场且 clis 全空
const regsEmpty = plugins.registeredMarketplaces(shared, path.join(outDir, 'no-reg-home'))
ok(regsEmpty.length > 0 && regsEmpty.every((item) => item.clis.length === 0), '空家目录容错（仅 AgentDeck 源市场，clis 全空）')
ok(regsEmpty.every((item) => !item.plugins.some((plugin) => 'installed' in plugin)), '空家目录 installed 全省略')

// === 场景 11：listSkillGroups 技能发现分组（§8.7：两源分组/skill 过滤/坏源容错/空源省略） ===
console.log('场景 11：listSkillGroups（§8.7）')
const lsShared = path.join(outDir, 'ls-shared')
// git 源：2 技能（根 + 嵌套）+ README/marketplace 干扰项（不入技能组）
const lsOrigin = path.join(outDir, 'ls-origin.git')
fs.mkdirSync(path.join(lsOrigin, 'git-skill-a'), { recursive: true })
fs.mkdirSync(path.join(lsOrigin, 'deep', 'git-skill-b'), { recursive: true })
fs.mkdirSync(path.join(lsOrigin, '.claude-plugin'), { recursive: true })
fs.writeFileSync(path.join(lsOrigin, 'README.md'), '# LS git 源')
fs.writeFileSync(path.join(lsOrigin, 'git-skill-a', 'SKILL.md'), '---\nname: git-skill-a\ndescription: git 技能 A\n---\nhi')
fs.writeFileSync(path.join(lsOrigin, 'deep', 'git-skill-b', 'SKILL.md'), '---\nname: git-skill-b\ndescription: git 技能 B\n---\nhi')
fs.writeFileSync(path.join(lsOrigin, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'ls-market', plugins: [{ name: 'lsp1' }] }))
git(['init', lsOrigin])
git(['-C', lsOrigin, 'add', '-A'])
git(['-C', lsOrigin, '-c', 'user.name=fixture', '-c', 'user.email=fixture@local', 'commit', '-m', 'init'])
// local 源：1 技能 + marketplace 干扰项
const lsLocalSrc = path.join(outDir, 'ls-local-src')
fs.mkdirSync(path.join(lsLocalSrc, '.claude-plugin'), { recursive: true })
fs.mkdirSync(path.join(lsLocalSrc, 'local-skill'), { recursive: true })
fs.writeFileSync(path.join(lsLocalSrc, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'ls-local-market', plugins: [{ name: 'lsp2' }] }))
fs.writeFileSync(path.join(lsLocalSrc, 'local-skill', 'SKILL.md'), '---\nname: local-skill\ndescription: local 技能\n---\nhi')
// 空源：真实目录但无任何 SKILL.md → 不出组
const lsEmptySrc = path.join(outDir, 'ls-empty-src')
fs.mkdirSync(lsEmptySrc, { recursive: true })
fs.writeFileSync(path.join(lsEmptySrc, 'README.md'), '# 空源')
sources.addSource(lsShared, lsOrigin, 'LS Git')
sources.addSource(lsShared, lsLocalSrc)
sources.addSource(lsShared, lsEmptySrc)
// 坏源：registry 手工种 ref 指向不存在目录（browseSource 抛「本地源目录不存在」→ 必须容错跳过不炸整表）
const lsRegistryPath = path.join(lsShared, 'sources', 'sources.json')
const lsRegistry = JSON.parse(fs.readFileSync(lsRegistryPath, 'utf8'))
lsRegistry.push({ id: 'ls-broken', name: 'LS Broken', kind: 'local', ref: path.join(outDir, 'no-such-ls-dir'), category: 'custom', description: '', addedAt: Date.now(), lastSyncedAt: null })
fs.writeFileSync(lsRegistryPath, JSON.stringify(lsRegistry, null, 2) + '\n')
const lsGroups = sources.listSkillGroups(lsShared)
ok(lsGroups.length === 2, '只有含技能的源出组（坏源容错跳过 + 空技能源省略）')
const lsGitGroup = lsGroups.find((group) => group.source.id === 'ls-git')
ok(!!lsGitGroup && lsGitGroup.source.name === 'LS Git' && lsGitGroup.source.kind === 'git' && lsGitGroup.source.ref === lsOrigin, 'git 组 source 元数据（id/name/ref/kind）')
ok(!!lsGitGroup && lsGitGroup.skills.every((asset) => asset.kind === 'skill') && [...lsGitGroup.skills].map((asset) => asset.name).sort().join(',') === 'git-skill-a,git-skill-b', 'git 组只含 skill 型资产（README/marketplace 被过滤）')
ok(!!lsGitGroup && lsGitGroup.skills.find((asset) => asset.name === 'git-skill-b')?.description === 'git 技能 B', 'git 组嵌套技能 description 提取')
const lsLocalGroup = lsGroups.find((group) => group.source.id === 'ls-local-src')
ok(!!lsLocalGroup && lsLocalGroup.source.kind === 'local' && lsLocalGroup.source.ref === lsLocalSrc && !('category' in lsLocalGroup.source), 'local 组 source 元数据（不夹带注册表多余字段）')
ok(!!lsLocalGroup && lsLocalGroup.skills.length === 1 && lsLocalGroup.skills[0].name === 'local-skill' && lsLocalGroup.skills[0].description === 'local 技能', 'local 组技能过滤正确')
ok(!lsGroups.some((group) => group.source.id === 'ls-broken' || group.source.id === 'ls-empty-src'), '坏源与空源都不出组')
ok(sources.listSkillGroups(path.join(outDir, 'no-such-ls-root')).length === 0, '注册表缺失容错（空数组不抛错）')

fs.rmSync(outDir, { recursive: true, force: true })
if (failed > 0) {
  console.error(`\n❌ EXTENSIONS SMOKE FAILED: ${failed} 项未通过`)
  process.exit(1)
}
console.log('\n✅ EXTENSIONS SMOKE PASSED')
