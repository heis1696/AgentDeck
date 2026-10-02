import { useCallback, useEffect, useRef, useState } from 'react'
import type { Meeting } from '../../../shared/meeting'
import { bridge, meetingPublicApi } from '../api'
import { emptyMeetingTurns, MeetingTurnsController, type MeetingTurnsSnapshot } from './meetingTurnsController'

export function useMeetingTurns(meeting: Meeting) {
  const [entry, setEntry] = useState<{ id: string; snapshot: MeetingTurnsSnapshot }>(() => ({ id: meeting.id, snapshot: emptyMeetingTurns() }))
  const controllerRef = useRef<MeetingTurnsController | null>(null)
  const currentId = useRef(meeting.id)
  currentId.current = meeting.id
  useEffect(() => {
    const id = meeting.id
    const controller = new MeetingTurnsController(id, meetingPublicApi, (snapshot) => {
      if (currentId.current === id) setEntry({ id, snapshot })
    })
    controllerRef.current = controller
    let observedVersion = meeting.turnVersion
    const off = bridge.meetings.onUpdated((updated) => {
      if (updated.id !== id) return
      if (updated.turnVersion === undefined || updated.turnVersion !== observedVersion) {
        observedVersion = updated.turnVersion
        void controller.refresh()
      }
    })
    void controller.refresh()
    return () => { off(); controller.dispose(); if (controllerRef.current === controller) controllerRef.current = null }
  }, [meeting.id])
  useEffect(() => {
    if (controllerRef.current?.meetingId === meeting.id) void controllerRef.current.refresh()
  }, [meeting.id, meeting.turnVersion])
  const refresh = useCallback(() => controllerRef.current?.meetingId === currentId.current ? controllerRef.current.refresh() : Promise.resolve(emptyMeetingTurns()), [])
  return { ...(entry.id === meeting.id ? entry.snapshot : emptyMeetingTurns()), refresh }
}
