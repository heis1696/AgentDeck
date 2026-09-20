import { useEffect, useMemo, useRef, useState } from 'react'
import { Download, RefreshCw, RotateCcw, Rocket } from 'lucide-react'
import { bridge, useSettings } from '../api'
import type { UpdateStateSnapshot } from '../../../shared/contracts'
import { EmptyState } from '../ui/EmptyState'
import { ui, isComposingKey } from '../ui/interaction-center'

const PHASE_LABEL: Record<UpdateStateSnapshot['phase'], string> = {
  idle: '空闲',
  checking: '检查中',
  downloading: '下载中',
  verifying: '校验中',
  staged: '已就绪待应用',
  applying: '应用中',
  failed: '失败'
}

const CHANNEL_LABEL: Record<NonNullable<UpdateStateSnapshot['channel']>, string> = {
  renderer: 'L2 渲染层',
  payload: 'L1 载荷',
  shell: 'L0 壳'
}

const CHANNELS = ['renderer', 'payload', 'shell'] as const

const describe = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

/** 当前快照里真正可应用的通道：apply 按钮的唯一启用依据 */
function applicableChannels(state: UpdateStateSnapshot | null): string[] {
  if (!state) return []
  return CHANNELS.filter((channel) => Boolean(state.available?.[channel]))
}

/**
 * 快照自报的失败：phase=failed 或带 error 字段都算错误。
 * 这类快照不能当成「没有可用更新」的结论——它只说明这次检查/应用失败了。
 */
function failureOf(state: UpdateStateSnapshot | null): string | null {
  if (!state) return null
  if (state.phase === 'failed') return state.error ?? '更新通道返回失败'
  return state.error ?? null
}

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

/**
 * 免安装热更：版本快照 + 手动检查/应用/回退 + feed 基址（留空 = 内置 DEFAULT_FEED_BASE）。
 *
 * 操作契约（Batch B）：
 * - 检查更新先把当前 feed 草稿落盘（否则会拿旧地址去查，结果与输入框不符）；
 * - 「开始更新」只在当前快照确实报了可更新通道时才可用，未检查/无更新时点不动；
 * - 检查完成且无可用更新时给明确结论，而不是静默无反应；
 * - 所有操作共用同一个 pending 闸门（ref 同步置位），连点不会重复触发 IPC。
 *
 * 复核（Batch B follow-up）：
 * - 失焦保存与「检查更新」的保存走同一条串行队列，谁都不会绕过对方的在途写入；
 *   检查提交的是点击那一刻的确切草稿，保存期间的新输入不被设置广播回写清掉；
 * - available 为空只能说明「本次没发现可应用的更新」：updater 逐通道静默吞掉检查失败，
 *   所以这里不再声称「已是最新」，显式 failed / error 快照按错误处理；
 * - 显示地址一变，上一次检查的结论与「开始更新」一起失效，必须重新检查。
 */
