// 热更更新器（设计 §5.1）：renderer/payload 两通道共用状态机。
// staging → 验签 → 原子指针 → （载荷）relaunch；任一步失败删 staging、现网零触碰（P5）。
// 串行互斥：check/apply/rollback 全程单飞，两通道不同时跑（§5.3 互斥对策）。
import fs from 'node:fs'
import path from 'node:path'
import type { BrowserWindow } from 'electron'
import type { UpdateChannel, UpdateStateSnapshot } from '../../shared/contracts'
import type { AppSettings } from '../../shared/types'
import { DEFAULT_FEED_BASE } from './trust'
import { channelRoot, clearPointer, pointerFilePath, readPointer, writePointerAtomic } from './pointer'
import { sha256File, verifyManifest, type HotManifestPayload } from './verifier'
import { resolveHotState } from './resolve'
import { downloadArtifact, fetchManifest } from './feed'
import { extractZipStore } from './zip'

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
      // 两通道串行各拉一次定点 manifest（验签失败按该通道无更新处理，不置 failed）
      for (const channel of ['payload', 'renderer'] as const) {
        try {
          await this.verifyFeedManifest(channel)
        } catch {
          /* 静默：check 失败不打扰（§1.2 启动静默检查语义） */
        }
      }
      return this.emit({ phase: 'idle', channel: null, error: undefined })
    } finally {
      this.busy = false
    }
  }

  async apply(channel: UpdateChannel): Promise<{ ok: boolean; error?: string }> {
    if (this.busy) return { ok: false, error: '更新操作进行中，请稍候' }
    this.busy = true
    try {
      await this.stageAndFlip(channel)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      this.busy = false
    }
  }

  async rollback(channel: UpdateChannel): Promise<{ ok: boolean; error?: string }> {
    if (this.busy) return { ok: false, error: '更新操作进行中，请稍候' }
    this.busy = true
    try {
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
    const tmp = path.join(channelRoot(this.deps.getUserDataDir(), channel), `.latest-${channel}.json`)
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
  private async stageAndFlip(channel: UpdateChannel): Promise<void> {
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

  /** 指针翻转 + 通道专属后动作（renderer=loadFile 新路径； payload=清 L2 指针+relaunch，P6） */
  private flipPointer(channel: UpdateChannel, version: string, manifest: HotManifestPayload): void {
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
  private gc(channel: UpdateChannel, keepVersion: string): void {
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
    return {
      ...this.snapshot,
      currentVersion: hot.payload?.version ?? shellVersion,
      activeRendererVersion
    }
  }

  private emit(patch: Partial<UpdateStateSnapshot>): UpdateStateSnapshot {
    this.snapshot = { ...this.snapshot, ...patch }
    const next = this.computeSnapshot()
    for (const listener of this.listeners) listener(next)
    this.deps.getWindow()?.webContents.send('updates:state', next)
    return next
  }
}
