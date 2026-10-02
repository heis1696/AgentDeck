import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Meeting } from '../../../shared/meeting'
import { bridge } from '../api'
import { createDeltaList, type DeltaList } from '../data-store'

export function useMeetings() {
  const storeRef = useRef<DeltaList<Meeting> | null>(null)
  if (!storeRef.current) storeRef.current = createDeltaList((meeting: Meeting) => meeting.id, (first, second) => second.updatedAt - first.updatedAt)
  const store = storeRef.current
  const meetings = useSyncExternalStore(store.subscribe, store.get)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestRef = useRef(0)
  const refresh = useCallback(async () => {
    const request = ++requestRef.current
    try {
      const result = await store.read(() => bridge.meetings.list())
      if (result && request === requestRef.current) { setReady(true); setError(null) }
      return result
    } catch (cause) {
      if (request === requestRef.current) setError(cause instanceof Error ? cause.message : String(cause))
      return null
    }
  }, [store])
  useEffect(() => {
    const offUpdated = bridge.meetings.onUpdated((meeting) => store.upsert(meeting))
    const offDeleted = bridge.meetings.onDeleted((id) => store.remove(id))
    void refresh()
    return () => { offUpdated(); offDeleted(); store.invalidateReads(); ++requestRef.current }
  }, [refresh, store])
  return { meetings, ready, error, refresh }
}
