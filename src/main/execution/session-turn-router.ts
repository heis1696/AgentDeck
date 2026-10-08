// 会话级回合路由器：把一条 BackendSession 连接上的回调路由给产生它的那个回合。
// 自 runner.ts 原样搬迁（批次 1，零行为变化）；类经 runner.ts re-export 保持可得。
import type { BackendTurnStamp } from '../backends/types'
import type { RunClaim, TurnRecord } from './identity'

/**
 * Correlates the callbacks of one `BackendSession` with the turn that produced
 * them. The session-level channel (created once, handed to the adapter at
 * start) forwards into this router; only the router decides which immutable
 * `TurnRecord` — if any — receives a callback:
 *
 * - a callback stamped with a known, still-open turn id goes to that turn;
 * - an unknown or already-closed id is dropped, never re-credited to the
 *   newest turn;
 * - a session that did **not** declare `turnScoped` cannot distinguish turns at
 *   all, so it is used for its isolated first turn only. Every later turn
 *   rebuilds the connection from its session id instead of guessing.
 */
class SessionTurnRouter {
  private readonly open = new Map<string, TurnRecord>()
  private currentId?: string
  private seq = 0
  /** 未声明回合身份的连接：未标记回调只能归给当时唯一在飞的回合 */
  legacy = true
  /** 有回合没收终态就被放弃：未标记回调的归属不再可信 */
  ambiguous = false
  /** 会话 id（登记后可知；回合 token 用它做 owner 门禁） */
  owner?: string
  /** 最近一次开在此连接上的运行身份（closeSession 的归属兜底） */
  lastClaim?: RunClaim

  nextSeq() {
    return ++this.seq
  }

  openTurn(record: TurnRecord) {
    // 同一会话同时只允许一个在飞回合：开新回合时仍开着的旧记录都是被顶掉的，
    // 在此可靠撤销（等待方经 onRevoked 立即落败），而不是留在 open 表里继续抢收回调。
    for (const id of [...this.open.keys()]) this.revoke(id)
    this.open.set(record.stamp.id, record)
    this.currentId = record.stamp.id
  }

  /** Terminal admitted: the turn may no longer receive anything. */
  closeTurn(id: string) {
    this.open.delete(id)
  }

  /**
   * The turn was given up (watchdog, cancel, send failure) before any terminal.
   * Its callbacks are dropped from now on, and a connection that cannot stamp
   * callbacks is marked unpinnable so the next turn rebuilds it.
   * 带 id 时按 id 精确撤销——被后继回合顶掉的旧记录不再是 currentId，
   * 只认 currentId 的旧语义会让它永远留在 open 表里继续抢收回调。
   */
  abandonTurn(id?: string) {
    const target = id !== undefined ? id : this.currentId
    if (!target) return
    this.revoke(target)
  }

  /** 撤销一个在飞回合：移出路由表；legacy 连接失去当前归属锚点时标记不可复用；
   *  最后才通知等待方（onRevoked 里若同步开新回合，看到的是已清空的 open 表）。 */
  private revoke(id: string) {
    const record = this.open.get(id)
    if (!record) return
    this.open.delete(id)
    if (id === this.currentId && this.legacy) this.ambiguous = true
    record.onRevoked?.()
  }

  abandonOpen() {
    this.abandonTurn()
  }

  hasOpenTurn() {
    return this.open.size > 0
  }

  /** Drop every callback still associated with this connection. */
  retire(reason: 'closed' | 'replaced' = 'closed') {
    for (const id of [...this.open.keys()]) this.revoke(id)
    this.currentId = undefined
    if (reason === 'replaced') this.ambiguous = true
  }

  /** Immutable routing decision for one adapter callback. */
  resolve(stamp?: BackendTurnStamp): TurnRecord | undefined {
    if (stamp && typeof stamp.id === 'string') return this.open.get(stamp.id)
    if (!this.legacy) return undefined
    if (this.ambiguous) return undefined
    return this.currentId ? this.open.get(this.currentId) : undefined
  }

  current(): TurnRecord | undefined {
    return this.currentId ? this.open.get(this.currentId) : undefined
  }

  /** A connection without turn identity may only be reused while unambiguous;
   *  且同一时刻只允许一个在飞回合——仍有回合没收终态就不得开新回合
   *  （总结轮×总结轮、总结轮×追问在此互斥；入口检查到 openTurn 之间零 await，
   *  检查通过即占住唯一名额，窗口就此收口）。 */
  mayOpenNewTurn() {
    return !this.ambiguous && this.open.size === 0
  }
}

export { SessionTurnRouter }
