/**
 * Electron 真实重叠点击夹具（浏览器端，无 Electron bridge 依赖）。
 *
 * 用**真实组件 + 真实样式表**堆出线上同款同屏结构：非模态浮窗（.float-window，z 38）+
 * 信息弹层（.meta-info-pop，z 40）+ 模态 overlay（.overlay）+ 模态内嵌套菜单。
 * 断言不在这里：scripts/smoke-ui-electron-overlap.mjs 通过 CDP 用真实鼠标坐标点击，
 * 读 window.__overlapHits 计数与 document.elementFromPoint 的命中结果。
 */
import { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../../src/renderer/src/styles.css'
import '../../src/renderer/src/tokens.css'
import '../../src/renderer/src/polish/foundation.css'
import '../../src/renderer/src/polish/page-shell.css'
import '../../src/renderer/src/polish/issue-home.css'
import '../../src/renderer/src/polish/board.css'
import '../../src/renderer/src/polish/detail.css'
import '../../src/renderer/src/polish/usage.css'
import '../../src/renderer/src/polish/team.css'
import '../../src/renderer/src/polish/dock.css'
import { useInteractionLayer } from '../../src/renderer/src/hooks/useInteractionLayer'
import { FloatWindow } from '../../src/renderer/src/ui/FloatWindow'
import { Menu } from '../../src/renderer/src/ui/Menu'

interface OverlapHits { float: number; info: number; modal: number; menu: number; backdrop: number; pick: string }
declare global {
  interface Window {
    __overlapHits: OverlapHits
    /** 程序化开关（异步弹窗的真实路径）：不产生点击，所以不会把已开的信息弹层当外点关掉 */
    __overlap: { openModal: () => void; openInfo: () => void }
  }
}

window.__overlapHits = { float: 0, info: 0, modal: 0, menu: 0, backdrop: 0, pick: '' }

function Harness() {
  const hits = window.__overlapHits
  const [modalOpen, setModalOpen] = useState(false)
  const [infoOpen, setInfoOpen] = useState(true)
  const [floatOpen, setFloatOpen] = useState(true)
  window.__overlap = { openModal: () => setModalOpen(true), openInfo: () => setInfoOpen(true) }
  const modalRef = useInteractionLayer<HTMLDivElement>({ open: modalOpen, onClose: () => setModalOpen(false), kind: 'modal', name: 'confirm', trap: true })
  const infoBoxRef = useRef<HTMLDivElement>(null)
  useInteractionLayer<HTMLDivElement>({ open: infoOpen, onClose: () => setInfoOpen(false), kind: 'popover', name: 'task-info', closeOnOutside: true, autoFocus: false, layerRef: infoBoxRef })
  return <div className="detail" data-testid="stage" style={{ height: '100vh' }}>
    {/* 夹具专用摆位：浮窗挪到右下，信息弹层留在右上，两个背景浮层互不遮挡 */}
    <style>{'.detail > .float-window { top: 360px; }'}</style>
    <div className="detail-left">
      <header className="detail-header">
        <h1 className="detail-title">修复登录超时</h1>
        <div className="detail-meta">
          <div className="meta-info-wrap" ref={infoBoxRef} data-testid="info-wrap">
            <button type="button" className={`meta-chip meta-info-btn ${infoOpen ? 'open' : ''}`} data-testid="info-trigger" onClick={() => setInfoOpen((value) => !value)}>ℹ</button>
            {infoOpen && <div className="meta-info-pop" data-testid="info-pop">
              <button type="button" className="btn" data-testid="info-btn" onClick={() => { hits.info++ }}>信息层按钮</button>
            </div>}
          </div>
          <button type="button" className="btn" data-testid="open-modal" onClick={() => setModalOpen(true)}>删除任务</button>
        </div>
      </header>
    </div>
    {floatOpen && <FloatWindow title="目标模式" onClose={() => setFloatOpen(false)}>
      <button type="button" className="btn" data-testid="float-btn" onClick={() => { hits.float++ }}>浮窗体按钮</button>
    </FloatWindow>}
    {modalOpen && <div className="overlay" ref={modalRef} data-testid="modal-root" onClick={(event) => { if (event.target === event.currentTarget) { hits.backdrop++; setModalOpen(false) } }}>
      <div className="dialog confirm-dialog" data-testid="dialog" role="dialog" aria-modal="true" aria-label="删除该任务及其日志？">
        <h2>删除该任务及其日志？</h2>
        <Menu
          items={[{ value: 'branch', label: '同时删除分支' }, { value: 'task', label: '只删任务' }]}
          onChange={(value) => { hits.menu++; hits.pick = value }}
          trigger={() => <button type="button" className="btn menu-trigger" data-testid="modal-menu-trigger">更多选项</button>}
        />
        <div className="dialog-footer">
          <button type="button" className="btn" data-testid="modal-cancel" onClick={() => setModalOpen(false)}>取消</button>
          <button type="button" className="btn danger" data-testid="modal-ok" onClick={() => { hits.modal++ }}>删除</button>
        </div>
      </div>
    </div>}
  </div>
}

createRoot(document.getElementById('root')!).render(<Harness />)
