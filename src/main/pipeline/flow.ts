// 执行流 node 化：Issue 管线的执行层（裁决层见 issue-pipeline.ts，分层见 ARCHITECTURE §13）。
//
// 分工：IssuePipeline 裁决「状态/准入/在途/终点」；FlowEngine 负责「一次执行怎么跑」。
// 实际运行抽象为 FlowNode（StartNode / RunningNode / FinalizeNode……）：
// - 复用：节点类是无状态类、按流实例化，不同 issue 管线绑不同端口拼不同节点表
//   （普通任务、会议成员、硬切后继共用同一套节点类，差异全在端口绑定与节点表组合）；
// - 独立：每条流有自己的 state 袋与在途键（`${taskId}:node:${id}`），流间零共享可变状态；
// - 并发：引擎原生并发——多条流同时在 active 表，唯一共享（管线在途账本）按键隔离。
//
// 结构性防泄漏：节点进入即在途账 begin，退出（含抛错路径）必 end——「finally 忘写」
// 类缺陷（launchHandles 漏清曾把热更门堵死）在节点框架里没有生存位。

/** 流内状态袋：节点间传递；流间隔离（同一批节点实例可被多条流并发复用） */
export interface FlowState {
  [key: string]: unknown
}

export interface FlowContext<S extends FlowState = FlowState> {
  flowId: string
  taskId: string
  state: S
  /** 已执行到的最后一个节点（activeFlows 可观测） */
  stoppedAt?: string
  /** 协作中断：引擎在节点边界停止；在跑节点可检查此标记提前让出 */
  interrupted?: { reason: string }
  error?: unknown
}

export interface FlowNode<S extends FlowState = FlowState> {
  id: string
  /** 进入节点执行；抛错则流终止（exit 仍会执行，在途账仍会清） */
  enter(ctx: FlowContext<S>): Promise<void> | void
  /** 离开节点（enter 抛错也走）：清理钩子位 */
  exit?(ctx: FlowContext<S>, error?: unknown): Promise<void> | void
}

/** 流级收尾端口：无论成败最后执行（对应 run() 的外层 finally 语义） */
export type FlowEndPort<S extends FlowState = FlowState> = (ctx: FlowContext<S>, error?: unknown) => void | Promise<void>

export interface FlowResult {
  ok: boolean
  interrupted: boolean
  error?: string
  failedNode?: string
  stoppedAt?: string
}

export class FlowEngine {
  private static seq = 0
  private active = new Map<string, FlowContext>()

  /** 依赖 Issue 管线的在途账本做节点级记账（begin/end） */
  constructor(private readonly begin: (key: string) => void, private readonly end: (key: string) => boolean) {}

  /** 在途流快照：并发可观测（谁在跑、跑到哪个节点） */
  activeFlows(): ReadonlyArray<{ flowId: string; taskId: string; stoppedAt?: string }> {
    return [...this.active.values()].map((ctx) => ({ flowId: ctx.flowId, taskId: ctx.taskId, stoppedAt: ctx.stoppedAt }))
  }

  /** 协作中断：置因后引擎在节点边界停止，不再进入后续节点 */
  interrupt(flowId: string, reason: string): boolean {
    const ctx = this.active.get(flowId)
    if (!ctx) return false
    ctx.interrupted = { reason }
    return true
  }

  /**
   * 顺序执行节点表。每节点：在途账 begin → enter → exit（enter 抛错也走）→ 在途账 end。
   * enter/exit 的错误都归入流结果；exit 抛错不吞 enter 的错。interrupted 只在节点间生效。
   */
  async run<S extends FlowState>(
    taskId: string,
    nodes: readonly FlowNode<S>[],
    state: S,
    options: { flowId?: string; onFlowEnd?: FlowEndPort<S> } = {}
  ): Promise<FlowResult> {
    const flowId = options.flowId ?? `${taskId}:flow:${++FlowEngine.seq}`
    const ctx: FlowContext<S> = { flowId, taskId, state }
    this.active.set(flowId, ctx)
    let failedNode: string | undefined
    try {
      for (const node of nodes) {
        if (ctx.interrupted) break
        ctx.stoppedAt = node.id
        const key = `${taskId}:node:${node.id}`
        this.begin(key)
        let nodeError: unknown
        try {
          await node.enter(ctx)
        } catch (error) {
          nodeError = error
        }
        try {
          await node.exit?.(ctx, nodeError)
        } catch (exitError) {
          if (nodeError === undefined) nodeError = exitError
        } finally {
          this.end(key)
        }
        if (nodeError !== undefined) {
          ctx.error = nodeError
          failedNode = node.id
          break
        }
      }
      const error = ctx.error
      return {
        ok: error === undefined && !ctx.interrupted,
        interrupted: !!ctx.interrupted,
        ...(error !== undefined ? { error: error instanceof Error ? error.message : String(error) } : {}),
        ...(failedNode ? { failedNode } : {}),
        stoppedAt: ctx.stoppedAt
      }
    } finally {
      this.active.delete(flowId)
      await options.onFlowEnd?.(ctx, ctx.error)
    }
  }
}
