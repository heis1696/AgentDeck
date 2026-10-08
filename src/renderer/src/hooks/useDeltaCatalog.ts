import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import { createDeltaList, type DeltaList } from '../data-store'

/** 增量目录的数据面：`createDeltaList` + 广播订阅 + 显式全量读的既有编排。
 *  Issue（api.ts:useIssues）、Meeting（useMeetings）、Board（BoardView 内联）三处
 *  此前各写一份同样的「装载 → 订阅 upsert/remove → 卸载作废在途读」序列；
 *  收敛为本 hook 后，各自的 loading/error/ready 语义仍由调用方经可选生命周期回调
 *  自行叠加（Board 的「增量不闪同步中」、Meeting 的 ready/error 等差异因此得以
 *  保留，不做强制统一；不传回调的调用方行为与回调机制完全无关）。 */
/** 一次增量变更：给出整条记录即落位，仅给 id 即摘除。合并成一个端口是必要的——
 *  多数广播通道（如 issues:updated）在同一条消息里二选一，拆成两个端口会迫使调用方
 *  对同一次订阅注册两次并各自过滤，反而更容易写错（会议的两路广播各转发一路即可）。 */
export type DeltaChange<T> =
  | { kind: 'upsert'; item: T }
  | { kind: 'remove'; id: string }

export interface DeltaCatalogSources<T> {
  /** 显式全量读（仅在装载/重试时调用） */
  list(): Promise<T[]>
  /** 增量广播：单条落位或摘除 */
  onChanged(listener: (change: DeltaChange<T>) => void): () => void
  /** 级联删除的对账兜底：低频触发一次全量刷新（如 GC 不广播时借 task:deleted 触发） */
  onCascadeDeleted?(refresh: () => void): () => void
}

/** 可选生命周期回调：全量读的成败出口。公共 hook 吞掉读异常（返回 null），需要
 *  ready/error 语义的调用方（如会议目录）从这里拿原始成败——不传则零开销、零行为差。 */
export interface DeltaCatalogLifecycle {
  /** 全量读成功落地（未被更新的读/作废取代）时触发：装载与显式刷新共用 */
  onReadSuccess?(): void
  /** 全量读失败时触发（已被取代/作废的旧读失败不触发）；cause 为原始异常 */
  onReadFailure?(cause: unknown): void
}

export interface DeltaCatalog<T> {
  items: T[]
  /** 全量读；返回 null = 读失败或已被更新的一次读取代 */
  refresh(): Promise<T[] | null>
  /** 直接落一条（乐观更新用：本地已确认的写回，不必等广播） */
  upsert(item: T): void
  /** 基础 delta list（少数组件需要 read/remove/invalidateReads 时用） */
  store: DeltaList<T>
}

/**
 * @param idOf    稳定标识（去重键）
 * @param compare 排序比较器
 * @param sources 数据源端口（不接收任何全局单例，便于同进程多实例共存）
 * @param lifecycle 可选生命周期回调（经 ref 间接持有：回调不稳定也不会导致装载 effect 重跑）
 */
export function useDeltaCatalog<T>(
  idOf: (item: T) => string,
  compare: ((left: T, right: T) => number) | undefined,
  sources: DeltaCatalogSources<T>,
  lifecycle?: DeltaCatalogLifecycle
): DeltaCatalog<T> {
  const storeRef = useRef<DeltaList<T> | null>(null)
  if (storeRef.current === null) storeRef.current = createDeltaList<T>(idOf, compare)
  const store = storeRef.current
  // 目录数据走 useSyncExternalStore：快照引用在两次变更间稳定（data-store 保证），
  // 订阅/重订阅与并发期撕裂由 React 兜底，不再手动镜像一份 state
  const items = useSyncExternalStore(store.subscribe, store.get)
  const requestRef = useRef(0)
  const lifecycleRef = useRef(lifecycle)
  lifecycleRef.current = lifecycle

  const refresh = useCallback(async () => {
    const request = ++requestRef.current
    try {
      const next = await store.read(() => sources.list())
      if (next && request === requestRef.current) lifecycleRef.current?.onReadSuccess?.()
      return request === requestRef.current ? next : null
    } catch (cause) {
      if (request === requestRef.current) lifecycleRef.current?.onReadFailure?.(cause)
      return null
    }
    // sources.list 由调用方以稳定引用提供；此处刻意不把它列进依赖，避免每次渲染重订阅
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store])

  useEffect(() => {
    const offChanged = sources.onChanged((change) => {
      if (change.kind === 'upsert') store.upsert(change.item)
      else store.remove(change.id)
    })
    const offCascade = sources.onCascadeDeleted?.(() => { void refresh() })
    void refresh()
    return () => {
      offChanged()
      offCascade?.()
      // 卸载/StrictMode 清理：作废在途读，旧装载的响应整份返回 null，不再碰状态
      store.invalidateReads()
      ++requestRef.current
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, refresh])

  const upsert = useCallback((item: T) => { store.upsert(item) }, [store])
  return { items, refresh, upsert, store }
}
