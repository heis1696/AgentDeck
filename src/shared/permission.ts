import type { PermissionRequest } from './contracts'

export type PermissionDecision = 'allow' | 'deny'
export type PermissionChoice = { optionId: string; decision: PermissionDecision; label: string; description?: string }
export const DENY_PERMISSION_OPTION = '__agentdeck_deny__'

export function permissionKey(request: PermissionRequest): string {
  return `${request.requestId}:${request.requestToken ?? `${request.requestedAt ?? ''}:${request.workVersion ?? ''}`}`
}

export function permissionDecision(value: string): PermissionDecision | null {
  if (value === 'allow' || value === 'once' || value === 'always') return 'allow'
  if (value === 'deny' || value === 'reject') return 'deny'
  return null
}

export function permissionChoices(request: PermissionRequest): PermissionChoice[] {
  const choices = request.options.flatMap((option) => {
    const decision = permissionDecision(option.response.decision)
    return decision && option.optionId.trim() ? [{ optionId: option.optionId, decision, label: option.name || (decision === 'allow' ? '允许' : '拒绝'), description: option.description }] : []
  })
  if (!choices.some((choice) => choice.decision === 'deny')) {
    choices.push({ optionId: DENY_PERMISSION_OPTION, decision: 'deny', label: '拒绝', description: undefined })
  }
  return choices
}
