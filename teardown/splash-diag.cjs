const { app, BrowserWindow } = require('electron')
const path = require('node:path')
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1180, height: 760, show: false, webPreferences: {} })
  const logs = []
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 2) logs.push(message.slice(0, 400)) })
  await win.loadFile(path.resolve('out', 'renderer', 'index.html'))
  await new Promise((r) => setTimeout(r, 1200))
  console.log(JSON.stringify(await win.webContents.executeJavaScript(`(() => ({
    rootChildren: document.getElementById('root')?.children.length ?? -1,
    rootSample: document.getElementById('root')?.innerHTML.slice(0, 160) ?? '',
    errors: window.__err || null
  }))()`)))
  console.log('console-errors:', JSON.stringify(logs.slice(0, 5), null, 1))
  app.exit(0)
})
