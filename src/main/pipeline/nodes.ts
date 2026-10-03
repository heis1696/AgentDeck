// 标准执行节点库：端口驱动的可复用节点类。
//
// 节点类不含业务细节——启动竞态/回合执行/终态收尾的具体动作由端口（ports）注入，
// 同一套节点类因此能被不同 issue 管线复用：普通任务、会议成员、硬切后继绑不同端口、
// 拼不同节点表（数组即组合单位，需要插入机制节点就在表中间加）。
import type { FlowContext, FlowNode, FlowState } from './flow'

export interface ExecutionPorts<S extends FlowState = FlowState> {
  /** 启动竞态：后端 start + 身份栅栏绑定 + 会话安装（StartNode） */
  start?(ctx: FlowContext<S>): Promise<void>
  /** 回合执行：await 到回合终态（含看门狗竞速，RunningNode） */
  runTurn?(ctx: FlowContext<S>): Promise<void>
  /** 终态收尾：结果落库/委派循环/通知（FinalizeNode） */
  finalize?(ctx: FlowContext<S>): Promise<void>
}

/** 启动节点：后端会话建立与安装 */
export class StartNode<S extends FlowState = FlowState> implements FlowNode<S> {
  readonly id = 'start'
  constructor(private readonly ports: ExecutionPorts<S>) {}
  enter(ctx: FlowContext<S>): Promise<void> | void {
    return this.ports.start?.(ctx)
  }
}

/** 运行节点：单回合执行至终态 */
export class RunningNode<S extends FlowState = FlowState> implements FlowNode<S> {
  readonly id = 'running'
  constructor(private readonly ports: ExecutionPorts<S>) {}
  enter(ctx: FlowContext<S>): Promise<void> | void {
    return this.ports.runTurn?.(ctx)
  }
}

/** 收尾节点：终态处理与结果发布 */
export class FinalizeNode<S extends FlowState = FlowState> implements FlowNode<S> {
  readonly id = 'finalize'
  constructor(private readonly ports: ExecutionPorts<S>) {}
  enter(ctx: FlowContext<S>): Promise<void> | void {
    return this.ports.finalize?.(ctx)
  }
}

/** 标准节点表工厂：[start, running, finalize]（缺省端口自动跳过） */
export function standardFlow<S extends FlowState = FlowState>(ports: ExecutionPorts<S>): ReadonlyArray<FlowNode<S>> {
  return [new StartNode<S>(ports), new RunningNode<S>(ports), new FinalizeNode<S>(ports)]
}
