// 快路径验证：桩 preload 暴露最小 agentdeck（tasks.list 立即返回空表 + platform 字面量），
// 断言 ready 到达后 splash 在 ~1s 内淡出（远早于 10s 兜底）
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const preload = path.join(os.tmpdir(), 'splash-stub-preload.cjs')
fs.writeFileSync(preload, `
const { contextBridge, ipcRenderer } = require('electron')
const off = () => () => {}
contextBridge.exposeInMainWorld('agentdeck', {
  platform: 'win32',
  tasks: { list: async () => [], onUpdated: off },
  meetings: { list: async () => [], onUpdated: off },
  issues: { list: async () => [], onUpdated: off },
  settings: { get: async () => ({}), onUpdated: off, update: async () => ({}) },
  onWorkspaceChanged: off,
  window: {}
})
`)
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1180, height: 760, show: false, webPreferences: { preload, contextIsolation: true, sandbox: false } })
  await win.loadFile(path.resolve('out', 'renderer', 'index.html'))
  await new Promise((r) => setTimeout(r, 3000))
  const s = await win.webContents.executeJavaScript(`(() => ({
    splash: !!document.getElementById('splash'),
    rootChildren: document.getElementById('root')?.children.length ?? -1
  }))()`)
  console.log(`  ${!s.splash ? '✓' : '✗'} 快路径淡出：3s 时 splash=${s.splash}（应为 false），rootChildren=${s.rootChildren}`)
  console.log(!s.splash ? 'FASTPATH PASSED' : 'FASTPATH FAILED')
  app.exit(s.splash ? 1 : 0)
})
