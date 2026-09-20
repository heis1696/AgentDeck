/**
 * 真实 React DOM 回归夹具：只做「渲染 + 可交互的界面」，断言全部在 scripts/smoke-ui-focus.mjs。
 *
 * 这些场景刻意贴近线上真实结构（Agent 页「新建 Agent」模态、嵌套模态、模态内菜单、
 * 命令面板、确认框 FIFO、SideDock 页签条），用于验证「关闭浮层后焦点归位」这条交互契约。
 */
import { useRef, useState } from 'react'
import type { Task } from '../../src/shared/types'
import { useInteractionLayer } from '../../src/renderer/src/hooks/useInteractionLayer'
import { ui } from '../../src/renderer/src/ui/interaction-center'
import { ConfirmHost } from '../../src/renderer/src/ui/Confirm'
import { Menu } from '../../src/renderer/src/ui/Menu'
import { Palette } from '../../src/renderer/src/ui/Palette'
import { SideDock } from '../../src/renderer/src/ui/SideDock'

export { act, StrictMode, createElement, useEffect, useRef, useState } from 'react'
export { createRoot } from 'react-dom/client'
export { useInteractionLayer, resetOutsideFocusHistory } from '../../src/renderer/src/hooks/useInteractionLayer'
export { ui } from '../../src/renderer/src/ui/interaction-center'
export { ConfirmHost } from '../../src/renderer/src/ui/Confirm'
export { Menu } from '../../src/renderer/src/ui/Menu'
export { Palette } from '../../src/renderer/src/ui/Palette'
export { SideDock } from '../../src/renderer/src/ui/SideDock'

/** 场景 1：Agent 页「新建 Agent」——模态里的输入框带 autoFocus（缺陷原始复现路径） */
export function NewAgentScenario() {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const layerRef = useInteractionLayer<HTMLDivElement>({ open, onClose: () => setOpen(false), kind: 'modal', name: 'agent-editor', trap: true })
  return <div>
    <button id="new-agent" data-testid="trigger" onClick={() => setOpen(true)}>新建 Agent</button>
    {open && <div className="overlay" ref={layerRef} data-testid="modal">
      <div className="dialog">
        <h2>新建 Agent</h2>
        <input data-testid="name-input" autoFocus value={name} onChange={(event) => setName(event.target.value)} />
        <button data-testid="cancel" onClick={() => setOpen(false)}>取消</button>
      </div>
    </div>}
  </div>
}

/** 场景 2：嵌套模态——外层模态里的按钮再开一层（确认框结构） */
export function NestedModalScenario() {
  const [outer, setOuter] = useState(false)
  const [inner, setInner] = useState(false)
  const outerRef = useInteractionLayer<HTMLDivElement>({ open: outer, onClose: () => setOuter(false), kind: 'modal', name: 'outer', trap: true })
  const innerRef = useInteractionLayer<HTMLDivElement>({ open: inner, onClose: () => setInner(false), kind: 'modal', name: 'inner', trap: true })
  return <div>
    <button id="open-outer" data-testid="trigger" onClick={() => setOuter(true)}>编辑 Agent</button>
    {outer && <div className="overlay" ref={outerRef} data-testid="outer-modal">
      <div className="dialog">
        <input data-testid="outer-input" autoFocus />
        <button data-testid="open-inner" onClick={() => setInner(true)}>打开确认框</button>
      </div>
    </div>}
    {inner && <div className="overlay" ref={innerRef} data-testid="inner-modal">
      <div className="dialog"><button data-testid="inner-ok" onClick={() => setInner(false)}>确定</button></div>
    </div>}
  </div>
}

