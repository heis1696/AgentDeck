// 热更更新器（设计 §5.1）：renderer/payload 两通道共用状态机。
// staging → 验签 → 原子指针 → （载荷）relaunch；任一步失败删 staging、现网零触碰（P5）。
// 串行互斥：check/apply/rollback 全程单飞，两通道不同时跑（§5.3 互斥对策）。
import fs from 'node:fs'
import path from 'node:path'
import type { BrowserWindow } from 'electron'
import type { UpdateChannel, UpdateStateSnapshot } from '../../shared/contracts'
import type { AppSettings } from '../../shared/types'
import { DEFAULT_FEED_BASE } from './trust'
import { channelRoot, clearPointer, pointerFilePath, readPointer, writePointerAtomic, type HotChannel } from './pointer'
import { compareSemver, sha256File, verifyManifest, type HotManifestPayload } from './verifier'
import { resolveHotState } from './resolve'
import { downloadArtifact, fetchManifest } from './feed'
import { extractZipStore } from './zip'
import { placeUnlockedFiles, rollbackShell, spawnSwapHelper, stageShellZip } from './shell'

export interface UpdaterDeps {
  getWindow: () => BrowserWindow | null
  /** L1 apply 空闲门控（§7.4：runner.isIdle + automationTick 临界区重查由装配处叠加） */
  isMainIdle: () => boolean
  /** 指针翻转后的干净重启（§7.2 步 5：relaunch + 走既有 before-quit 停机链） */
  relaunchForUpdate: (version: string) => void
  settings: () => AppSettings
  getUserDataDir: () => string
  /** 壳版本（app.getVersion()；bootstrap 所在 asar 的元数据） */
  getShellVersion: () => string
  /** 应用目录（exe 所在）；null = 不适用壳通道（dev / 非目录式分发） */
  getAppDir: () => string | null
  /**
   * 壳通道专用退出（默认走 relaunchForUpdate 之外的纯 quit）：swap helper 在主进程退出后
   * 完成文件腾挪并负责拉起新壳，主进程此处不得再 relaunch（否则与 helper 双启动竞态）。
   */
  quitForShellUpdate?: () => void
}

const GC_KEEP_VERSIONS = 3

/** 版本目录名过滤：排除指针/留证/staging/隔离物 */
const isVersionDir = (name: string) =>
  !name.startsWith('.') && !name.includes('.quarantine-') && !name.startsWith('current.json')

export class HotUpdater {
  private snapshot: UpdateStateSnapshot = { phase: 'idle', channel: null, currentVersion: '' }
  private listeners = new Set<(snapshot: UpdateStateSnapshot) => void>()
  private busy = false
  /** 已下载就绪、因空闲门控挂起的载荷（§5.1 staged 语义；指针尚未翻转） */
  private staged: { version: string } | null = null
  /** 壳通道已 staging 就绪、等待用户确认的二段式状态（§9.3 半自动） */
  private stagedShell: { version: string; stagedDir: string } | null = null
  /** 最近一次 check 拿到的各通道 feed 版本（驱动 available 快照与 applyAll 编排） */
  private feedVersions: Partial<Record<UpdateChannel, string>> = {}
  private checkTimer: NodeJS.Timeout | undefined

  constructor(private deps: UpdaterDeps) {}

