// 事件批台账（批次 3a）：pending provider batches 的登记 / drain / 作废唯一所有者。
// 设计与迁移归属见 docs/plan/runner-decomposition.md §5.1/§6.3；TaskRunner 保留
// closeEventBatches/disposeEventBatches 门面与 makeTurnEvents 的批装配（3b 外移），
// 每回合的 BoundedEventBatcher 组装后经 register 登记，终态/取消/关机边界经 close
// （drain 提交）或 dispose（不提交直接作废）收口。
import { BoundedEventBatcher } from '../event-batcher'

/**
 * 事件批泵：批 → taskId 台账的唯一所有者（批次 3a 外移自 runner.ts 的 eventBatchers）。
 * 泛型参数是批内事件类型——runner 的 RunnerEvent 是模块内类型且 execution/* 严禁
 * 反向 import runner.ts（§5.2），故以泛型注入。
 * 不接收 runner/store/内核任何引用：批的生命周期操作只落在自己拥有的台账上（窄端口约束）。
 */
export class EventPump<T> {
  /** 活跃批 → 所属 taskId。只读引用仅供 runner 的 smoke 冻结面 getter 转发
   *  （smoke-event-pipeline / smoke-hot-transaction 直读 runner.eventBatchers）；
   *  runner 内部代码不得经此读写，一律走下面的窄方法。 */
  readonly batches = new Map<BoundedEventBatcher<T>, string>()

  /** 回合批组装完成后登记归属（makeTurnEvents；3b 随事件工厂外移后经端口调用） */
  register(batcher: BoundedEventBatcher<T>, taskId: string): void {
    this.batches.set(batcher, taskId)
  }

  /** 仅摘台账登记：批已成功 close（持久提交完成），无需 dispose */
  forget(batcher: BoundedEventBatcher<T>): void {
    this.batches.delete(batcher)
  }

  /** 作废一条批：dispose + 摘台账（批溢出/终态未获接受时的单批收口） */
  revoke(batcher: BoundedEventBatcher<T>): void {
    batcher.dispose()
    this.batches.delete(batcher)
  }

  /**
   * drain：把命中 taskId（缺省全部）的批提交到事件日志，close 失败的批作废；
   * 返回是否全部提交成功。
   * 时序锚点（I2.2）：取消路径在 claim 仍有效时先 drain 再落 cancelled 终态——
   * 缓冲数据要在身份仍有效时提交。本方法不感知身份，该顺序由 runner 编排保持。
   */
  async close(taskId?: string, timeoutMs = 5_000): Promise<boolean> {
    const selected = [...this.batches].filter(([, owner]) => taskId === undefined || owner === taskId)
    const committed = await Promise.all(selected.map(async ([batcher]) => {
      const ok = await batcher.close(timeoutMs)
      if (!ok) batcher.dispose()
      this.batches.delete(batcher)
      return ok
    }))
    return committed.every(Boolean)
  }

  /** 不提交直接作废：命中 taskId（缺省全部）的批全部 dispose 并摘台账（forget / shutdown 收尾） */
  dispose(taskId?: string): void {
    for (const [batcher, owner] of this.batches) {
      if (taskId !== undefined && owner !== taskId) continue
      batcher.dispose()
      this.batches.delete(batcher)
    }
  }

  /** 在途批数量（pipeline 在途账只读源） */
  get size(): number {
    return this.batches.size
  }
}
