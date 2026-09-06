import type { TaskStatus } from './types'

export function canTransition(from: TaskStatus, to: TaskStatus, actor: 'runner' | 'ui'): boolean {
  if (from === to) return true
  if (actor === 'runner') {
    if (from === 'queued' && to === 'running') return true
    if (from === 'running' && (to === 'done' || to === 'failed' || to === 'cancelled')) return true
    return false
  }
  if (from === 'running') return to === 'cancelled'
  if (from === 'queued') return to === 'queued' || to === 'running' || to === 'cancelled'
  if (from === 'done' || from === 'failed' || from === 'cancelled') return to === 'queued'
  return false
}

export function validateMove(from: TaskStatus, to: TaskStatus): { ok: true } | { ok: false; error: string } {
  if (!canTransition(from, to, 'ui')) {
    if (from === 'running') return { ok: false, error: '请先取消运行中的任务' }
    if (to === 'running' && from !== 'queued') return { ok: false, error: '只有排队中的任务可以启动' }
    return { ok: false, error: '无效的任务状态转换' }
  }
  return { ok: true }
}
