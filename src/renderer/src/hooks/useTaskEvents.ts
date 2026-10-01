import { useCallback, useEffect, useRef, useState } from 'react'
import { bridge } from '../api'
import type { TaskEvent } from '../../../shared/types'
import { TaskEventsController, type TaskEventsSource } from './taskEventsController'
import { usePermissions } from './usePermissions'

export { mergeTaskEvents } from './eventMerge'

const taskEventsSource: TaskEventsSource = {
  readSnapshot: (taskId) => bridge.tasks.events(taskId, 0),
  onEvent: (callback) => bridge.tasks.onEvent(callback),
  onEventsInvalidated: (callback) => bridge.tasks.onEventsInvalidated(callback),
  onSidecarStatus: (callback) => bridge.sidecar.onStatus((snapshot) => callback(snapshot.status))
}

export function useTaskEvents(taskId: string) {
  const [events, setEvents] = useState<TaskEvent[]>([])
  const permissions = usePermissions(taskId)
  const [scope, setScope] = useState(taskId)
  if (scope !== taskId) {
    setScope(taskId)
    setEvents([])
  }

  const taskIdRef = useRef(taskId)
  taskIdRef.current = taskId
  const controllerRef = useRef<TaskEventsController | null>(null)
  const refreshEvents = useCallback(() => {
    const controller = controllerRef.current
    if (!controller || controller.taskId !== taskIdRef.current) return Promise.resolve([])
    return controller.refresh()
  }, [])

  useEffect(() => {
    const controller = new TaskEventsController(taskId, taskEventsSource, (next) => {
      if (taskIdRef.current === taskId) setEvents(next)
    })
    controllerRef.current = controller
    void controller.refresh().catch(() => {})
    return () => {
      controller.dispose()
      if (controllerRef.current === controller) controllerRef.current = null
    }
  }, [taskId])

  return { events, refreshEvents, ...permissions }
}
