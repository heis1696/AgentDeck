import { useMemo, useState } from 'react'
import type { Meeting } from '../../../shared/meeting'
import { bridge } from '../api'
import { useDeltaCatalog, type DeltaCatalogLifecycle, type DeltaCatalogSources } from './useDeltaCatalog'

/** 会议目录：数据面收敛到 useDeltaCatalog（与 useIssues / BoardView 共用同一编排）。
 *  ready/error 语义经生命周期回调叠加——公共 hook 吞掉读异常，错误只能从回调拿到：
 *  读成功即 ready 并清错，读失败记错误消息。宿主（App.tsx）靠这两态决定「会议失败
 *  不阻断普通任务」，装载模型不变：一次业务 effect、一次初始读，不靠 [items] 推断。 */
export function useMeetings() {
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sources = useMemo<DeltaCatalogSources<Meeting>>(() => ({
    list: () => bridge.meetings.list(),
    // 会议广播分两路（onUpdated 带整条 / onDeleted 只带 id），各转发进同一增量端口
    onChanged: (listener) => {
      const offUpdated = bridge.meetings.onUpdated((meeting) => listener({ kind: 'upsert', item: meeting }))
      const offDeleted = bridge.meetings.onDeleted((id) => listener({ kind: 'remove', id }))
      return () => { offUpdated(); offDeleted() }
    }
  }), [])
  const lifecycle = useMemo<DeltaCatalogLifecycle>(() => ({
    onReadSuccess: () => { setReady(true); setError(null) },
    onReadFailure: (cause) => { setError(cause instanceof Error ? cause.message : String(cause)) }
  }), [])
  const { items: meetings, refresh } = useDeltaCatalog<Meeting>(
    (meeting) => meeting.id,
    (first, second) => second.updatedAt - first.updatedAt,
    sources,
    lifecycle
  )
  return { meetings, ready, error, refresh }
}
