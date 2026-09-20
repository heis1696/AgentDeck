import { useCallback, useEffect, useRef } from 'react'
import type { PermissionRequest } from '../../../shared/contracts'
import { permissionChoices, permissionKey, type PermissionChoice } from '../../../shared/permission'
import { bridge } from '../api'
import { useTaskScopedState } from './taskDrafts'

type State = { requests: PermissionRequest[]; answering: string | null; error: string | null; loadError: string | null; notice: string | null }
const describe = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)

export function usePermissions(taskId: string) {
  const [state, setState] = useTaskScopedState<State>(taskId, () => ({ requests: [], answering: null, error: null, loadError: null, notice: null }))
  const readSequence = useRef(0)
  const inFlight = useRef(new Set<string>())
  const permission = state.requests[0] ?? null
  const refreshPermissions = useCallback(async () => {
    if (!bridge.tasks.pendingPermissions) return
    const sequence = ++readSequence.current
    try {
      const requests = await bridge.tasks.pendingPermissions(taskId)
      if (!Array.isArray(requests)) throw new Error('待审批快照格式无效')
      const active = requests.filter((request) => !request.resolution)
      if (sequence === readSequence.current) setState((current) => ({ ...current, requests: active, loadError: null }))
    } catch (cause) {
      if (sequence === readSequence.current) setState((current) => ({ ...current, loadError: `读取待审批请求失败：${describe(cause)}` }))
    }
  }, [taskId, setState])

  useEffect(() => {
    const off = bridge.tasks.onPermission((id, request) => {
      if (id !== taskId) return
      ++readSequence.current
      setState((current) => {
        const key = permissionKey(request)
        const requests = request.resolution
          ? current.requests.filter((item) => permissionKey(item) !== key)
          : [...current.requests.filter((item) => String(item.requestId) !== String(request.requestId)), request]
        const notice = request.resolution === 'expired' ? '权限请求已超时并拒绝。'
          : request.resolution === 'cancelled' || request.resolution === 'invalidated' ? '权限请求已失效。' : null
        return { ...current, requests, error: null, notice }
      })
      void refreshPermissions()
    })
    const offSidecar = bridge.sidecar.onStatus((snapshot) => { if (snapshot.status === 'ready') void refreshPermissions() })
    void refreshPermissions()
    return () => { ++readSequence.current; off(); offSidecar() }
  }, [taskId, setState, refreshPermissions])

  const answerPermission = async (choice: PermissionChoice) => {
    if (!permission) return
    const request = permission
    const key = permissionKey(request)
    const flightKey = `${taskId}:${key}`
    if (inFlight.current.has(flightKey)) return
    if (!permissionChoices(request).some((item) => item.optionId === choice.optionId && item.decision === choice.decision)) return
    if (request.expiresAt !== undefined && request.expiresAt <= Date.now()) { await refreshPermissions(); return }
    inFlight.current.add(flightKey)
    setState((current) => ({ ...current, answering: key, error: null, notice: null }))
    try {
      const result = await bridge.tasks.respondPermission(request.requestId, choice.optionId, choice.decision, request.requestToken)
      if (!result.ok) {
        setState((current) => ({ ...current, error: result.error ?? '权限回复失败，请重试。' }))
        await refreshPermissions()
      } else {
        setState((current) => ({ ...current, requests: current.requests.filter((item) => permissionKey(item) !== key) }))
      }
    } catch (cause) {
      setState((current) => ({ ...current, error: `权限回复失败：${describe(cause)}` }))
    } finally {
      inFlight.current.delete(flightKey)
      setState((current) => ({ ...current, answering: current.answering === key ? null : current.answering }))
    }
  }

  return { permission, permissionCount: state.requests.length, permissionBusy: !!permission && state.answering === permissionKey(permission), permissionError: state.error ?? state.loadError, permissionNotice: state.notice, refreshPermissions, answerPermission }
}
