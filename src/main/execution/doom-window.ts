// doom 窗（批次 5）：连续同名同参工具调用的一次性人工审批守卫——toolWindows 在途窗与
// doomRequestSeq 的唯一所有者，observeToolCall 编排随迁。
// 设计与迁移归属见 docs/plan/runner-decomposition.md §5.1/§6.5；依赖（权限应答、当前运行
// 判定、事件落盘）经窄端口注入，绝不反向依赖 runner（§5.2）。I6.3：任务级清扫的 doom 半部
// 经 forget/clear 窄方法收口，与 permissionBroker.cancelTask 成对出现（cancel/forget/释放/
// 终止四个清扫位同经 purgeTaskWorkflowState 单点）。
import type { Task, TaskEvent } from '../../shared/types'
import type { TaskExpectation } from '../store'
import type { PermissionRequest } from '../backends/types'
import { runCondition, type RunClaim } from './identity'

/**
 * doom 窗端口：每个端口都是单个动作，不暴露任何 Map（窄端口注入，非「Context 袋」，§4.2）。
 * execution/* → runner.ts 反向 import 严禁；需要回调一律经此注入（§5.2）。
 */
export interface DoomWindowPorts {
  /** goalId 判定（doom-loop 是 Goal 模式守卫，普通任务保留既有权限行为，不被 Goal 策略暂停） */
  taskOf(taskId: string): Task | undefined
  /** 拒绝应答落库后核对持久身份，仍是当前运行才停会话 */
  matches(taskId: string, expected: TaskExpectation): boolean
  /** 阈值来源（runner：opts().doomLoopThreshold；缺省 3 在本模块兜底） */
  doomLoopThreshold(): number | undefined
  /** doom 状态事件落盘（身份条件写，落空即放弃） */
  appendEvent(taskId: string, event: Omit<TaskEvent, 'seq'>, expected: TaskExpectation): TaskEvent | null
  pushEvent(taskId: string, event: TaskEvent): void
  /** 一次性人工审批（runner：askPermission——workVersion 绑定由 broker 面收口，I6.1） */
  askPermission(taskId: string, request: PermissionRequest): Promise<{ optionId?: string; decision: 'allow' | 'deny' }>
  /** I6.2：应答回调必须核对 claim——新 Run 的窗不被旧应答清除或写入 */
  isCurrentRun(claim: RunClaim | undefined): claim is RunClaim
  /** 拒绝后停当前回合（runner：kernel.sessionOf(taskId)?.stop()） */
  stopSession(taskId: string): void | Promise<unknown>
}

export class DoomWindow {
  private readonly ports: DoomWindowPorts
  /** Consecutive tool-call signatures used by the doom-loop approval guard. */
  private windows = new Map<string, { key: string; count: number; requested: boolean }>()
  private requestSeq = 0

  constructor(ports: DoomWindowPorts) {
    this.ports = ports
  }

  /** Convert backend tool events into an auditable, one-shot doom-loop approval. */
  observeToolCall(taskId: string, event: Omit<TaskEvent, 'seq'>, claim: RunClaim) {
    // Doom-loop is a Goal-mode guard. Ordinary Tasks retain their existing
    // permission behavior and must not be paused by Goal policy.
    if (!this.ports.taskOf(taskId)?.goalId) return
    const data = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : {}
    if (data.phase !== 'started') return
    let args = data.args ?? data.input ?? ''
    if (typeof args !== 'string') {
      try { args = JSON.stringify(args) } catch { args = String(args) }
    }
    const key = `${event.text ?? ''}:${args}`
    const previous = this.windows.get(taskId)
    const state = previous?.key === key ? previous : { key, count: 0, requested: false }
    state.count += 1
    this.windows.set(taskId, state)
    if (state.count !== (this.ports.doomLoopThreshold() ?? 3) || state.requested) return
    state.requested = true
    const requestId = `doom_${taskId}_${++this.requestSeq}`
    const reason = `检测到同名同参工具连续调用 ${state.count} 次，疑似 doom-loop；需要人工确认是否继续。`
    const full = this.ports.appendEvent(taskId, {
      ts: Date.now(),
      kind: 'status',
      text: `doom-loop: ${reason}`,
      data: { stopReason: 'doom_loop', toolName: event.text ?? '', args }
    }, runCondition(claim))
    if (!full) return
    this.ports.pushEvent(taskId, full)
    const request: PermissionRequest = {
      requestId,
      toolName: String(event.text ?? ''),
      reason,
      riskLevel: 'high',
      input: args,
      options: [
        { optionId: 'allow', name: '允许继续', response: { decision: 'allow' } },
        { optionId: 'deny', name: '停止回合', response: { decision: 'deny' } }
      ]
    }
    void this.ports.askPermission(taskId, request).then((decision) => {
      // The answer belongs to the Run that asked for it. While the prompt was
      // pending a newer Run may have installed its own doom-loop window; a
      // stale answer must neither clear that window nor write into it.
      if (!this.ports.isCurrentRun(claim)) return
      if (decision.decision === 'allow') {
        this.windows.delete(taskId)
        const allowed = this.ports.appendEvent(taskId, { ts: Date.now(), kind: 'status', text: 'doom-loop: 人工审批通过，继续执行', data: { stopReason: 'doom_loop_approved' } }, runCondition(claim))
        if (allowed) this.ports.pushEvent(taskId, allowed)
        return
      }
      const denied = this.ports.appendEvent(taskId, { ts: Date.now(), kind: 'status', text: 'doom-loop: 未获人工审批，停止当前回合', data: { stopReason: 'doom_loop_denied' } }, runCondition(claim))
      if (denied) this.ports.pushEvent(taskId, denied)
      if (!this.ports.matches(taskId, runCondition(claim))) return
      void Promise.resolve(this.ports.stopSession(taskId)).catch(() => {})
    }).catch(() => {})
  }

  /** 任务级清扫窄方法（I6.3 的 doom 半部）：与 permissionBroker.cancelTask(taskId) 成对
   *  出现在 cancel/forget/释放/终止四个清扫位（同经 purgeTaskWorkflowState 单点回调），
   *  以及新 Run 启动复位（run/followUp 的 beginRun）。 */
  forget(taskId: string): void {
    this.windows.delete(taskId)
  }

  /** 进程级清扫（shutdown）：全窗清空 */
  clear(): void {
    this.windows.clear()
  }
}