  onState(cb: (snapshot: UpdateStateSnapshot) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  getState(): UpdateStateSnapshot {
    return this.computeSnapshot()
  }

  /** 轮询启动检查（§1.2 装配：延迟启动 + 6h 定时；失败静默不打扰） */
  startPeriodicCheck(initialDelayMs: number, intervalMs: number): void {
    const fire = () => {
      this.check().catch(() => {})
    }
    setTimeout(fire, initialDelayMs)
    clearInterval(this.checkTimer)
    this.checkTimer = setInterval(fire, intervalMs)
  }

  stop(): void {
    clearInterval(this.checkTimer)
  }

  async check(): Promise<UpdateStateSnapshot> {
    if (this.busy) return this.emit({ phase: 'idle', error: undefined })
    this.busy = true
    try {
      this.emit({ phase: 'checking', channel: null, error: undefined })
      // 三通道串行各拉一次定点 manifest（验签失败按该通道无更新处理，不置 failed）
      for (const channel of ['payload', 'renderer', 'shell'] as const) {
        try {
          this.feedVersions[channel] = (await this.verifyFeedManifest(channel)).version
        } catch {
          /* 静默：check 失败不打扰（§1.2 启动静默检查语义） */
        }
      }
    } finally {
      // 先释放互斥锁再自动应用，否则 apply 会被 check 自己持有的 busy 门挡回（自锁）
      this.busy = false
    }
    // 测试通道：smoke 用（§6.2 壳演练）；风险面仅限"已验签的 staging 内容被自动应用"
    if (process.env.AGENTDECK_HOT_AUTO_APPLY_SHELL === '1') {
      await this.apply('shell').catch(() => {})
      await this.apply('shell').catch(() => {})
    }
    return this.emit({ phase: 'idle', channel: null, error: undefined })
  }

  async apply(channel: UpdateChannel): Promise<{ ok: boolean; error?: string }> {
    if (this.busy) return { ok: false, error: '更新操作进行中，请稍候' }
    this.busy = true
    try {
      return await this.applyChannel(channel)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      this.busy = false
    }
  }

  private async applyChannel(channel: UpdateChannel): Promise<{ ok: boolean; error?: string }> {
    if (channel === 'shell') return await this.applyShell()
    await this.stageAndFlip(channel)
    return { ok: true }
  }

  /**
   * 一键更新（UI「开始更新」）：renderer→payload 顺序应用（payload 有空闲门控，
   * 非空闲挂起为 staged 由退出时补应用），shell 只做 staging——确认动作（§9.3 半自动）
   * 仍由用户显式 apply('shell') 触发。单次持锁串行，与手动 apply 互斥。
   */
  async applyAll(): Promise<{ ok: boolean; error?: string }> {
    if (this.busy) return { ok: false, error: '更新操作进行中，请稍候' }
    this.busy = true
    try {
      let applied = 0
      let firstError: string | null = null
      // 载荷优先：P6 全量自带渲染层，且先把新版比较器/下载逻辑落地（旧版客户端的渲染层门禁
      // 误判只有靠载荷更新解开）；单通道失败不阻断其余通道
      for (const channel of ['payload', 'renderer'] as const) {
        if (!this.availableFor(channel)) continue
        try {
          await this.stageAndFlip(channel)
          applied++
        } catch (error) {
          firstError ??= error instanceof Error ? error.message : String(error)
        }
      }
      if (this.availableFor('shell') && !this.stagedShell) {
        try {
          await this.applyShell()
          applied++
        } catch (error) {
          firstError ??= error instanceof Error ? error.message : String(error)
        }
      }
      if (firstError && applied === 0) return { ok: false, error: firstError }
      return { ok: true }
    } finally {
      this.busy = false
    }
  }

  /** feed 上有比本地当前更新的版本则返回该版本号（available 快照与 applyAll 编排共用） */
  private availableFor(channel: UpdateChannel): string | undefined {
    const feed = this.feedVersions[channel]
    if (!feed) return undefined
    const active = channel === 'shell' ? this.deps.getShellVersion() : this.activeVersionFor(channel)
    if (feed === active) return undefined
    // 只把「严格高于当前」当可更新：壳通道版本串与基座不同但内容相同时不诱导 314MB 空下载；
    // 服务端 manifest 被回滚（降级）也不当更新报
    return compareSemver(feed, active) === 1 ? feed : undefined
  }

  private activeVersionFor(channel: 'renderer' | 'payload'): string {
    const shellVersion = this.shellVersion()
    const hot = resolveHotState(this.deps.getUserDataDir(), shellVersion)
    if (channel === 'payload') return hot.payload?.version ?? shellVersion
    // P6：载荷生效时其自带渲染层即当前渲染层（L2 指针已被清，feed 渲染层只与载荷版本比）
    if (hot.payload) return hot.payload.version
    try {
      return readPointer(this.deps.getUserDataDir(), 'renderer')?.version ?? shellVersion
    } catch {
      return shellVersion
    }
  }

  async rollback(channel: UpdateChannel): Promise<{ ok: boolean; error?: string }> {
    if (this.busy) return { ok: false, error: '更新操作进行中，请稍候' }
    this.busy = true
    try {
      if (channel === 'shell') {
        const appDir = this.deps.getAppDir()
        if (!appDir) return { ok: false, error: '当前运行模式不支持壳回滚（dev / 非目录式分发）' }
        const userData = this.deps.getUserDataDir()
        rollbackShell(appDir, () => {
          clearPointer(userData, 'payload', 'superseded')
          clearPointer(userData, 'renderer', 'superseded')
        })
        this.deps.relaunchForUpdate('rollback-shell')
        return { ok: true }
      }
      const userData = this.deps.getUserDataDir()
      const root = channelRoot(userData, channel)
      const current = (() => {
        try {
          return readPointer(userData, channel)?.version ?? null
        } catch {
          return null
        }
      })()
      const candidates = fs.existsSync(root)
        ? fs.readdirSync(root, { withFileTypes: true })
            .filter((e) => e.isDirectory() && isVersionDir(e.name) && e.name !== current)
            .map((e) => ({ name: e.name, mtime: fs.statSync(path.join(root, e.name)).mtimeMs }))
            .sort((a, b) => b.mtime - a.mtime)
        : []
      const target = candidates[0]
      if (!target) return { ok: false, error: '没有可回退的历史版本（保留窗口内无其他版本）' }
      const manifestPath = path.join(root, target.name, 'manifest.json')
      const verdict = verifyManifest(manifestPath, channel, this.currentGates())
      if (!verdict.ok) return { ok: false, error: `历史版本校验失败：${verdict.reason}` }
      this.flipPointer(channel, target.name, verdict.manifest)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      this.busy = false
    }
  }

  /** relaunch 后载荷入口上报（§7.2 步 11）：推送一条刷新后的状态 */
  notifyApplied(version: string): void {
    this.staged = null
    this.emit({ phase: 'idle', channel: null, error: undefined, stagedVersion: undefined })
    void version
  }

  /** 渲染层运行期自愈回退的上报（§4.3 did-fail-load / render-process-gone） */
  notifyRendererFallback(reason: string): void {
    this.emit({ phase: 'idle', channel: 'renderer', error: `渲染层已回退内置：${reason}` })
  }

  hasStagedPayload(): boolean {
    return this.staged !== null
  }

  /** 退出时补应用（§5.1 autoInstallOnAppQuit 语义；调用方挂在 before-quit 链） */
  async applyStagedOnQuit(): Promise<void> {
    if (!this.staged) return
    // 仅空闲时补应用：有任务在跑时退出本来就要停机会话（zcode 侧会看到"已停止"），
    // 再叠一次版本翻转+重启会让中断与换版互相纠缠（实测：重启闪断、双窗口）——
    // 宁可放弃本次挂起，留待下次空闲时用户再点一次「开始更新」
    if (!this.deps.isMainIdle()) {
      this.staged = null
      return
    }
    const version = this.staged.version
    this.staged = null
    const userData = this.deps.getUserDataDir()
    const manifestPath = path.join(channelRoot(userData, 'payload'), version, 'manifest.json')
    const verdict = verifyManifest(manifestPath, 'payload', this.currentGates())
    if (!verdict.ok) return
    this.flipPointer('payload', version, verdict.manifest)
    this.deps.relaunchForUpdate(version)
  }

  // ---------- 内部 ----------

  private feedBase(): string {
    const custom = this.deps.settings().updateFeedUrl?.trim()
    return custom || DEFAULT_FEED_BASE
  }

  /** 生效主进程版本（载荷 manifest.version 优先，否则壳版本）——L2 门禁基准（§2.2 规则 6） */
  private currentGates(): { mainVersion: string; shellVersion: string } {
    const shellVersion = this.shellVersion()
    const hot = resolveHotState(this.deps.getUserDataDir(), shellVersion)
    return { mainVersion: hot.payload?.version ?? shellVersion, shellVersion }
  }

  private shellVersion(): string {
    return this.deps.getShellVersion()
  }

  private async verifyFeedManifest(channel: UpdateChannel): Promise<HotManifestPayload> {
    const { manifestBytes, payload } = await fetchManifest(this.feedBase(), channel)
    const tmpDir = channel === 'shell' ? path.join(this.deps.getUserDataDir(), 'hot-shell') : channelRoot(this.deps.getUserDataDir(), channel)
    const tmp = path.join(tmpDir, `.latest-${channel}.json`)
    fs.mkdirSync(path.dirname(tmp), { recursive: true })
    fs.writeFileSync(tmp, manifestBytes)
    try {
      const verdict = verifyManifest(tmp, channel, this.currentGates())
      if (!verdict.ok) throw new Error(`feed manifest 校验失败：${verdict.reason}`)
      return verdict.manifest
    } finally {
      try {
        fs.unlinkSync(tmp)
      } catch { /* 临时文件清理失败无碍 */ }
    }
  }

  /** staging 全流程 + 指针翻转（§5.1；下载中断/校验失败/目标已存在各分支均现网零触碰） */
  private async stageAndFlip(channel: HotChannel): Promise<void> {
    const userData = this.deps.getUserDataDir()
    this.emit({ phase: 'downloading', channel, error: undefined })
    const { manifestBytes, payload } = await fetchManifest(this.feedBase(), channel)
    const artifact = payload.artifact
    if (!artifact || !artifact.name || !artifact.sha256) throw new Error('feed manifest 缺 artifact（zip 产物清单）')
    const staging = path.join(channelRoot(userData, channel), `.staging-${Date.now()}`)
    fs.mkdirSync(staging, { recursive: true })
    try {
      const zipPath = path.join(staging, 'artifact.zip')
      await downloadArtifact(this.feedBase(), channel, artifact.name, zipPath, (progress) => {
        this.emit({ phase: 'downloading', channel, progress })
      })
      this.emit({ phase: 'verifying', channel, progress: undefined })
      if (sha256File(zipPath) !== artifact.sha256) throw new Error('下载产物 sha256 与 manifest 不符')
      if (fs.statSync(zipPath).size !== artifact.size) throw new Error('下载产物大小与 manifest 不符')
      const extracted = path.join(staging, 'payload')
      const entries = extractZipStore(zipPath, extracted)
      const byPath = new Map(entries.map((e) => [e.path, e]))
      for (const file of payload.files ?? []) {
        const hit = byPath.get(file.path)
        const target = path.join(extracted, ...file.path.split('/'))
        if (!hit || !fs.existsSync(target)) throw new Error(`载荷缺文件：${file.path}`)
        if (fs.statSync(target).size !== file.size || sha256File(target) !== file.sha256) {
          throw new Error(`文件校验失败：${file.path}`)
        }
      }
      fs.writeFileSync(path.join(extracted, 'manifest.json'), manifestBytes)
      const verdict = verifyManifest(path.join(extracted, 'manifest.json'), channel, this.currentGates())
      if (!verdict.ok) throw new Error(`staging manifest 校验失败：${verdict.reason}`)
      // rename 成版本目录（同卷原子；目标已存在 = 版本已装，直接复用）
      const targetDir = path.join(channelRoot(userData, channel), payload.version)
      if (fs.existsSync(targetDir)) {
        fs.rmSync(staging, { recursive: true, force: true })
      } else {
        fs.renameSync(extracted, targetDir)
        fs.rmSync(staging, { recursive: true, force: true })
      }
      // L1 空闲门控（§7.2 步 3；staging 已装好，指针翻转推迟到空闲或退出时）
      if (channel === 'payload' && !this.deps.isMainIdle()) {
        this.staged = { version: payload.version }
        this.emit({ phase: 'staged', channel, stagedVersion: payload.version })
        return
      }
      this.flipPointer(channel, payload.version, payload)
    } catch (error) {
      try {
        fs.rmSync(staging, { recursive: true, force: true })
      } catch { /* 清理失败不放大错误 */ }
      this.emit({ phase: 'failed', channel, error: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }

  /**
   * 壳通道两段式（§9.3 半自动）：首次调用 = 下载+验签+staging（不动现网，state 置 staged）；
   * 再次调用 = 用户确认 → 空闲校验 → rename dance（§5.3）→ relaunch。确认动作本身即 §9.3 的
   * 一键确认门，不做退出时自动应用（区别于载荷通道的空闲挂起语义）。
   */
  private async applyShell(): Promise<{ ok: boolean; error?: string }> {
    const appDir = this.deps.getAppDir()
    if (!appDir) return { ok: false, error: '当前运行模式不支持壳更新（dev / 非目录式分发）' }
    if (this.stagedShell) {
      const { version, stagedDir } = this.stagedShell
      if (!this.deps.isMainIdle()) return { ok: false, error: '有任务在执行，请在空闲后再确认壳更新' }
      this.emit({ phase: 'applying', channel: 'shell', error: undefined })
      const userData = this.deps.getUserDataDir()
      // §5.3 两阶段：存活期先放无锁文件；swap helper（分离进程）等本进程退出后完成
      // 剩余腾挪（.old-<ts> 让位）并拉起新壳——主进程不再 relaunch，避免双启动竞态
      placeUnlockedFiles(appDir, stagedDir)
      spawnSwapHelper(appDir, stagedDir, process.pid, version, userData)
      // §6 协同规则：壳自带最新载荷 → 清两层指针（全量 > 增量）；helper 失败的最坏结果 =
      // 混排目录 + 无指针 → bootstrap 回内置，仍可启动
      clearPointer(userData, 'payload', 'superseded')
      clearPointer(userData, 'renderer', 'superseded')
      this.stagedShell = null
      if (this.deps.quitForShellUpdate) {
        this.deps.quitForShellUpdate()
      } else {
        this.deps.relaunchForUpdate(version)
      }
      return { ok: true }
    }
    const payload = await this.verifyFeedManifest('shell')
    if (!payload.artifact?.name) throw new Error('feed manifest 缺 artifact（壳 zip 清单）')
    if (payload.version === this.deps.getShellVersion()) return { ok: true } // 已是最新
    this.emit({ phase: 'downloading', channel: 'shell', error: undefined })
    const downloadDir = path.join(this.deps.getUserDataDir(), 'hot-shell')
    fs.mkdirSync(downloadDir, { recursive: true })
    const zipPath = path.join(downloadDir, `.download-${Date.now()}.zip`)
    let staged: string | null = null
    try {
      await downloadArtifact(this.feedBase(), 'shell', payload.artifact.name, zipPath, (progress) => {
        this.emit({ phase: 'downloading', channel: 'shell', progress })
      })
      this.emit({ phase: 'verifying', channel: 'shell', progress: undefined })
      if (sha256File(zipPath) !== payload.artifact.sha256) throw new Error('壳下载产物 sha256 与 manifest 不符')
      staged = stageShellZip(zipPath, appDir)
      for (const file of payload.files ?? []) {
        // Electron 的 fs-asar 拦截层会把 .asar 后缀路径当归档打开（readFileSync 抛 Invalid package），
        // 无法按字节读回；该条目的完整性已由 zip 整体 sha256 + 解压逐条 CRC 双重覆盖，磁盘级 sha 只对普通文件执行
        if (/\.asar$/i.test(file.path)) continue
        const target = path.join(staged, ...file.path.split('/'))
        if (!fs.existsSync(target) || fs.statSync(target).size !== file.size || sha256File(target) !== file.sha256) {
          throw new Error(`壳文件校验失败：${file.path}`)
        }
      }
      this.stagedShell = { version: payload.version, stagedDir: staged }
      this.emit({ phase: 'staged', channel: 'shell', stagedVersion: payload.version })
      return { ok: true }
    } catch (error) {
      if (staged) {
        try { fs.rmSync(staged, { recursive: true, force: true }) } catch { /* 清理失败不放大 */ }
      }
      this.emit({ phase: 'failed', channel: 'shell', error: error instanceof Error ? error.message : String(error) })
      throw error
    } finally {
      try { fs.unlinkSync(zipPath) } catch { /* 临时 zip 清理失败无碍 */ }
    }
  }

  /** 指针翻转 + 通道专属后动作（renderer=loadFile 新路径； payload=清 L2 指针+relaunch，P6） */
  private flipPointer(channel: HotChannel, version: string, manifest: HotManifestPayload): void {
    const userData = this.deps.getUserDataDir()
    this.emit({ phase: 'applying', channel, stagedVersion: undefined })
    writePointerAtomic(pointerFilePath(userData, channel), {
      schemaVersion: 1,
      channel,
      version,
      dir: `${channel === 'payload' ? 'hot-app' : 'hot-renderer'}/${version}`,
      manifestSha256: sha256File(path.join(channelRoot(userData, channel), version, 'manifest.json')),
      appliedAt: Date.now(),
      appliedByShell: this.shellVersion()
    })
    if (channel === 'renderer') {
      const indexHtml = path.join(channelRoot(userData, channel), version, 'out', 'renderer', 'index.html')
      this.deps.getWindow()?.loadFile(indexHtml)
      this.gc(channel, version)
      this.emit({ phase: 'idle', channel: null, error: undefined })
    } else {
      // 全量 > 增量（P6）：载荷自带渲染层接管，重置 L2 指针后干净重启
      clearPointer(userData, 'renderer', 'superseded')
      this.gc(channel, version)
      this.deps.relaunchForUpdate(manifest.version)
    }
  }

  /** 版本目录 GC：保留最近 3 版（当前指向版永不回收） */
  private gc(channel: HotChannel, keepVersion: string): void {
    try {
      const root = channelRoot(this.deps.getUserDataDir(), channel)
      if (!fs.existsSync(root)) return
      const dirs = fs
        .readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory() && isVersionDir(e.name))
        .map((e) => ({ name: e.name, mtime: fs.statSync(path.join(root, e.name)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)
      for (const dir of dirs.slice(GC_KEEP_VERSIONS)) {
        if (dir.name === keepVersion) continue
        fs.rmSync(path.join(root, dir.name), { recursive: true, force: true })
      }
    } catch { /* GC 失败不影响更新主流程 */ }
  }

  private computeSnapshot(): UpdateStateSnapshot {
    const shellVersion = this.shellVersion()
    const userData = this.deps.getUserDataDir()
    const hot = resolveHotState(userData, shellVersion)
    let activeRendererVersion: string | undefined
    if (hot.reason === 'renderer') {
      try {
        const pointer = readPointer(userData, 'renderer')
        if (pointer) activeRendererVersion = pointer.version
      } catch { /* 诊断字段，失败即缺省 */ }
    }
    const available: { renderer?: string; payload?: string; shell?: string } = {}
    for (const channel of ['renderer', 'payload', 'shell'] as const) {
      const v = this.availableFor(channel)
      if (v) available[channel] = v
    }
    return {
      ...this.snapshot,
      currentVersion: hot.payload?.version ?? shellVersion,
      activeRendererVersion,
      available
    }
  }

  private emit(patch: Partial<UpdateStateSnapshot>): UpdateStateSnapshot {
    this.snapshot = { ...this.snapshot, ...patch }
    const next = this.computeSnapshot()
    // 观测通道：env 指定日志文件时逐行追加状态流（smoke/现场排障用；默认零开销）
    const debugLog = process.env.AGENTDECK_HOT_DEBUG_LOG
    if (debugLog) {
      try {
        fs.appendFileSync(debugLog, `${new Date().toISOString()} ${next.phase}${next.channel ? ':' + next.channel : ''}${next.error ? ' !' + next.error : ''}\n`)
      } catch { /* 日志失败不影响主流程 */ }
    }
    for (const listener of this.listeners) listener(next)
    this.deps.getWindow()?.webContents.send('updates:state', next)
    return next
  }
}
