import { useCallback, useSyncExternalStore } from 'react'

export interface MeetingSelection {
  agentId: string
  turnId: string | null
  follow: boolean
}

const selections = new Map<string, MeetingSelection>()
const listeners = new Set<() => void>()

export function readMeetingSelection(meetingId: string): MeetingSelection | null { return selections.get(meetingId) ?? null }

export function writeMeetingSelection(meetingId: string, selection: MeetingSelection | null): void {
  if (selection) selections.set(meetingId, selection)
  else selections.delete(meetingId)
  for (const listener of listeners) listener()
}

export function useMeetingSelection(meetingId: string) {
  const subscribe = useCallback((listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }, [])
  const getSnapshot = useCallback(() => readMeetingSelection(meetingId), [meetingId])
  const selection = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const setSelection = useCallback((next: MeetingSelection | null) => writeMeetingSelection(meetingId, next), [meetingId])
  return [selection, setSelection] as const
}
