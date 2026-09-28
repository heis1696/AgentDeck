import { useRef, useState } from 'react'
import { ChevronDown, FolderOpen, Plus } from 'lucide-react'
import { sharedPathKey } from '../../../shared/path-key'
import { useInteractionLayer } from '../hooks/useInteractionLayer'

/** 工作区切换器：下拉列出最近工作区，点击即切换新任务的默认目录。
 *  当前项判定按路径键折叠（与主进程路径等价判定同语义）：别名写法（大小写/分隔符
 *  差异）指向同一目录时照样高亮 current，不要求字面量全等。 */
export function WorkspaceSwitcher({ dir, recent, onChoose, onPick }: { dir: string; recent: string[]; onChoose: (dir: string) => void; onPick: () => void }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  // 统一浮层：外点关闭 + 最上层 Escape + 焦点归还（原自挂 window mousedown 已收敛）
  useInteractionLayer<HTMLDivElement>({ open, onClose: () => setOpen(false), kind: 'popover', name: 'workspace-switcher', closeOnOutside: true, autoFocus: false, layerRef: rootRef })
  const name = (d: string) => d.split(/[\\/]/).filter(Boolean).pop() ?? d
  const isCurrent = (candidate: string) => !!dir && sharedPathKey(candidate) === sharedPathKey(dir)
  return (
    <div className="ws-switch" ref={rootRef}>
      <button className="workspace-switcher" type="button" aria-haspopup="menu" aria-expanded={open} title={dir || '选择工作区'} onClick={() => setOpen((value) => !value)}>
        <span className="workspace-glyph"><FolderOpen size={14} /></span>
        <span><b>{dir ? name(dir) : '选择工作区'}</b><small>{dir || '新任务将默认在此目录执行'}</small></span>
        <ChevronDown size={14} className={`workspace-caret ${open ? 'flip' : ''}`} />
      </button>
      {open && (
        <div className="ws-menu" role="menu" aria-label="切换工作区">
          <div className="ws-menu-label">最近工作区</div>
          {recent.length === 0 && <div className="ws-menu-empty">还没有记录，先选一个目录</div>}
          {recent.map((d) => (
            <button key={d} className={`ws-menu-item ${isCurrent(d) ? 'current' : ''}`} role="menuitem" type="button" aria-current={isCurrent(d) ? 'true' : undefined} title={d} onClick={() => { onChoose(d); setOpen(false) }}>
              <FolderOpen size={13} />
              <span className="ws-menu-name">{name(d) || d}</span>
              <small className="ws-menu-path">{d}</small>
            </button>
          ))}
          <div className="ws-menu-sep" />
          <button className="ws-menu-item" role="menuitem" type="button" onClick={() => { onPick(); setOpen(false) }}>
            <Plus size={13} />
            <span className="ws-menu-name">选择其他目录…</span>
          </button>
        </div>
      )}
    </div>
  )
}
