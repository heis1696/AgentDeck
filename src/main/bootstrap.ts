// 免安装热更 bootstrap（设计 §3）：asar 入口五步加载链 + 三类失败自愈。
// 铁律：零第三方依赖；全程同步、无网络、无用户交互；运行时绝不改写 main 字段（P2）；
// 任何失败的最坏结果 = 回退 asar 内置版本继续可用（P5）。
import { app, dialog } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { resolveHotState } from './hot/resolve'
import { clearPointer, readPointer } from './hot/pointer'

const FALLBACK_ARG = '--agentdeck-hot-fallback'

/** 运行时 require：动态参数防 rollup 静态分析内联，保持 bootstrap/index 双入口布局（§3.1）。 */
const loadEntry = (file: string): unknown => require(file)

/** 步骤 4：加载 asar 内置载荷；内置也抛错 = 全链路唯一"起不来"出口（与热更无关的既有故障）。 */
function loadBuiltin(): void {
  try {
    loadEntry(path.join(__dirname, 'index.js'))
  } catch (error) {
    dialog.showErrorBox(
      'AgentDeck 启动失败',
      `${error instanceof Error ? error.stack ?? error.message : String(error)}\n\n热更通道已禁用。若持续失败，可删除 %APPDATA%\\agentdeck 下的 hot-app 与 hot-renderer 目录后重试。`
    )
    throw error
  }
}

/**
 * 步骤 3 的自愈处置（§3.3 路径①②）：按失败来源通道留证改名；处置动作全部吞错，
 * 失败不阻断回退。载荷被拒时顺带把版本目录整体隔离，阻止任何路径复用坏载荷。
 */
function selfHeal(userData: string, reason: string): void {
  const evidence = reason.startsWith('pointer-invalid:') ? 'corrupt' : reason.startsWith('payload-rejected:') ? 'rejected' : ''
  if (!evidence) return
  // 判失败来源：载荷指针存在（无论可解析与否）→ 载荷层；缺失 → 失败源自 L2 渲染层指针
  let payloadDir: string | null = null
  let payloadPointerPresent = false
  try {
    const pointer = readPointer(userData, 'payload')
    if (pointer) {
      payloadPointerPresent = true
      payloadDir = pointer.dir
    }
  } catch {
    payloadPointerPresent = true
  }
  if (!payloadPointerPresent) {
    clearPointer(userData, 'renderer', evidence)
    return
  }
  clearPointer(userData, 'payload', evidence)
  if (payloadDir && evidence === 'rejected') {
    const abs = path.join(userData, payloadDir)
    try {
      fs.renameSync(abs, `${abs}.quarantine-${Date.now()}`)
    } catch {
      /* 隔离失败不阻断回退（GC 阶段清理） */
    }
  }
}

function main(): void {
  // 测试/隔离通道：显式指定 userData。必须在指针解析之前生效——Windows 上 Electron 经
  // 系统 API 解析 appData，env APPDATA 重定向无效，外部进程只能靠此处显式覆盖隔离数据目录。
  const overrideUserData = process.env.AGENTDECK_USER_DATA_DIR
  if (overrideUserData) {
    try {
      app.setPath('userData', overrideUserData)
    } catch {
      /* 值无效则维持默认，不阻断启动 */
    }
  }
  // 步骤 0：dev / 逃生开关 / 循环保险直通内置版（永远可用）
  if (!app.isPackaged || process.env.AGENTDECK_DISABLE_HOT === '1' || process.argv.includes(FALLBACK_ARG)) {
    loadBuiltin()
    return
  }
  // 步骤 1：解析并完整校验 L1 载荷指针（§2.2 规则 1-6）
  const userData = app.getPath('userData')
  const hot = resolveHotState(userData, app.getVersion())
  // 步骤 2：载荷生效——__dirname 自此整体重定位到载荷目录；同步 require 抛错 → 路径③
  if (hot.payload) {
    try {
      loadEntry(hot.payload.entry)
      return
    } catch {
      // 路径③：清指针留证 + relaunch 干净重启进内置版（同进程回退会撞 handler 二次注册，§3.3）。
      // Electron 33 的 relaunch 返回 void：即便重启失败，指针已改名 crash，下次启动直接内置版，不会循环。
      clearPointer(userData, 'payload', 'crash')
      app.relaunch({ args: [...process.argv.slice(1), FALLBACK_ARG, '--agentdeck-relaunch-retry'] })
      app.exit(1)
      return
    }
  }
  // 步骤 3：指针无效 / 载荷被拒 → 自愈留证，然后落入步骤 4
  selfHeal(userData, hot.reason)
  loadBuiltin()
}

main()
