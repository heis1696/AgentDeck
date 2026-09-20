/**
 * 真实 React DOM 回归夹具：只做「渲染 + 可交互的界面」，断言全部在 scripts/smoke-ui-focus.mjs。
 *
 * 这些场景刻意贴近线上真实结构（Agent 页「新建 Agent」模态、嵌套模态、模态内菜单、
 * 命令面板、确认框 FIFO、SideDock 页签条），用于验证「关闭浮层后焦点归位」这条交互契约。
 */
import { useRef, useState } from 'react'
import type { Task } from '../../src/shared/types'
import { useInteractionLayer } from '../../src/renderer/src/hooks/useInteractionLayer'
import { useInteractionSelector } from '../../src/renderer/src/hooks/useInteraction'
import { ui, rootTabsOf } from '../../src/renderer/src/ui/interaction-center'
import { ConfirmHost } from '../../src/renderer/src/ui/Confirm'
import { FloatWindow } from '../../src/renderer/src/ui/FloatWindow'
import { Menu } from '../../src/renderer/src/ui/Menu'
import { Palette } from '../../src/renderer/src/ui/Palette'
import { SideDock } from '../../src/renderer/src/ui/SideDock'
import { CodeViewer } from '../../src/renderer/src/ui/CodeViewer'
import { TabBar } from '../../src/renderer/src/components/TabBar'
import { TaskDetail } from '../../src/renderer/src/components/TaskDetail'

export { act, StrictMode, createElement, useEffect, useRef, useState } from 'react'
export { createRoot } from 'react-dom/client'
export { useInteractionLayer, resetOutsideFocusHistory } from '../../src/renderer/src/hooks/useInteractionLayer'
export { interactionLayers } from '../../src/renderer/src/ui/interaction-layer'
export { ui, rootTabsOf } from '../../src/renderer/src/ui/interaction-center'
export { ConfirmHost } from '../../src/renderer/src/ui/Confirm'
export { FloatWindow } from '../../src/renderer/src/ui/FloatWindow'
export { Menu } from '../../src/renderer/src/ui/Menu'
export { Palette } from '../../src/renderer/src/ui/Palette'
export { SideDock } from '../../src/renderer/src/ui/SideDock'
export { CodeViewer, parseUnifiedDiff, findDiffRowIndex } from '../../src/renderer/src/ui/CodeViewer'
export { prefersReducedMotion, scrollBehavior } from '../../src/renderer/src/ui/motion'
export { TabBar } from '../../src/renderer/src/components/TabBar'
export { TaskDetail } from '../../src/renderer/src/components/TaskDetail'

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
export const paletteRuns = { count: 0, last: '' }

