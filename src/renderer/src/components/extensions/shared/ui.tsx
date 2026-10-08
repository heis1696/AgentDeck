/**
 * 扩展页共享小工具（自 ExtensionsView.tsx「通用小工具」区原样迁出）：
 * 纯函数与安装目标 chip 行，供 skills / mcp / hooks / plugins / sources 各域单向依赖。
 * 本目录不得反向 import 任何域，避免成环（smoke-ui-interaction-center 全树 0 环守卫）。
 */
import type { DiscoveredAsset, SyncState } from '../../../../../shared/extensions'

export type TargetStates = Record<string, Record<string, SyncState>>

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** 多行文本 → 去空行数组（args / 命令列表用） */
export function linesToArray(text: string): string[] {
  return text.split('\n').map((line) => line.trim()).filter(Boolean)
}

/** 多行 KEY=VALUE → 字符串表（env / headers 用；无 = 的行按空值处理） */
export function linesToRecord(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const at = trimmed.indexOf('=')
    if (at < 0) out[trimmed] = ''
    else out[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim()
  }
  return out
}

/** 字符串表 → 多行 KEY=VALUE */
export function recordToLines(record?: Record<string, string>): string {
  return record ? Object.entries(record).map(([key, value]) => `${key}=${value}`).join('\n') : ''
}

/** 列表行的聚合状态点：全绿=全部目标 in-sync；黄=存在 outdated；灰=未安装到任何目标 */
export function aggregateState(states: Record<string, SyncState> | undefined, targetIds: string[]): 'ok' | 'warn' | 'none' {
  if (!states) return 'none'
  const values = targetIds.map((id) => states[id] ?? 'missing')
  if (values.length === 0 || values.every((value) => value === 'missing')) return 'none'
  if (values.every((value) => value === 'in-sync')) return 'ok'
  return 'warn'
}

/** 相对时间（源仓库 lastSyncedAt 展示用） */
export function fmtAgo(ts: number | null): string {
  if (!ts) return '从未同步'
  const minutes = Math.floor((Date.now() - ts) / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} 天前`
  return new Date(ts).toLocaleDateString()
}

/** 浏览资产面板的前端过滤：搜索命中 name/description，kind 三档（说明类仅在「全部」可见） */
export function filterAssets(list: DiscoveredAsset[], query: string, kind: 'all' | 'skill' | 'marketplace'): DiscoveredAsset[] {
  const q = query.trim().toLowerCase()
  return list.filter((asset) => {
    if (kind !== 'all' && asset.kind !== kind) return false
    if (!q) return true
    return `${asset.name} ${asset.description}`.toLowerCase().includes(q)
  })
}

/** 安装目标 chip 行：点击安装 / 卸载；outdated 显示重新同步（MCP / Hooks 共用） */
export function TargetChips({ targets, states, busy, onToggle }: {
  targets: Array<{ id: string; label: string; hint: string }>
  states: Record<string, SyncState> | undefined
  busy: boolean
  onToggle: (targetId: string) => void
}) {
  return <div className="skill-target-row">
    {targets.map((target) => {
      const state = states?.[target.id] ?? 'missing'
      return <button
        key={target.id}
        type="button"
        className={`skill-target st-${state}`}
        title={`${target.hint} · ${state}`}
        disabled={busy}
        onClick={() => onToggle(target.id)}
      >
        <i className="target-dot" />
        <span className="skill-target-copy">
          <b>{target.label}</b>
          <small>{state === 'in-sync' ? '已同步 · 卸载' : state === 'outdated' ? '过期 · 重新同步' : '未安装 · 安装'}</small>
        </span>
      </button>
    })}
  </div>
}
