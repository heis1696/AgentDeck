/** 渲染层数据增量更新辅助：广播自带完整对象时直接落位，快照读取只在首次装载与显式刷新发生。
 *  四条铁律：
 *  1. 读取期间到达的广播先进缓冲，快照落地后按到达序重放——旧快照永远盖不掉新广播；
 *  2. 读取失败时缓冲的广播直接落位——读挂了也不能丢读期间的事件；
 *  3. 读用单调序号「最新读获胜」：新读立即发起并取代在途旧读（显式刷新绝不排队等旧读，
 *     草稿创建后的导航不被事件风暴里的在途读阻塞），先发后至的旧快照整份作废；
 *  4. 卸载/换装载调用 invalidateReads 作废在途读：被作废的读整份返回 null 不碰状态，
 *     React StrictMode 清理再装载后，旧装载发出的响应修改不了新装载的状态。
 *  传入 compare（负数 = a 排在 b 前，与主进程 list() 的排序一致）时，增量插入与
 *  createdAt/updatedAt 更新都按该序落位，保持与全量快照相同的顺序不变量。
 *  纯逻辑零依赖（不 import React/Electron），供 smoke 以 esbuild 直连驱动。 */

export type DeltaListReader<T> = () => Promise<T[]>
export type DeltaComparator<T> = (a: T, b: T) => number
export type DeltaOp<T> = { kind: 'upsert'; item: T } | { kind: 'remove'; id: string }
export type DeltaListener<T> = (items: T[]) => void

export interface DeltaList<T> {
  /** 当前数据（引用在两次变更之间保持稳定，可直接做 useSyncExternalStore 的 getSnapshot） */
  get(): T[]
  /** 订阅变更；返回退订函数。每次实际变更恰好通知一次（快照+重放合并为一次） */
  subscribe(listener: DeltaListener<T>): () => void
  has(id: string): boolean
  /** 是否有全量读在途（自动对账据此让位：读在途时广播已缓冲，落地即重放，无需再拉全量） */
  readonly reading: boolean
  upsert(item: T): void
  remove(id: string): void
  /** 全量快照读取。返回 null = 该读已被更新的读/作废取代（旧快照/旧失败整份作废，不碰状态）。 */
  read(reader: DeltaListReader<T>): Promise<T[] | null>
  /** 作废全部在途读并清空缓冲（卸载/StrictMode 清理用）：在途读的响应整份作废返回 null。 */
  invalidateReads(): void
}

export function createDeltaList<T>(idOf: (item: T) => string, compare?: DeltaComparator<T>): DeltaList<T> {
  let items: T[] = []
  const listeners = new Set<DeltaListener<T>>()
  let readSeq = 0
  // 只有「最新读」会落地快照：active 记录它的序号，在途期间增量进缓冲等重放；
  // 最新读落地/失败后缓冲清空，此后增量直落位（被取代的旧读不配再碰缓冲）
  let active: number | null = null
  let buffered: DeltaOp<T>[] = []

  const emit = () => { for (const listener of listeners) listener(items) }
  /** 有序模式下的插入位：第一个排在新条目前面的位置（相等的排在既有等值条目之后，近似稳定序） */
  const positionFor = (item: T): number => {
    if (!compare) return items.length
    let index = 0
    while (index < items.length && compare(item, items[index]) >= 0) index++
    return index
  }
  const insertAt = (item: T, at: number) => { items = [...items.slice(0, at), item, ...items.slice(at)] }
  const apply = (op: DeltaOp<T>, notify = true) => {
    if (op.kind === 'remove') {
      const next = items.filter((item) => idOf(item) !== op.id)
      if (next.length === items.length) return
      items = next
    } else {
      const key = idOf(op.item)
      const index = items.findIndex((item) => idOf(item) === key)
      if (index >= 0) {
        if (!compare || compare(items[index], op.item) === 0) {
          items = items.map((item, itemIndex) => (itemIndex === index ? op.item : item))
        } else {
          // 有序模式：更新可能改排序键（createdAt/updatedAt），摘除后按序插回
          items = items.filter((_item, itemIndex) => itemIndex !== index)
          insertAt(op.item, positionFor(op.item))
        }
      } else if (!compare) {
        items = [...items, op.item]
      } else {
        insertAt(op.item, positionFor(op.item))
      }
    }
    if (notify) emit()
  }

  const doRead = async (reader: DeltaListReader<T>, seq: number): Promise<T[] | null> => {
    try {
      const snapshot = await reader()
      if (seq !== readSeq) return null
      const replay = buffered
      buffered = []
      items = [...snapshot]
      for (const op of replay) apply(op, false)
      emit()
      return items
    } catch (cause) {
      if (seq !== readSeq) return null
      const replay = buffered
      buffered = []
      for (const op of replay) apply(op)
      throw cause
    } finally {
      if (active === seq) active = null
    }
  }

  const read = (reader: DeltaListReader<T>): Promise<T[] | null> => {
    const seq = ++readSeq
    active = seq
    return doRead(reader, seq)
  }

  return {
    get: () => items,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    has: (id) => items.some((item) => idOf(item) === id),
    get reading() { return active !== null },
    upsert: (item) => {
      const op: DeltaOp<T> = { kind: 'upsert', item }
      if (active !== null) buffered.push(op)
      else apply(op)
    },
    remove: (id) => {
      const op: DeltaOp<T> = { kind: 'remove', id }
      if (active !== null) buffered.push(op)
      else apply(op)
    },
    read,
    invalidateReads: () => {
      readSeq++
      active = null
      buffered = []
    }
  }
}