export function PaletteScenario() {
  const [open, setOpen] = useState(false)
  const commands = [
    { id: 'go-issues', group: '跳转', label: 'Issue', run: () => { paletteRuns.count++; paletteRuns.last = 'go-issues' } },
    { id: 'go-board', group: '跳转', label: '看板', run: () => { paletteRuns.count++; paletteRuns.last = 'go-board' } }
  ]
  return <div>
    <button id="open-palette" data-testid="trigger" onClick={() => setOpen(true)}>搜索任务</button>
    <Palette open={open} onClose={() => setOpen(false)} commands={commands} />
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

/* ------------------------------------------------------------------------- */
/* 场景 9+：本轮修复的回归面（视觉/指针/焦点同序、真实 IME 组合事件、真实 TaskDetail） */
/* ------------------------------------------------------------------------- */

/** 命中计数：背景浮窗 / 信息弹层 / 模态 / 模态内菜单各自被真实点击的次数 */
export const stackHits = { float: 0, info: 0, modal: 0, menu: 0, menuPick: '' }

export function resetStackHits(): void {
  stackHits.float = 0
  stackHits.info = 0
  stackHits.modal = 0
  stackHits.menu = 0
  stackHits.menuPick = ''
}

/**
 * 场景 9：同屏堆叠——非模态浮窗（z 38）+ 信息弹层（z 40）+ 模态 overlay + 模态内嵌套菜单。
 * 复现「浮窗/信息弹层压在 overlay 之上、模态下方仍可点击」的真实结构：
 * 断言看 smoke-ui-focus.mjs（视觉 z 跟随层序、模态阻断背景指针与焦点、嵌套菜单仍可用）。
 */
export function OverlapStackScenario({ hideInfo = false }: { hideInfo?: boolean }) {
  const [modalOpen, setModalOpen] = useState(false)
  const [infoOpen, setInfoOpen] = useState(false)
  const [floatOpen, setFloatOpen] = useState(true)
  const modalRef = useInteractionLayer<HTMLDivElement>({ open: modalOpen, onClose: () => setModalOpen(false), kind: 'modal', name: 'confirm', trap: true })
  const infoBoxRef = useRef<HTMLDivElement>(null)
  useInteractionLayer<HTMLDivElement>({ open: infoOpen && !hideInfo, onClose: () => setInfoOpen(false), kind: 'popover', name: 'task-info', closeOnOutside: true, autoFocus: false, layerRef: infoBoxRef })
  return <div className="detail">
    <button data-testid="open-modal" onClick={() => setModalOpen(true)}>删除任务</button>
    <button data-testid="toggle-info" onClick={() => setInfoOpen(true)}>详细信息</button>
    <div className="meta-info-wrap" ref={infoBoxRef} data-testid="info-wrap">
      {infoOpen && !hideInfo && <div className="meta-info-pop" data-testid="info-pop">
        <button data-testid="info-btn" onClick={() => { stackHits.info++ }}>信息层按钮</button>
      </div>}
    </div>
    {floatOpen && <FloatWindow title="目标模式" onClose={() => setFloatOpen(false)}>
      <button data-testid="float-btn" onClick={() => { stackHits.float++ }}>浮窗体按钮</button>
    </FloatWindow>}
    {modalOpen && <div className="overlay" ref={modalRef} data-testid="modal-root" onClick={(event) => { if (event.target === event.currentTarget) setModalOpen(false) }}>
      <div className="dialog">
        <Menu
          items={[{ value: 'yes', label: '确认删除' }, { value: 'no', label: '保留' }]}
          onChange={(value) => { stackHits.menu++; stackHits.menuPick = value }}
          trigger={() => <button data-testid="modal-menu-trigger">更多操作</button>}
        />
        <button data-testid="modal-ok" onClick={() => { stackHits.modal++ }}>模态按钮</button>
      </div>
    </div>}
  </div>
}

/**
 * 场景 10：真实 TaskDetail（重命名输入框 + 追问框 + 斜杠技能菜单）。
 * bridge 由 scripts/smoke-ui-focus.mjs 在 import 前铺到 window.agentdeck 上（桩记录调用）。
 */
export function TaskDetailScenario({ task: override }: { task?: Task } = {}) {
  const task = override ?? makeTask()
  return <TaskDetail task={task} tasks={[task]} onSelect={() => {}} />
}

/** 造一个真实形状的任务（回归场景可覆盖任意字段） */
export function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-ime',
    title: '修复登录超时',
    prompt: '原始指令：修登录',
    status: 'done',
    backend: 'zcode',
    workdir: '',
    sessionId: 'sess-ime',
    createdAt: 1,
    endedAt: 2,
    ...overrides
  } as unknown as Task
}

/**
 * 场景 11：真实 TabBar（审查项 3）——宿主状态取自交互中心，与 App 同一条路径
 * （tabs 经 rootTabsOf 过滤 + closeTab 结算 activeId），断言「关闭后焦点跟随实际 activeId」。
 */
export function TabBarScenario() {
  const tabs = useInteractionSelector((state) => state.tabs)
  const activeId = useInteractionSelector((state) => state.activeId)
  const tasks = ui.tasks() as unknown as Task[]
  return <TabBar
    tabs={rootTabsOf(tasks, tabs)}
    tasks={tasks}
    activeId={activeId}
    onSelect={(id) => { ui.openTask(id) }}
    onClose={(id) => ui.closeTab(id)}
  />
}
