import { useEffect, useState } from 'react'
import { Sparkles, X, LoaderCircle, Check, FastForward } from 'lucide-react'
import type { ThinkingLevel } from '../../../shared/types'
import { ui } from './interaction-center'
import { interactionLayers } from './interaction-layer'
import { useInteractionSelector } from '../hooks/useInteraction'

const LEVELS: ReadonlyArray<{ value: ThinkingLevel; short: string; label: string }> = [
  { value: 'off', short: '关', label: '关闭思考' },
  { value: 'low', short: '低', label: '低思考' },
  { value: 'medium', short: '中', label: '中思考' },
  { value: 'high', short: '高', label: '高思考' },
  { value: 'max', short: '极', label: '极致思考' }
]

const LEVEL_NAMES: Record<ThinkingLevel, string> = { off: '关', low: '低', medium: '中', high: '高', max: '极致' }

/**
 * 动态思考强度两道 2s 底部悬浮确认条（非模态，挂载在 App 根部与 ToastHost 同级）：
 * - 阶段 1（confirm-triage）：询问是否跳过分诊，2s 后才调分诊师（零偷跑）
 * - 阶段 2（assessing）：分诊师评估中，可随时跳过/手选/取消
 * - 阶段 3（confirm-level）：展示分诊定档与理由，2s 后自动执行，hover 暂停倒计时
 */
export function TriageBar() {
  const triage = useInteractionSelector((state) => state.triage)
  const [tickNow, setTickNow] = useState(() => Date.now())

  const open = triage.stage !== 'idle'
  const counting = (triage.stage === 'confirm-triage' || triage.stage === 'confirm-level') && !triage.hovered && triage.deadlineAt !== null

  useEffect(() => {
    if (!counting) return
    setTickNow(Date.now())
    const id = window.setInterval(() => setTickNow(Date.now()), 50)
    return () => window.clearInterval(id)
  }, [counting, triage.deadlineAt])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (interactionLayers.topModal()) return
      event.preventDefault()
      ui.triage.cancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open])

  if (!open) return null

  const remainingMs = triage.deadlineAt !== null
    ? Math.max(0, triage.deadlineAt - tickNow)
    : triage.remainingMs
  const progressPct = triage.durationMs > 0
    ? Math.max(0, Math.min(100, (remainingMs / triage.durationMs) * 100))
    : 0
  const secondsText = `${(remainingMs / 1000).toFixed(1)}s`
  const skipLabel = triage.kind === 'followup' ? '跳过（沿用原档）' : '跳过'

  return (
    <div
      className={`triage-bar triage-stage-${triage.stage}`}
      role="status"
      aria-live="polite"
      onMouseEnter={() => ui.triage.setHovered(true)}
      onMouseLeave={() => ui.triage.setHovered(false)}
    >
      <div className="triage-bar-row">
        <div className="triage-bar-main">
          {triage.stage === 'assessing'
            ? <LoaderCircle size={14} className="triage-bar-icon spin" aria-hidden="true" />
            : <Sparkles size={14} className="triage-bar-icon" aria-hidden="true" />}
          {triage.stage === 'confirm-triage' && (
            <div className="triage-bar-copy">
              <span className="triage-bar-title">
                即将评估思考强度
                {triage.agentName ? <span className="triage-bar-agent"> · {triage.agentName}</span> : null}
              </span>
              <span className="triage-bar-countdown">
                {triage.hovered ? '已暂停（移开继续）' : `${secondsText} 后评估`}
              </span>
            </div>
          )}
          {triage.stage === 'assessing' && (
            <div className="triage-bar-copy">
              <span className="triage-bar-title">
                分诊师评估任务难度中…
                {triage.agentName ? <span className="triage-bar-agent"> · {triage.agentName}</span> : null}
              </span>
              <span className="triage-bar-countdown">可直接跳过或手动选档</span>
            </div>
          )}
          {triage.stage === 'confirm-level' && triage.decision && (
            <div className="triage-bar-copy">
              <span className="triage-bar-title">
                分诊师建议
                <span className="triage-bar-badge">{LEVEL_NAMES[triage.decision.level]}</span>
                {triage.decision.cachePreserved && <span className="triage-bar-tag" title="小幅降档已抑制以保护 Prompt Cache">保缓存</span>}
              </span>
              <span className="triage-bar-reason" title={triage.decision.reason}>
                {triage.decision.reason} · {triage.hovered ? '已暂停' : `${secondsText} 后执行`}
              </span>
            </div>
          )}
        </div>

        <div className="triage-bar-actions">
          <div className="triage-level-pills" role="group" aria-label="手动选择思考强度">
            {LEVELS.map((lv) => {
              const active = triage.stage === 'confirm-level' && triage.decision?.level === lv.value
              return (
                <button
                  key={lv.value}
                  type="button"
                  className={`triage-pill${active ? ' active' : ''}`}
                  title={lv.label}
                  onClick={() => ui.triage.pickLevel(lv.value)}
                >
                  {lv.short}
                </button>
              )
            })}
          </div>
          {triage.stage !== 'confirm-level' && (
            <button type="button" className="triage-btn" onClick={() => ui.triage.skip()}>
              <FastForward size={12} aria-hidden="true" /> {skipLabel}
            </button>
          )}
          {triage.stage === 'confirm-triage' && (
            <button type="button" className="triage-btn primary" onClick={() => ui.triage.confirmNow()}>
              立即评估
            </button>
          )}
          {triage.stage === 'confirm-level' && (
            <button type="button" className="triage-btn primary" onClick={() => ui.triage.confirmNow()}>
              <Check size={12} aria-hidden="true" /> 立即执行
            </button>
          )}
          <button
            type="button"
            className="triage-close"
            title="取消发送（保留输入，Esc）"
            aria-label="取消发送"
            onClick={() => ui.triage.cancel()}
          >
            <X size={13} aria-hidden="true" />
          </button>
        </div>
      </div>

      {(triage.stage === 'confirm-triage' || triage.stage === 'confirm-level') && (
        <div className="triage-bar-progress" aria-hidden="true">
          <div className="triage-bar-progress-fill" style={{ width: `${progressPct}%` }} />
        </div>
      )}
    </div>
  )
}
