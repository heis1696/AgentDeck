import { useEffect, useMemo, useState } from 'react'
import { Download, RefreshCw, RotateCcw, Rocket } from 'lucide-react'
import { bridge, useSettings } from '../api'
import type { UpdateStateSnapshot } from '../../../shared/contracts'
import { EmptyState } from '../ui/EmptyState'
import { toast } from '../ui/Toasts'

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
  payload: 'L1 载荷'
}

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

/** 免安装热更：版本快照 + 手动检查/应用/回退 + feed 基址（留空 = 内置 DEFAULT_FEED_BASE） */
export function UpdatePanel() {
  const { settings, update } = useSettings()
  const [state, setState] = useState<UpdateStateSnapshot | null>(null)
  const [busy, setBusy] = useState(false)
  const [feedDraft, setFeedDraft] = useState('')

  useEffect(() => {
    let mounted = true
    bridge.updates.getState().then((snapshot) => { if (mounted) setState(snapshot) }).catch((e) => {
      if (mounted) toast.error(e instanceof Error ? e.message : String(e))
    })
    const off = bridge.updates.onState((snapshot) => { if (mounted) setState(snapshot) })
    return () => { mounted = false; off() }
  }, [])

  useEffect(() => {
    if (settings) setFeedDraft(settings.updateFeedUrl ?? '')
  }, [settings?.updateFeedUrl])

  const percent = useMemo(() => {
    if (!state?.progress || state.progress.totalBytes <= 0) return 0
    return Math.min(100, Math.round((state.progress.receivedBytes / state.progress.totalBytes) * 100))
  }, [state?.progress])

  if (!settings) return <EmptyState title="设置加载中" />

  const pending = state ? ['checking', 'downloading', 'verifying', 'applying'].includes(state.phase) : false
  const disableOps = busy || pending

  const run = async (op: () => Promise<unknown>, okMsg?: string) => {
    if (busy) return
    setBusy(true)
    try {
      const r = await op()
      if (r && typeof r === 'object' && 'ok' in r && !(r as { ok: boolean }).ok) {
        toast.error((r as { error?: string }).error ?? '操作失败')
      } else if (okMsg) {
        toast.success(okMsg)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const commitFeed = () => {
    const next = feedDraft.trim()
    update({ updateFeedUrl: next }).catch((e) => toast.error(e instanceof Error ? e.message : String(e)))
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
            <div style={{ height: 6, borderRadius: 3, background: 'var(--bg-inset)', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${percent}%`, background: 'var(--accent)', transition: 'width var(--duration-base)' }} />
            </div>
          </div>
        )}
        {state?.error && <p className="hint probe-fail">{state.error}</p>}
        <div className="row">
          <button className="btn" disabled={disableOps} onClick={() => void run(() => bridge.updates.check())}>
            <RefreshCw size={14} className={pending && state?.phase === 'checking' ? 'spin' : ''} /> 检查更新
          </button>
          <button className="btn" disabled={disableOps} onClick={() => void run(() => bridge.updates.apply('renderer'), '已应用，正在重载')}>
            <Download size={14} /> 应用并重载（L2）
          </button>
          <button className="btn" disabled={disableOps} onClick={() => void run(() => bridge.updates.apply('payload'), '已应用，即将重启')}>
            <Rocket size={14} /> 应用并重启（L1）
          </button>
          <button className="btn" disabled={disableOps} onClick={() => void run(() => bridge.updates.rollback('renderer'), '已回退上一版')}>
            <RotateCcw size={14} /> 回退上一版
          </button>
        </div>
      </section>

      <section className="settings-card">
        <h3>更新源</h3>
        <p className="hint">热更 feed 基址；留空 = 内置默认（DEFAULT_FEED_BASE）。</p>
        <label className="field">
          <span>feed 基址</span>
          <input
            value={feedDraft}
            placeholder="https://updates.example.com/agentdeck"
            onChange={(e) => setFeedDraft(e.target.value)}
            onBlur={commitFeed}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur() } }}
          />
        </label>
      </section>
    </div>
  )
}
