import { usePermissions } from '../../src/renderer/src/hooks/usePermissions'
import { PermissionPrompt } from '../../src/renderer/src/components/task/PermissionPrompt'

export function PermissionHarness({ taskId }: { taskId: string }) {
  const state = usePermissions(taskId)
  return <div>
    {state.permission && <PermissionPrompt key={state.permission.requestToken ?? state.permission.requestId} permission={state.permission} busy={state.permissionBusy} onAnswer={(choice) => void state.answerPermission(choice)} />}
    {state.permissionError && <div role="alert" data-error>{state.permissionError}</div>}
    {state.permissionNotice && <div role="status" data-notice>{state.permissionNotice}</div>}
  </div>
}
