/**
 * Electron 重叠点击回归的宿主进程（夹具）：只做一件事——
 * 用**隔离的 userData** 起一个离屏窗口加载 out/ui-overlap.html，并打开 CDP 端口。
 * 不加载应用主进程、不碰任何生产数据；断言全部在 scripts/smoke-ui-electron-overlap.mjs。
 */
const path = require('node:path')
const { app, BrowserWindow } = require('electron')

const userData = process.env.AGENTDECK_USER_DATA_DIR
if (userData) app.setPath('userData', userData)
app.commandLine.appendSwitch('remote-debugging-port', String(Number(process.env.OVERLAP_DEBUG_PORT || 9333)))
app.disableHardwareAcceleration()

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: Number(process.env.OVERLAP_WIDTH || 1000),
    height: Number(process.env.OVERLAP_HEIGHT || 720),
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  })
  win.loadFile(path.join(__dirname, '..', '..', 'out', 'ui-overlap.html'))
  // 隐藏窗口在部分平台不做命中测试；需要真实点击时用 showInactive 出图（不抢焦点）
  if (process.env.OVERLAP_SHOW === '1') win.once('ready-to-show', () => win.showInactive())
})

// 夹具没有别的窗口：探针连上、断言跑完由父进程收尾
app.on('window-all-closed', () => app.quit())
