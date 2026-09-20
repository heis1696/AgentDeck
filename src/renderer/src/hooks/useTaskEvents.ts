import { useCallback, useEffect, useRef, useState } from 'react'
import { bridge } from '../api'
import type { PermissionRequest } from '../../../shared/contracts'
import type { TaskEvent } from '../../../shared/types'
import { mergeTaskEvents } from './eventMerge'

export { mergeTaskEvents } from './eventMerge'

export function useTaskEvents(taskId: string) {
  const [events, setEvents] = useState<TaskEvent[]>([])
  const [permission, setPermission] = useState<PermissionRequest | null>(null)
  // 任务隔离：TaskDetail 是同一个实例在任务之间复用，events 又是**跨 await 落地**的。
  // 没有这段结算，切到任务 B 的那一帧会先用 A 的事件（与 B 的 prompt 一起喂给 turnModel）
  // 渲染出 A 的对话，直到 B 的快照回来才被换掉。这里在渲染期直接清空：
  // 任务已变 → 本帧就是空快照（快照请求本身另有 requestRef 序号判废，迟到的旧响应不会落地）。
  const [scope, setScope] = useState(taskId)
  if (scope !== taskId) {
    setScope(taskId)
    setEvents([])
    setPermission(null)
  }
  const mountedRef = useRef(false)
  const requestRef = useRef(0)
  const loadingRef = useRef(0)
  const pendingRef = useRef<TaskEvent[]>([])
  const refresh = useCallback(async () => {
    const request = ++requestRef.current
    loadingRef.current = request
    pendingRef.current = []
    const next = await bridge.tasks.events(taskId, 0)
    if (!mountedRef.current || request !== requestRef.current) return next
    const pending = pendingRef.current
    loadingRef.current = 0
    pendingRef.current = []
    // The full snapshot is authoritative after rewind; retain live events received during loading.
    setEvents(mergeTaskEvents(next, pending))
    return next
  }, [taskId])

  useEffect(() => {
    mountedRef.current = true
    setPermission(null)
    void refresh()
    const offEvent = bridge.tasks.onEvent((id, event) => {
      if (id !== taskId) return
      if (loadingRef.current) pendingRef.current.push(event)
      setEvents((current) => {
        return mergeTaskEvents(current, [event])
      })
    })
    const offInvalidated = bridge.tasks.onEventsInvalidated((id) => {
      if (id === taskId) void refresh()
    })
    const offPermission = bridge.tasks.onPermission((id, request) => {
      if (id === taskId) setPermission(request)
    })
    // A sidecar reconnect is an authoritative boundary: replay the durable
    // snapshot before accepting the next live event, retaining any event
    // delivered while the read is in flight.
    const offSidecar = bridge.sidecar.onStatus((snapshot) => {
      if (snapshot.status === 'ready') void refresh()
    })
    return () => {
      mountedRef.current = false
      ++requestRef.current
      loadingRef.current = 0
      pendingRef.current = []
      offEvent()
      offInvalidated()
      offPermission()
      offSidecar()
    }
  }, [refresh, taskId])

  const answerPermission = useCallback(async (decision: 'allow' | 'deny') => {
    if (!permission) return
    const request = permission
    setPermission(null)
    const option = request.options.find((item) => item.response.decision === decision) ?? request.options[0]
    if (option) await bridge.tasks.respondPermission(request.requestId, option.optionId, decision)
  }, [permission])

  return { events, permission, refreshEvents: refresh, answerPermission }
}
