import { useEffect, useState } from 'react'
import { bridge } from '../../api'
import { ui } from '../../ui/interaction-center'
import { useInteractionLayer } from '../../hooks/useInteractionLayer'
import { Menu } from '../../ui/Menu'
import type { AgentInfo } from '../../../../shared/contracts'

/** 创建对话框的预填信息：来自 Issue 绑定任务的 title/workdir/agentId/backend */
export interface GoalPrefill {
  text: string
  workdir: string
  agentId?: string
  backend?: string
}

interface CreateDraft {
  text: string
  completion: string
  stop: string
  maxRuns: number
  hours: number
  agentId: string
  startNow: boolean
}

const lines = (text: string) => text.split('\n').map((line) => line.trim()).filter(Boolean)

/** 开启目标模式的创建对话框：GoalPanel（Issue 内语境）与全局目标页共用 */
export function GoalCreateDialog({ issueId, prefill, onClose }: { issueId: string; prefill: GoalPrefill; onClose: () => void }) {
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState<CreateDraft>({ text: prefill.text, completion: '', stop: '', maxRuns: 8, hours: 8, agentId: prefill.agentId ?? '', startNow: true })
  // 统一浮层：Escape 关闭 + Tab 焦点陷阱 + 焦点归还
  const layerRef = useInteractionLayer<HTMLDivElement>({ open: true, onClose, kind: 'modal', name: 'goal-create', trap: true })

  useEffect(() => { bridge.agents.list().then(setAgents).catch(() => {}) }, [])

  const canCreate = draft.text.trim().length > 0 && lines(draft.completion).length > 0

  const commitCreate = async () => {
    setBusy(true)
    try {
      const agent = agents.find((a) => a.id === draft.agentId)
      await bridge.goals.create({
        text: draft.text.trim(),
        issueId,
        completionConditions: lines(draft.completion),
        stopConditions: lines(draft.stop),
        maxRuns: Math.max(1, Math.floor(draft.maxRuns) || 1),
        maxDurationMs: Math.max(1, Math.floor(draft.hours * 3600_000) || 3600_000),
        workdir: prefill.workdir,
        agentId: draft.agentId || undefined,
        backend: agent?.backend ?? prefill.backend,
        startNow: draft.startNow
      })
      ui.toast.success('目标模式已开启')
      onClose()
    } catch (e) {
      ui.toast.error('开启失败: ' + (e instanceof Error ? e.message : String(e)))
    }
    setBusy(false)
  }

  return <div className="overlay" ref={layerRef} onClick={(e) => e.target === e.currentTarget && onClose()}>
    <div className="dialog">
      <h2>开启目标模式</h2>
      <p className="hint">在本 Issue 上开启自动推进：agent 每轮自评并继续，直到完成条件全部达成（完成条件须可验证）。</p>
      <label className="field"><span>目标 *</span><textarea value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value })} rows={3} autoFocus placeholder="如：把 docs/ 下的 API 文档全部对齐当前代码" /></label>
      <label className="field"><span>完成条件 *（每行一条，逐条可验证）</span><textarea value={draft.completion} onChange={(e) => setDraft({ ...draft, completion: e.target.value })} rows={3} placeholder={'每条一行，如：\n所有示例可编译\n接口签名与 src 一致'} /></label>
      <label className="field"><span>停止条件（每行一条，命中即暂停等你决策）</span><textarea value={draft.stop} onChange={(e) => setDraft({ ...draft, stop: e.target.value })} rows={2} placeholder={'如：\n需要删除用户数据\n需要付费 API 密钥'} /></label>
      <div className="row" style={{ gap: 12 }}>
        <label className="field" style={{ flex: 1 }}><span>最大轮数</span><input type="number" min={1} value={draft.maxRuns} onChange={(e) => setDraft({ ...draft, maxRuns: Number(e.target.value) })} /></label>
        <label className="field" style={{ flex: 1 }}><span>最长总时长（小时）</span><input type="number" min={0.5} step={0.5} value={draft.hours} onChange={(e) => setDraft({ ...draft, hours: Number(e.target.value) })} /></label>
      </div>
      <label className="field">
        <span>执行 Agent</span>
        <Menu
          items={[{ value: prefill.agentId ?? '', label: prefill.agentId ? '沿用当前 Issue 的 Agent' : '不指定（按平台默认执行）' }, ...agents.filter((a) => a.id !== prefill.agentId).map((a) => ({ value: a.id, label: a.name }))]}
          value={draft.agentId}
          onChange={(v) => setDraft({ ...draft, agentId: v })}
          trigger={(cur, open) => <button className="btn menu-trigger" type="button">{cur?.label ?? '不指定'} <span className="menu-caret">{open ? '▴' : '▾'}</span></button>}
        />
      </label>
      <label className="field row" style={{ gap: 8, alignItems: 'center' }}>
        <input type="checkbox" checked={draft.startNow} onChange={(e) => setDraft({ ...draft, startNow: e.target.checked })} />
        <span>创建后立即开始推进（会生成执行任务）</span>
      </label>
      <div className="dialog-footer">
        <span className="hint">工作目录：{prefill.workdir || '（未绑定）'}</span>
        <button className="btn primary" disabled={!canCreate || busy} onClick={() => void commitCreate()}>{draft.startNow ? '创建并开始推进' : '创建为草稿'}</button>
      </div>
    </div>
  </div>
}
