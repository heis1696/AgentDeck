// 开机动画层离屏验证：加载 out/renderer/index.html（无 preload → bridge 缺位 → ready 永远 false），
// 断言：①初期 #splash 在场且视频在播；②9s 兜底后淡出并从 DOM 移除（不把无数据/故障界面挡死）。
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const shots = path.resolve(__dirname, 'splash-verify')
fs.mkdirSync(shots, { recursive: true })

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1180, height: 760, show: false, backgroundColor: '#0f1115',
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  })
  await win.loadFile(path.resolve(__dirname, '..', 'out', 'renderer', 'index.html'))
  const state = () => win.webContents.executeJavaScript(`(() => {
    const el = document.getElementById('splash')
    const video = document.querySelector('#splash video')
    return {
      splash: !!el,
      done: el ? el.classList.contains('splash-done') : false,
      videoReady: !!video && video.readyState >= 2,
      videoTime: video ? video.currentTime : -1,
      paused: video ? video.paused : null
    }
  })()`)

  await new Promise((r) => setTimeout(r, 1500))
  const early = await state()
  await win.webContents.capturePage().then((img) => fs.writeFileSync(path.join(shots, 'early.png'), img.toPNG()))

  await new Promise((r) => setTimeout(r, 11500))
  const late = await state()
  await win.webContents.capturePage().then((img) => fs.writeFileSync(path.join(shots, 'late.png'), img.toPNG()))

  const ok = (cond, label) => console.log(`  ${cond ? '✓' : '✗'} ${label}`)
  ok(early.splash, `初期 splash 在场 (${JSON.stringify(early)})`)
  ok(early.videoReady && !early.paused && early.videoTime > 0, `视频在播（readyState=${early.videoReady}, t=${early.videoTime.toFixed(2)}s）`)
  ok(!late.splash && !late.done, `9s 兜底后已移除（splash=${late.splash}）`)
  console.log(early.splash && early.videoTime > 0 && !late.splash ? 'SPLASH VERIFY PASSED' : 'SPLASH VERIFY FAILED')
  app.quit()
})
