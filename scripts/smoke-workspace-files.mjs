// @ 文件引用补全冒烟：listWorkspaceEntries（主进程纯函数，真目录夹具）+ token/过滤纯函数 + 菜单 SSR。
// 验收口径（吸收 ZCode 输入壳 mention 面板）：重目录跳过、目录在前文件在后、上限截断、
// 越界拒绝（../、绝对路径）；@ 检测/拆分/过滤可判定；菜单 listbox 契约（选项可指认）。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'

const root = path.resolve(import.meta.dirname, '..')
// api.ts 模块加载即读 window.agentdeck（FileMenu 组件文件只引类型，但 bundle 面会带出）
globalThis.window = { agentdeck: {} }

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-ws-files-'))
const ws = path.join(temp, 'ws')
fs.mkdirSync(path.join(ws, 'src', 'deep'), { recursive: true })
fs.mkdirSync(path.join(ws, 'docs'))
fs.mkdirSync(path.join(ws, 'node_modules', 'left-pad'), { recursive: true })   // 应被跳过
fs.mkdirSync(path.join(ws, '.git', 'objects'), { recursive: true })            // 应被跳过
for (const name of ['README.md', 'package.json', 'z-last.txt', 'a-first.ts']) fs.writeFileSync(path.join(ws, name), 'x\n')
fs.writeFileSync(path.join(ws, 'src', 'index.ts'), 'export const one = 1\n')
fs.writeFileSync(path.join(ws, 'src', 'deep', 'util.ts'), 'export const util = "u"\n')
fs.writeFileSync(path.join(ws, 'docs', 'plan.md'), '# plan\n')
fs.writeFileSync(path.join(ws, 'blob.bin'), Buffer.from([0x42, 0x00, 0x69, 0x6e]))  // NUL → 二进制
fs.writeFileSync(path.join(ws, 'huge.txt'), 'x'.repeat(512 * 1024 + 1))             // 超上限

const outfile = path.join(root, 'out/smoke-workspace-files.cjs')
await build({
  stdin: {
    contents: [
      "export { listWorkspaceEntries, readWorkspaceFile, WORKSPACE_LISTING_CAP } from './src/main/workspace-listing'",
      "export { WorkspaceFileMenu, detectFileToken, splitToken, filterEntries, FILE_MENU_LISTBOX_ID, fileMenuOptionId } from './src/renderer/src/components/WorkspaceFileMenu'"
    ].join('\n'),
    resolveDir: root,
    loader: 'tsx'
  },
  outfile, bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic',
  external: ['electron', 'react', 'react/jsx-runtime', 'lucide-react']
})
const { listWorkspaceEntries, readWorkspaceFile, WORKSPACE_LISTING_CAP, WorkspaceFileMenu, detectFileToken, splitToken, filterEntries, FILE_MENU_LISTBOX_ID, fileMenuOptionId } = await import(pathToFileURL(outfile).href)

