import { useEffect, useRef } from 'react'
import { FileText, Folder } from 'lucide-react'
import type { WorkspaceEntry } from '../../../shared/contracts'

/**
 * @ 文件引用补全（吸收 ZCode 输入壳的 mention 面板）：在派单输入框打 @ 即列出工作区条目，
 * 把「给 agent 圈定文件上下文」从手打路径变成显式补全。选目录带 `/` 继续下钻，选文件落路径。
 *
 * 键盘导航由宿主 textarea 的 onKeyDown 驱动（↑↓ 选择、Enter/Tab 插入、Esc 关闭），
 * 本组件只展示与高亮，不抢焦点——无障碍契约与 SkillMenu 同款：宿主是 role="combobox"
 * 且始终持有焦点，本组件是其 listbox 弹层，选项 tabIndex={-1}，点选走 mousedown 不搬焦点。
 */
export const FILE_MENU_LISTBOX_ID = 'file-menu-listbox'
export const fileMenuOptionId = (index: number) => `file-menu-opt-${index}`

export type FileMenuItem = WorkspaceEntry & { path: string }

/** token 检测（纯函数，冒烟直测）：光标前若处于「@xxx」片段（@ 前必须是行首或空白），
 *  返回片段起点与内容；xxx 可含 `/`（下钻子目录）。 */
export function detectFileToken(text: string, caret: number): { at: number; token: string } | null {
  const before = text.slice(0, caret)
  const match = /(^|\s)@([^\s@]*)$/.exec(before)
  if (!match) return null
  return { at: caret - match[2].length, token: match[2] }
}

/** token 拆分：目录段 + 过滤词（'src/rend' → { subdir: 'src', filter: 'rend' }） */
export function splitToken(token: string): { subdir: string; filter: string } {
  const slash = token.lastIndexOf('/')
  if (slash < 0) return { subdir: '', filter: token }
  return { subdir: token.slice(0, slash), filter: token.slice(slash + 1) }
}

/** 条目过滤（大小写不敏感子串）+ 上限（面板最多展示 12 条，避免长列表键盘导航疲劳）。
 *  path 是要插入的完整相对路径（含目录段）：'src/rend' 命中 'renderer' 时插入 'src/renderer'。 */
export const FILE_MENU_LIMIT = 12
export function filterEntries(entries: WorkspaceEntry[], filter: string, subdir: string): FileMenuItem[] {
  const q = filter.trim().toLowerCase()
  const base = q ? entries.filter((entry) => entry.name.toLowerCase().includes(q)) : entries
  const prefix = subdir ? `${subdir}/` : ''
  return base.slice(0, FILE_MENU_LIMIT).map((entry) => ({ ...entry, path: prefix + entry.name }))
}

export function WorkspaceFileMenu({ items, activeIndex, onHover, onPick }: {
  items: FileMenuItem[]
  activeIndex: number
  onHover: (index: number) => void
  onPick: (item: FileMenuItem) => void
}) {
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [activeIndex])
  if (!items.length) return null
  return (
    <div className="skill-menu file-menu">
      <div className="skill-menu-head file-menu-head">工作区文件（目录可继续下钻）</div>
      <div id={FILE_MENU_LISTBOX_ID} className="skill-menu-list" role="listbox" aria-label="文件引用候选" ref={listRef}>
        {items.map((item, index) => (
          <div
            key={`${item.kind}:${item.name}`}
            id={fileMenuOptionId(index)}
            role="option"
            aria-selected={index === activeIndex}
            data-active={index === activeIndex}
            tabIndex={-1}
            className={`skill-menu-item file-menu-item${index === activeIndex ? ' active' : ''}`}
            onMouseEnter={() => onHover(index)}
            onMouseDown={(event) => { event.preventDefault(); onPick(item) }}
          >
            {item.kind === 'dir' ? <Folder size={13} aria-hidden="true" /> : <FileText size={13} aria-hidden="true" />}
            <span className="file-menu-name mono">{item.name}</span>
            {item.kind === 'dir' && <span className="file-menu-slash">/</span>}
          </div>
        ))}
      </div>
    </div>
  )
}