/** 场景 3：模态内嵌下拉菜单（autoFocus:false 的 popover 浮在模态之上） */
export function MenuInModalScenario() {
  const [open, setOpen] = useState(false)
  const [picked, setPicked] = useState('none')
  const layerRef = useInteractionLayer<HTMLDivElement>({ open, onClose: () => setOpen(false), kind: 'modal', name: 'agent-editor', trap: true })
  return <div>
    <button id="open-modal" data-testid="trigger" onClick={() => setOpen(true)}>新建 Agent</button>
    {open && <div className="overlay" ref={layerRef} data-testid="modal">
      <div className="dialog">
        <Menu
          items={[{ value: 'codex', label: 'codex' }, { value: 'claude', label: 'claude' }]}
          value={picked}
          onChange={setPicked}
          trigger={() => <button data-testid="menu-trigger">后端：{picked}</button>}
        />
        <button data-testid="modal-cancel" onClick={() => setOpen(false)}>取消</button>
      </div>
    </div>}
  </div>
}

/** 场景 4：卸载——浮层宿主卸载（触发按钮仍在）/ 触发按钮与浮层一起卸载 */
export function UnmountScenario({ showLayer, showTrigger }: { showLayer: boolean; showTrigger: boolean }) {
  return <div>
    {showTrigger && <button id="unmount-trigger" data-testid="trigger">新建 Agent</button>}
    {showLayer && <LayerChild />}
  </div>
}

function LayerChild() {
  const [open, setOpen] = useState(true)
  const layerRef = useInteractionLayer<HTMLDivElement>({ open, onClose: () => setOpen(false), kind: 'modal', name: 'agent-editor', trap: true })
  if (!open) return null
  return <div className="overlay" ref={layerRef} data-testid="modal">
    <div className="dialog"><input data-testid="child-input" autoFocus /><button data-testid="child-cancel" onClick={() => setOpen(false)}>取消</button></div>
  </div>
}

/** 场景 5：真实确认框宿主——两个请求排队，验证 FIFO 接棒时的焦点归属 */
export function ConfirmScenario() {
  const calls = useRef(0)
  return <div>
    <button id="ask" data-testid="trigger" onClick={() => {
      calls.current += 1
      void ui.confirm({ title: `第 ${calls.current} 问` })
      void ui.confirm({ title: `第 ${calls.current + 1} 问` })
      calls.current += 1
    }}>删除任务</button>
    <ConfirmHost />
  </div>
}

/** 场景 6：真实命令面板（trap + initialFocusRef 路径） */
export function PaletteScenario() {
  const [open, setOpen] = useState(false)
  return <div>
    <button id="open-palette" data-testid="trigger" onClick={() => setOpen(true)}>搜索任务</button>
    <Palette open={open} onClose={() => setOpen(false)} commands={[{ id: 'go-issues', group: '跳转', label: 'Issue' }]} />
  </div>
}

/** 场景 7：真实 SideDock 页签条（箭头切换是否把焦点带到新激活页签） */
export function SideDockScenario({ taskId = 'rootA' }: { taskId?: string }) {
  const tasks = [
    { id: 'rootA', title: '领队A' },
    { id: 'kid', title: '队员', parentTaskId: 'rootA' }
  ] as unknown as Task[]
  return <SideDock taskId={taskId} tasks={tasks} onOpen={() => {}} />
}

/**
 * 场景 8：就地重命名（TaskDetail 标题）——触发按钮被编辑框**替换**，
 * 打开前的触发元素在关闭时已经不在文档里，靠 restoreFocusRef 指回重新挂载的按钮。
 */
export function InlineEditScenario() {
  const [title, setTitle] = useState('修复登录超时')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const titleBtnRef = useRef<HTMLButtonElement>(null)
  const inputRef = useInteractionLayer<HTMLInputElement>({
    open: editing,
    onClose: () => setEditing(false),
    kind: 'popover',
    name: 'title-edit',
    restoreFocusRef: titleBtnRef
  })
  return <div>
    {editing
      ? <input ref={inputRef} data-testid="title-input" autoFocus value={draft} onChange={(event) => setDraft(event.target.value)} />
      : <h1 className="detail-title">{title}<button ref={titleBtnRef} data-testid="title-edit" onClick={() => { setDraft(title); setEditing(true) }}>重命名</button></h1>}
  </div>
}