try {
  // —— 目录清单：跳过名单、目录在前、字典序 ——
  const top = listWorkspaceEntries(ws, '')
  assert.equal(top.ok, true)
  assert.deepEqual(top.entries.map((e) => `${e.kind}:${e.name}`), ['dir:docs', 'dir:src', 'file:a-first.ts', 'file:blob.bin', 'file:huge.txt', 'file:package.json', 'file:README.md', 'file:z-last.txt'], '重目录跳过 + 目录在前文件在后 + 字典序')
  const deep = listWorkspaceEntries(ws, 'src')
  assert.deepEqual(deep.entries.map((e) => e.name), ['deep', 'index.ts'], '子目录清单正确')
  // 反斜杠输入容错
  assert.deepEqual(listWorkspaceEntries(ws, 'src\\deep').entries.map((e) => e.name), ['util.ts'], '反斜杠分隔符按 / 处理')
  // —— 越界与非法 ——
  assert.equal(listWorkspaceEntries(ws, '../').code, 'bad-subdir', '.. 段拒绝')
  assert.equal(listWorkspaceEntries(ws, 'src/../../etc').code, 'bad-subdir', '内嵌 .. 拒绝')
  assert.equal(listWorkspaceEntries(ws, path.join(temp, 'ws')).code, 'bad-subdir', '绝对路径子目录拒绝')
  assert.equal(listWorkspaceEntries(ws, 'no-such-dir').code, 'list-failed', '不存在子目录 list-failed')
  // —— 上限 ——
  const big = path.join(temp, 'big')
  fs.mkdirSync(big)
  for (let i = 0; i < WORKSPACE_LISTING_CAP + 50; i++) fs.writeFileSync(path.join(big, `f${String(i).padStart(4, '0')}.txt`), 'x')
  const capped = listWorkspaceEntries(big, '')
  assert.equal(capped.truncated, true, '超上限置 truncated')
  assert.equal(capped.entries.length, WORKSPACE_LISTING_CAP, '条目截断到上限')

  // —— token 检测/拆分（纯函数）——
  assert.deepEqual(detectFileToken('看看 @src/ren', 11), { at: 4, token: 'src/ren' }, '@ 段检测（前有空白，光标在段尾）')
  assert.equal(detectFileToken('a@b', 3), null, '@ 前必须是行首或空白（邮箱式不误触）')
  assert.equal(detectFileToken('没有标记', 5), null, '无 @ 返回 null')
  assert.deepEqual(splitToken('src/rend'), { subdir: 'src', filter: 'rend' }, '带目录段拆分')
  assert.deepEqual(splitToken('rea'), { subdir: '', filter: 'rea' }, '根级过滤拆分')
  // —— 过滤 + 完整路径 ——
  const items = filterEntries(top.entries, 'rea', '')
  assert(items.some((item) => item.name === 'README.md' && item.path === 'README.md' && item.kind === 'file'), '根级过滤命中并带完整路径')
  const deepest = listWorkspaceEntries(ws, 'src/deep')
  const subItems = filterEntries(deepest.entries, 'uti', 'src/deep')
  assert(subItems.some((item) => item.path === 'src/deep/util.ts'), '子目录命中 path 含目录段（插入即完整相对路径）')
  assert.equal(filterEntries(top.entries, '', '').length <= 12, true, '面板条目上限')

  // —— 菜单 SSR：listbox 契约（id 可被 aria-activedescendant 指认）——
  const html = renderToStaticMarkup(createElement(WorkspaceFileMenu, { items: filterEntries(top.entries, '', ''), activeIndex: 1, onHover: () => {}, onPick: () => {} }))
  const doc = new JSDOM(`<body>${html}</body>`).window.document
  assert(doc.getElementById(FILE_MENU_LISTBOX_ID), 'listbox id 存在')
  assert(doc.getElementById(fileMenuOptionId(1))?.getAttribute('aria-selected') === 'true', '活动项可指认且选中')
  assert(doc.querySelector('.file-menu-item .mono'), '条目名走等宽字体（路径可读）')

  // —— 文件读取（文件浏览 tab 的内容通道）——
  const text = readWorkspaceFile(ws, 'src/deep/util.ts')
  assert.equal(text.ok, true)
  assert.equal(text.content, 'export const util = "u"\n', '文本内容读取正确')
  assert.equal(text.size, 'export const util = "u"\n'.length, '大小回带')
  const bin = readWorkspaceFile(ws, 'blob.bin')
  assert.equal(bin.ok && bin.code, 'binary', 'NUL 嗅探判二进制（ok:true code:binary）')
  assert(typeof bin.size === 'number', '二进制是信息态不是错误（带大小）')
  assert.equal(readWorkspaceFile(ws, 'huge.txt').code, 'too-large', '超 512KB 上限拒绝')
  assert.equal(readWorkspaceFile(ws, 'no-such.txt').code, 'missing', '不存在文件 missing')
  assert.equal(readWorkspaceFile(ws, '../escape.txt').code, 'bad-path', '.. 段拒绝')
  assert.equal(readWorkspaceFile(ws, path.join(ws, 'README.md')).code, 'bad-path', '绝对路径拒绝')
  assert.equal(readWorkspaceFile(ws, 'src').code, 'bad-path', '目录不是文件')
  // 符号链接逃逸：链到工作区外的文件必须被 realpath 拦下
  if (process.platform !== 'win32' || fs.symlinkSync.length > 0) {
    try {
      const outside = path.join(temp, 'outside-secret.txt')
      fs.writeFileSync(outside, 'secret')
      fs.symlinkSync(outside, path.join(ws, 'leak.txt'))
      assert.equal(readWorkspaceFile(ws, 'leak.txt').code, 'escapes-root', '符号链接逃逸被 realpath 拦截')
    } catch (cause) {
      if (process.platform === 'win32' && String(cause).includes('privilege')) console.log('  ⚠ Windows 无符号链接权限，跳过逃逸用例')
      else throw cause
    }
  }

  console.log('✅ WORKSPACE FILES SMOKE PASSED: 清单/跳过名单/上限/越界 + 读取/二进制/超限/符号链接逃逸 + token 检测拆分过滤 + 菜单契约全过')
} finally {
  fs.rmSync(temp, { recursive: true, force: true })
}
