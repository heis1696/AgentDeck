// AgentBackend：执行后端适配器接口。
// 新增后端（claude / codex …）时实现此接口并在 registry 注册即可。
import type { TaskEvent } from '../../shared/types'

export interface PermissionRequest {
  requestId: string | number
  toolName: string
  reason: string
  riskLevel: string
  input?: unknown
  /** 服务端预构建的选项，每个带 optionId 与 response */
  options: Array<{ optionId: string; name: string; description?: string; response: { decision: string } }>
}

export interface BackendSessionEvents {
  onEvent: (e: Omit<TaskEvent, 'seq'>) => void
  /** 回合结束（一轮 prompt → 完整回复） */
  onTurnEnd: (result: { response: string; ok: boolean; error?: string; tokenCount?: number; durationMs?: number }) => void
  /** 权限确认；返回所选 optionId；未提供时自动放行 */
  onPermission?: (req: PermissionRequest) => Promise<{ optionId?: string; decision: 'allow' | 'deny' }>
  /** 进程/会话启动即回调（一次性 CLI 在 start resolve 前就要能被取消） */
  onLaunch?: (handle: { stop: () => void }) => void
}

export interface AgentBackend {
  id: string
  label: string
  /** 探测本机是否可用（找二进制/配置） */
  probe: () => Promise<{ ok: boolean; detail: string }>
  /**
   * 启动一个执行会话并派发首条提示词。
   * resumeSessionId 提供时走 session/resume（重启后续聊），否则新建会话。
   * 返回一个控制器；resolve 前会话已创建完成（或失败）。
   */
  start: (opts: {
    prompt: string
    workdir: string
    mode: string
    resumeSessionId?: string
    events: BackendSessionEvents
  }) => Promise<BackendSession>
}

export interface BackendSession {
  sessionId: string
  /** 发送后续消息（续聊）；回合结束经由 onTurnEnd 通知 */
  send: (content: string) => Promise<void>
  /** 中止当前回合 */
  stop: () => Promise<void>
  /** 关闭会话并释放进程 */
  close: () => Promise<void>
}