export function UpdatePanel() {
  const { settings, update } = useSettings()
  const [state, setState] = useState<UpdateStateSnapshot | null>(null)
  const [busy, setBusy] = useState(false)
  const [feedDraft, setFeedDraft] = useState('')
  const [feedError, setFeedError] = useState<string | null>(null)
  const [feedSaved, setFeedSaved] = useState(false)
  const [checkError, setCheckError] = useState<string | null>(null)
  // 本次会话里真的查过的地址；null = 面板内还没查过（不代表没有更新）
  const [checkedFeed, setCheckedFeed] = useState<string | null>(null)
  const busyRef = useRef(false)
  /** 最新草稿：检查在点击那一刻取值，不依赖可能过期的闭包 */
  const draftRef = useRef('')
  /** 已成功落盘的地址：相同地址不重复 IPC */
  const writtenRef = useRef<string | null>(null)
  /** 上一版已落盘地址：决定设置广播能不能覆盖本地草稿 */
  const persistedRef = useRef<string | null>(null)
  /** 串行保存队列：失焦保存与检查前保存排队执行，互不绕过 */
  const saveQueue = useRef<Promise<boolean>>(Promise.resolve(true))

  useEffect(() => {
    let mounted = true
    bridge.updates.getState().then((snapshot) => { if (mounted) setState(snapshot) }).catch((e) => {
      if (mounted) ui.toast.error(e instanceof Error ? e.message : String(e))
    })
    const off = bridge.updates.onState((snapshot) => { if (mounted) setState(snapshot) })
    return () => { mounted = false; off() }
  }, [])

  useEffect(() => {
    if (!settings) return
    const next = settings.updateFeedUrl ?? ''
    const previous = persistedRef.current
    persistedRef.current = next
    if (writtenRef.current === null) writtenRef.current = next
    // 广播只覆盖「没有本地改动」的草稿：保存期间继续输入的内容不能被回写清掉
    if (previous === null || draftRef.current.trim() === previous) {
      draftRef.current = next
      setFeedDraft(next)
    }
  }, [settings?.updateFeedUrl])

  const percent = useMemo(() => {
    if (!state?.progress || state.progress.totalBytes <= 0) return 0
    return Math.min(100, Math.round((state.progress.receivedBytes / state.progress.totalBytes) * 100))
  }, [state?.progress])

  if (!settings) return <EmptyState title="设置加载中" />

  const savedFeed = settings.updateFeedUrl ?? ''
  const feedDirty = feedDraft.trim() !== savedFeed
  const failure = failureOf(state)
  const pending = state ? ['checking', 'downloading', 'verifying', 'applying'].includes(state.phase) : false
  const disableOps = busy || pending
  const available = applicableChannels(state)
  // 当前快照对应的地址：本次会话查过就用查过的地址，否则视为与已落盘地址一致
  const snapshotFeed = checkedFeed ?? savedFeed
  const conclusionCurrent = snapshotFeed === feedDraft.trim()
  const canApply = available.length > 0 ? conclusionCurrent : state?.phase === 'staged' && state?.channel === 'shell'
  const staleConclusion = checkedFeed !== null && !conclusionCurrent

  /** 所有更新操作的共同闸门：ref 与 state 同置，连点只放行第一次 */
  const guard = async (op: () => Promise<void>) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    try {
      await op()
    } catch (e) {
      ui.toast.error(describe(e))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  /** 落盘一个确切地址；失败时保留输入并说明原因 */
  const writeFeed = async (target: string): Promise<boolean> => {
    if (writtenRef.current === target) return true
    try {
      await update({ updateFeedUrl: target })
      writtenRef.current = target
      setFeedError(null)
      setFeedSaved(true)
      return true
    } catch (cause) {
      const detail = describe(cause)
      setFeedError(detail)
      ui.toast.error(`更新源保存失败：${detail}`)
      return false
    }
  }

  /** 串行保存：失焦保存与检查前保存共用一条队列，后到的等前一个写完再判断是否需要写 */
  const saveFeed = (target: string): Promise<boolean> => {
    const next = saveQueue.current.then(() => writeFeed(target), () => writeFeed(target))
    saveQueue.current = next.then(() => true, () => false)
    return next
  }

  const commitFeed = () => {
    // 失焦保存不抢操作闸门，但一定排队：在途的其它写入先完成，且不会因此丢掉这次编辑
    void saveFeed(draftRef.current.trim())
  }

  const run = async (op: () => Promise<unknown>, okMsg?: string) => {
    await guard(async () => {
      const r = await op()
      if (r && typeof r === 'object' && 'ok' in r && !(r as { ok: boolean }).ok) {
        ui.toast.error((r as { error?: string }).error ?? '操作失败')
      } else if (okMsg) {
        ui.toast.success(okMsg)
      }
    })
  }

  const checkNow = async () => {
    await guard(async () => {
      // 检查必须用点击那一刻的地址：先落盘，保存失败就不发起检查
      const submitted = draftRef.current.trim()
      if (!(await saveFeed(submitted))) return
      setCheckError(null)
      const snapshot = await bridge.updates.check()
      setState(snapshot)
      const reported = failureOf(snapshot)
      if (reported) {
        // 显式失败快照就是错误：既不能当「没有更新」，也不能留着旧结论继续可点
        setCheckedFeed(null)
        setCheckError(reported)
        ui.toast.error(`检查更新失败：${reported}`)
        return
      }
      setCheckedFeed(submitted)
      const next = applicableChannels(snapshot)
      if (next.length === 0) {
        // available 为空只证明「本次没发现可应用的更新」：逐通道失败会被 updater 静默吞掉
        ui.toast.info('检查完成：本次未发现可应用的更新。')
      } else {
        ui.toast.success(`检查完成：可更新 ${next.map((channel) => `${CHANNEL_LABEL[channel as (typeof CHANNELS)[number]]} v${snapshot.available?.[channel as (typeof CHANNELS)[number]]}`).join(' · ')}`)
      }
    })
  }

  return (
    <div className="settings-stack">
      <section className="settings-card">
        <div className="runtime-embedded-head">
          <div className="section-heading">
            <h3>版本与通道</h3>
            <span>免安装热更：L2 渲染层免重启热载，L1 载荷应用后重启</span>
          </div>
        </div>
        <div className="field">
          <span>当前版本</span>
          <span className="mono">{state ? state.currentVersion : '…'}</span>
        </div>
        <div className="field">
          <span>L2 渲染层版本（诊断）</span>
          <span className="mono">{state?.activeRendererVersion ?? '—'}</span>
        </div>
        <div className="field">
          <span>状态</span>
          <span>
            {state ? PHASE_LABEL[state.phase] : '加载中…'}
            {state?.channel ? ` · ${CHANNEL_LABEL[state.channel]}通道` : ''}
            {state?.stagedVersion ? ` · 待应用 v${state.stagedVersion}` : ''}
          </span>
        </div>
        {state?.progress && state.progress.totalBytes > 0 && (
          <div className="field">
            <span>下载进度（{fmtBytes(state.progress.receivedBytes)} / {fmtBytes(state.progress.totalBytes)} · {percent}%）</span>
            <div className="progress-track" role="progressbar" aria-label="下载进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
              <div className="progress-fill" style={{ width: `${percent}%` }} />
            </div>
          </div>
        )}
        {failure && <p className="probe-fail" role="alert" data-update-error>{failure}</p>}
        {checkError && <p className="probe-fail" role="alert" data-update-check-error>检查失败：{checkError}。可修正地址后重新检查。</p>}
        {available.length > 0 && (
          <div className="field">
            <span>可更新</span>
            <span className="mono" data-update-available>
              {available
                .map((channel) => `${CHANNEL_LABEL[channel as (typeof CHANNELS)[number]]} v${state?.available?.[channel as (typeof CHANNELS)[number]]}`)
                .join(' · ')}
            </span>
          </div>
        )}
        {staleConclusion && (
          <p className="hint" data-update-stale>地址已改动：上一次检查的结论与「开始更新」已失效，请重新检查更新。</p>
        )}
        {checkedFeed !== null && conclusionCurrent && available.length === 0 && state?.phase === 'idle' && !failure && (
          <p className="hint" data-update-none>本次检查未发现可应用的更新；单个通道的检查失败会被跳过且不在此上报，所以这不等于已确认最新。</p>
        )}
        {state?.channel === 'shell' && state?.phase === 'staged' && state.stagedVersion && (
          <p className="hint">壳更新 v{state.stagedVersion} 已下载并校验就绪。点击下方按钮确认替换应用本体并重启（任务运行中不可执行）。</p>
        )}
        <div className="row">
          <button className="btn" disabled={disableOps} onClick={() => void checkNow()}>
            <RefreshCw size={14} className={pending && state?.phase === 'checking' ? 'spin' : ''} /> 检查更新
          </button>
          {state?.channel === 'shell' && state?.phase === 'staged' ? (
            <button className="btn danger" disabled={disableOps} onClick={() => void run(() => bridge.updates.apply('shell'), '已确认，正在替换壳并重启')}>
              <Rocket size={14} /> 确认并重启完成壳更新（v{state.stagedVersion}）
            </button>
          ) : (
            <button
              className="btn"
              disabled={disableOps || !canApply}
              title={canApply ? undefined : staleConclusion ? '地址已改动：重新检查更新后此按钮才可用。' : '先点「检查更新」，确认有可应用的更新后此按钮才可用。'}
              onClick={() => void run(() => bridge.updates.applyAll(), '已开始更新')}
            >
              <Download size={14} /> 开始更新
            </button>
          )}
          <button className="btn" disabled={disableOps} onClick={() => void run(() => bridge.updates.rollback('renderer'), '已回退上一版')}>
            <RotateCcw size={14} /> 回退上一版
          </button>
        </div>
        <p className="hint">「开始更新」自动编排：界面改动即时生效；功能逻辑应用后按空闲自动重启（有任务在跑则退出时应用）；应用本体更新需再点一次确认。</p>
      </section>

      <section className="settings-card">
        <h3>更新源</h3>
        <p className="hint">热更 feed 基址；留空 = 内置默认（DEFAULT_FEED_BASE）。</p>
        <label className="field">
          <span>feed 基址</span>
          <input
            value={feedDraft}
            placeholder="https://updates.example.com/agentdeck"
            onChange={(e) => { draftRef.current = e.target.value; setFeedDraft(e.target.value); setFeedSaved(false) }}
            onBlur={commitFeed}
            onKeyDown={(e) => { if (isComposingKey(e.nativeEvent)) return; if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur() } }}
          />
        </label>
        {feedDirty && <p className="hint" data-feed-dirty>有未保存的地址；「检查更新」会先保存它再查询。</p>}
        {!feedDirty && feedSaved && <p className="hint probe-ok" data-feed-saved>更新源已保存。</p>}
        {feedError && <p className="probe-fail" role="alert" data-feed-error>更新源保存失败：{feedError}。地址仍保留在输入框。</p>}
      </section>
    </div>
  )
}
