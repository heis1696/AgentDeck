// AgentBackend：执行后端适配器接口。
// 新增后端（claude / codex …）时实现此接口并在 registry 注册即可。
import type { TaskEvent, ThinkingLevel } from '../../shared/types'
import type { PermissionRequest } from '../../shared/contracts'
export type { PermissionRequest } from '../../shared/contracts'

/**
 * 一个回合（一次 prompt → 完整回复）的不可变身份。
 *
 * 适配器在 `start` / `send` 收到它之后，必须把它**原样回传**给它产生的每一个回调
 * （见 `bindTurn`）。运行器只按 `id` 严格关联，绝不把"最近开始的回合"当成回调的归属：
 * 携带未知 / 已回收 `id` 的回调一律丢弃。旧回合的迟到终态、事件、sessionId、权限
 * 与心跳因此无法裁决、污染或续命新回合。
 */
export interface BackendTurnStamp {
  /** 会话内单调递增的回合序号（从 1 开始），仅用于日志与断言。 */
  readonly seq: number
  /** 唯一且永不复用的关联 id：协议自带回合标识时由适配器据它生成，否则由运行器生成。 */
  readonly id: string
}

export interface BackendSessionEvents {
  onEvent: (e: Omit<TaskEvent, 'seq'>, turn?: BackendTurnStamp) => void
  /**
   * 线级进展信号：连接上有任何消息（含未映射成事件的思考增量/遥测/资源采样）即回调。
   * 供上层空转看门狗续命——模型长时间思考、子代理在后台跑等"静默但仍在工作"的
   * 阶段不该被误判超时。不落日志、不推 UI。
   */
  onHeartbeat?: (turn?: BackendTurnStamp) => void
  /** 回合结束（一轮 prompt → 完整回复） */
  onTurnEnd: (result: BackendTurnResult, turn?: BackendTurnStamp) => void
  /** 权限确认；返回所选 optionId；未提供时自动放行 */
  onPermission?: (req: PermissionRequest, turn?: BackendTurnStamp) => Promise<{ optionId?: string; decision: 'allow' | 'deny' }>
  /** 进程/会话启动即回调（一次性 CLI 在 start resolve 前就要能被取消）；属于会话，不属于某个回合 */
  onLaunch?: (handle: { stop: () => void | Promise<unknown> }) => void
  /** Persist a provider session id as soon as it is known, including failed turns. */
  onSessionId?: (sessionId: string, turn?: BackendTurnStamp) => void
}

/**
 * 把一个会话事件通道绑定到某一个回合：所有回调都补上同一个不可变身份。
 * 适配器只需在 `start` / `send` 入口调用一次；未提供 turn 时原样返回（旧后端零成本）。
 */
export function bindTurn(events: BackendSessionEvents, turn?: BackendTurnStamp): BackendSessionEvents {
  if (!turn) return events
  return {
    onEvent: (e) => events.onEvent(e, turn),
    onHeartbeat: events.onHeartbeat ? () => events.onHeartbeat?.(turn) : undefined,
    onTurnEnd: (r) => events.onTurnEnd(r, turn),
    onPermission: events.onPermission ? (req) => events.onPermission?.(req, turn) ?? Promise.resolve({ decision: 'deny' as const }) : undefined,
    onLaunch: events.onLaunch,
    onSessionId: events.onSessionId ? (sessionId) => events.onSessionId?.(sessionId, turn) : undefined
  }
}

/** One complete model turn. delegationText may contain assistant messages emitted before the final one. */
export interface BackendTurnResult {
  response: string
  ok: boolean
  error?: string
  tokenCount?: number
  durationMs?: number
  delegationText?: string
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
    /** agent 钉死的模型覆盖（形如 glm-5.2 或 providerId/modelId）；空 = 平台默认 */
    model?: string
    /** 思考强度档位（空 = 平台默认）：zcode 选 variant/预设档，claude 注入 MAX_THINKING_TOKENS，codex 拼 model_reasoning_effort，dsh 走 ACP env；opencode 不支持 */
    thinking?: ThinkingLevel
    /** API 预设连接覆盖（与 model 同时提供时生效）：baseURL/apiKey 注册进会话配置，不写死全局 */
    connection?: { name: string; baseURL: string; apiKey: string; protocol?: 'anthropic' | 'openai' }
    resumeSessionId?: string
    /** 首回合身份：适配器必须把它回传给该回合产生的每个回调 */
    turn?: BackendTurnStamp
    events: BackendSessionEvents
  }) => Promise<BackendSession>
}

export interface BackendSession {
  sessionId: string
  /**
   * 声明本会话会把 `start` / `send` 收到的回合身份回传到每个回调。
   *
   * 只有声明的会话才允许在同一连接上连续跑多个回合。未声明的会话只承载
   * 一个隔离回合；后续关掉本地传输并按 sessionId 重建——没有可靠标识就不复用。
   */
  turnScoped?: boolean
  /** 发送后续消息（续聊）；回合结束经由 onTurnEnd 通知 */
  send: (content: string, turn?: BackendTurnStamp) => Promise<void>
  /** 中止当前回合 */
  stop: () => Promise<void>
  /** Disconnect local transport while preserving a resumable provider session. */
  detach?: () => Promise<void>
  /** 关闭会话并释放进程 */
  close: () => Promise<void>
}
