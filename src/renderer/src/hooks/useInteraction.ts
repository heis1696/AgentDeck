import { useSyncExternalStore } from 'react'
import { ui, type InteractionSnapshot } from '../ui/interaction-center'

/**
 * 交互中心订阅（React 宿主唯一的状态来源）：
 * getSnapshot 必须返回**稳定引用**——中心只在状态变化时换新对象，
 * 因此整快照订阅与「原始值/中心内稳定引用」选择器订阅都是安全的。
 */
export function useInteractionState(): InteractionSnapshot {
  return useSyncExternalStore(ui.subscribe, ui.getState)
}

/** 选择器订阅：只订阅关心的字段（返回值须为原始值或中心内的稳定引用） */
export function useInteractionSelector<T>(selector: (state: InteractionSnapshot) => T): T {
  return useSyncExternalStore(ui.subscribe, () => selector(ui.getState()))
}
