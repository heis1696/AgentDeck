// 小助理（桌宠）舞台：透明窗渲染层（主窗之外以 #/pet hash 路由进入）。
// rAF 循环调 shared 纯函数推进状态机与物理；DOM 只做最小写——帧变化才换 src，
// 位置由主进程移动窗体承载（渲染层不做 transform）。帧资源：内置包走
// import.meta.glob（vite 管线），用户包走 IPC data URL。
// 右键菜单投喂（eat 态）与尺寸缩放（窗/精灵/命中区同缩放，主进程承载窗体尺寸）；
// 好感/心情经 tuneTransitions 调制行为权重（不改素材包文件本身）；单击/抛掷上报累积好感。
// 鼠标穿透渲染层权威：精灵 pointerenter/pointerleave → hover 事件（主进程据此收/放鼠标）；
// 菜单/聊天开合上报主进程（开着时整窗收鼠标）；悬停 ~800ms 浮出状态栏（pointer-events:none）。
import { useCallback, useEffect, useRef, useState } from 'react'
import { bridge, type PackAssets, type PetStateSnapshot } from '../api'
import builtinManifestJson from './assets/default/pet.json'
import { pickFoodLine, pickPetLine, PET_FOODS } from '../../../shared/pet-lines'
import { tuneTransitions } from '../../../shared/pet-life'
import {
  petSpriteRect,
  petSpriteScale,
  petWindowSize,
  advancePet,
  createPetBrain,
  createPetPhysics,
  stepBrain,
  validatePetManifest,
  type PetBrain,
  type PetBounds,
  type PetManifest,
  type PetPhysics
} from '../../../shared/pet'
import './pet.css'

const BUILTIN_PACK_ID = 'default'
/** 单击气泡台词显示时长（ms） */
const BUBBLE_MS = 3000
/** 拖拽判定阈值（px）：低于它是点击，超过它交给主进程拖窗 */
const DRAG_THRESHOLD = 5
/** 悬停状态栏延迟（ms）：避免扫过就闪 */
const STATUS_HOVER_MS = 800

// 内置包帧 URL 表（vite 资产管线产物；打包进 assets，开发态走 dev server）
const builtinFrameUrls = import.meta.glob('./assets/default/*.png', { query: '?url', import: 'default', eager: true }) as Record<string, string>

function loadBuiltinManifest(): PetManifest {
  const manifest = validatePetManifest(builtinManifestJson)
  if (!manifest) throw new Error('内置桌宠素材包 pet.json 非法')
  return manifest
}
const builtinManifest: PetManifest = loadBuiltinManifest()

interface PackRuntime {
  packId: string
  manifest: PetManifest
  /** state id → 帧 url 列表（内置包为 vite 资产 URL，用户包为 data URL） */
  urls: Record<string, string[]>
}

function builtinRuntime(): PackRuntime {
  const urls: Record<string, string[]> = {}
  for (const [stateId, state] of Object.entries(builtinManifest.states)) {
    urls[stateId] = state.frames.map((frame) => {
      const hit = Object.entries(builtinFrameUrls).find(([path]) => path.endsWith(`/${frame}`))
      if (!hit) throw new Error(`内置桌宠帧缺失：${frame}`)
      return hit[1]
    })
  }
  return { packId: BUILTIN_PACK_ID, manifest: builtinManifest, urls }
}

// A 期占位台词池已退役：兜底台词统一走 shared pet-lines（主进程与渲染层同源）
const FALLBACK_LINE = '……'

export function PetStage() {
  const assetsRef = useRef<PackRuntime>(builtinRuntime())
  const brainRef = useRef<PetBrain>(createPetBrain('idle'))
  const physRef = useRef<PetPhysics>(createPetPhysics(window.screenX, window.screenY))
  const boundsRef = useRef<PetBounds | null>(null)
  const snapshotRef = useRef<PetStateSnapshot | null>(null)
  const draggingRef = useRef(false)
  const pointerStartRef = useRef<{ pointerId: number; x: number; y: number } | null>(null)
  const frameSrcRef = useRef('')
  const bubbleTimerRef = useRef<number | undefined>(undefined)
  /** 行为权重调制后的 manifest（好感/心情偏置；原包 manifest 不动） */
  const manifestRef = useRef<PetManifest>(builtinManifest)

  const [frameSrc, setFrameSrc] = useState('')
  const [spriteRendering, setSpriteRendering] = useState<'auto' | 'pixelated'>('pixelated')
  const [dragging, setDragging] = useState(false)
  const [bubble, setBubble] = useState<string | null>(null)
  const [chatOpen, setChatOpen] = useState(false)
  const [chatDraft, setChatDraft] = useState('')
  const [chatBusy, setChatBusy] = useState(false)
  const [chatLog, setChatLog] = useState<Array<{ role: 'user' | 'pet'; text: string }>>([])
  const chatInputRef = useRef<HTMLInputElement | null>(null)
  /** 当前缩放档（快照同步；窗体尺寸与精灵显示都随它走） */
  const [zoom, setZoom] = useState(1)
  // 右键菜单（C 期）：自绘 DOM；pack/feed/zoom 子菜单
  const [menu, setMenu] = useState<{ x: number; y: number; sub: 'pack' | 'feed' | 'zoom' | null } | null>(null)
  /** 精灵悬停态（穿透开关输入 + 状态栏前提） */
  const [statusVisible, setStatusVisible] = useState(false)
  const statusTimerRef = useRef<number | undefined>(undefined)
  /** 菜单开合上报（渲染层权威）：主进程 menu 态驱动整窗收鼠标，window blur 时主进程回推 menu-closed */
  const reportMenu = useCallback((open: boolean) => {
    bridge.pet.windowEvent({ type: 'menu', open })
  }, [])
  const closeMenu = useCallback(() => {
    setMenu((cur) => {
      if (cur) reportMenu(false)
      return null
    })
  }, [reportMenu])

  // pet-mode 隔离：透明窗背景不走主 UI 的画布底色
  useEffect(() => {
    document.documentElement.classList.add('pet-mode')
    return () => document.documentElement.classList.remove('pet-mode')
  }, [])

  const showBubble = useCallback((text: string) => {
    setBubble(text)
    if (bubbleTimerRef.current) window.clearTimeout(bubbleTimerRef.current)
    bubbleTimerRef.current = window.setTimeout(() => setBubble(null), BUBBLE_MS)
  }, [])

  const placeholderLine = useCallback(() => pickPetLine('click'), [])

  /** 好感/心情 → 行为权重偏置（包加载与快照更新后都要重算） */
  const retuneManifest = useCallback(() => {
    const life = snapshotRef.current?.life
    manifestRef.current = tuneTransitions(assetsRef.current.manifest, { affection: life?.affection ?? 0, mood: life?.mood ?? 50 })
    // 包级渲染提示：像素风包保持 pixelated，smooth 包交给浏览器高质量缩放
    setSpriteRendering(manifestRef.current.rendering === 'smooth' ? 'auto' : 'pixelated')
  }, [])

  /** 切换素材包：内置包同步装配，用户包异步拉 data URL（期间继续用旧包播放） */
  const loadPack = useCallback((packId: string) => {
    if (packId === BUILTIN_PACK_ID) {
      assetsRef.current = builtinRuntime()
      retuneManifest()
      return
    }
    void bridge.pet.getPackAssets(packId).then((assets) => {
      if (!assets) return
      assetsRef.current = { packId, manifest: assets.manifest, urls: assets.frames }
      retuneManifest()
    }).catch(() => { /* 坏包保持旧包播放，状态面板已标注 */ })
  }, [retuneManifest])

  /** 快照换算物理边界（窗尺寸随缩放档变化） */
  const applyBounds = useCallback((state: PetStateSnapshot) => {
    const area = state.screen?.workArea
    const size = petWindowSize(state.zoom)
    if (area) {
      boundsRef.current = {
        minX: area.x,
        maxX: area.x + area.width - size.width,
        floorY: area.y + area.height - size.height
      }
    }
  }, [])

  // 初始化：拉快照 + 订阅主进程推送
  useEffect(() => {
    void bridge.pet.getState().then((state) => {
      if (!state) return
      snapshotRef.current = state
      setZoom(state.zoom)
      applyBounds(state)
      loadPack(state.packId)
    })
    const offState = bridge.pet.onState((state) => {
      const packChanged = state.packId !== snapshotRef.current?.packId
      const prevZoom = snapshotRef.current?.zoom ?? state.zoom
      const zoomChanged = state.zoom !== prevZoom
      snapshotRef.current = state
      if (zoomChanged) {
        // 主进程按「底边中点」锚缩放窗体：渲染层物理坐标（窗左上角）同步平移，宠物脚不移位
        const oldSize = petWindowSize(prevZoom)
        const newSize = petWindowSize(state.zoom)
        physRef.current.x += (oldSize.width - newSize.width) / 2
        physRef.current.y += oldSize.height - newSize.height
        setZoom(state.zoom)
      }
      applyBounds(state)
      retuneManifest()
      if (packChanged) loadPack(state.packId)
    })
    const offDrag = bridge.pet.onDrag(({ x, y }) => {
      // 拖拽期间窗体位置以主进程跟随为准，渲染层物理挂起
      physRef.current.x = x
      physRef.current.y = y
    })
    const offThrown = bridge.pet.onThrown(({ vx, vy }) => {
      draggingRef.current = false
      setDragging(false)
      physRef.current.vx = vx
      physRef.current.vy = vy
      brainRef.current = stepBrain(brainRef.current, manifestRef.current, 'throw')
      // 抛掷上报：心情小扣（好玩但委屈），好感不动
      bridge.pet.windowEvent({ type: 'interact', kind: 'throw' })
    })
    const offPackChanged = bridge.pet.onPackChanged(() => {
      const packId = snapshotRef.current?.packId ?? BUILTIN_PACK_ID
      loadPack(packId)
    })
    // 主进程 window blur（窗外点击/Alt-Tab）触发的菜单自动关闭
    const offMenuClosed = bridge.pet.onMenuClosed(() => setMenu(null))
    // AI 脑自主发言（主进程 pet-brain）：气泡播报 + 动作动画 + 聊天记录留痕
    const offSay = bridge.pet.onSay((say) => {
      showBubble(say.text)
      if (!draggingRef.current) brainRef.current = createPetBrain(say.action)
      setChatLog((log) => [...log.slice(-2), { role: 'pet' as const, text: say.text }])
    })
    return () => {
      offState()
      offDrag()
      offThrown()
      offPackChanged()
      offMenuClosed()
      offSay()
    }
  }, [loadPack, applyBounds, retuneManifest])

  // rAF 主循环：物理 + 状态机推进（窗体位置由主进程按 move 事件承载）
  useEffect(() => {
    let raf = 0
    let last = performance.now()
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick)
      const dt = (now - last) / 1000
      last = now
      const bounds = boundsRef.current
      if (!bounds) return
      if (!draggingRef.current) {
        const result = advancePet(brainRef.current, physRef.current, manifestRef.current, dt, bounds)
        brainRef.current = result.brain
        physRef.current = result.physics
        if (result.moved) {
          bridge.pet.windowEvent({ type: 'move', x: Math.round(result.physics.x), y: Math.round(result.physics.y) })
        }
      }
      const { state, frame } = brainRef.current
      const urls = assetsRef.current.urls[state]
      if (urls && urls.length) {
        const url = urls[Math.min(frame, urls.length - 1)]
        if (url !== frameSrcRef.current) {
          frameSrcRef.current = url
          setFrameSrc(url)
        }
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  // —— 指针交互：点击 / 拖拽（阈值 5px）/ 双击开聊天 / 悬停穿透上报 + 状态栏 ——
  /** 精灵悬停进出：穿透态（forward:true）下 enter/leave 可靠触发，主进程收到即收/放鼠标 */
  const onSpriteEnter = () => {
    bridge.pet.windowEvent({ type: 'hover', inside: true })
    if (statusTimerRef.current) window.clearTimeout(statusTimerRef.current)
    statusTimerRef.current = window.setTimeout(() => setStatusVisible(true), STATUS_HOVER_MS)
  }
  const onSpriteLeave = () => {
    bridge.pet.windowEvent({ type: 'hover', inside: false })
    if (statusTimerRef.current) window.clearTimeout(statusTimerRef.current)
    statusTimerRef.current = undefined
    setStatusVisible(false)
  }
  const onPointerDown = (e: React.PointerEvent) => {
    pointerStartRef.current = { pointerId: e.pointerId, x: e.clientX, y: e.clientY }
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const start = pointerStartRef.current
    if (!start || e.pointerId !== start.pointerId || draggingRef.current) return
    const dist = Math.hypot(e.clientX - start.x, e.clientY - start.y)
    if (dist > DRAG_THRESHOLD) {
      draggingRef.current = true
      setDragging(true)
      brainRef.current = stepBrain(brainRef.current, manifestRef.current, 'dragStart')
      bridge.pet.windowEvent({ type: 'drag-start', offsetX: e.clientX, offsetY: e.clientY })
    }
  }
  const onPointerUp = (e: React.PointerEvent) => {
    const start = pointerStartRef.current
    if (!start || e.pointerId !== start.pointerId) return
    pointerStartRef.current = null
    if (draggingRef.current) {
      // 主进程停止跟随并差分末速 → pet:thrown 回推后转 fall
      bridge.pet.windowEvent({ type: 'drag-end' })
      return
    }
    brainRef.current = stepBrain(brainRef.current, manifestRef.current, 'click')
    showBubble(placeholderLine())
    // 单击上报：好感 +1 / 心情 +2（主进程落 pet.json）
    bridge.pet.windowEvent({ type: 'interact', kind: 'click' })
  }
  const onDoubleClick = () => {
    if (draggingRef.current) return
    brainRef.current = stepBrain(brainRef.current, manifestRef.current, 'doubleClick')
    openChat()
  }

  // —— 右键菜单（C 期 + D 期投喂/尺寸）：自绘 DOM；子菜单单开（内联手风琴）——
  const winSize = petWindowSize(zoom)
  // 菜单比窗体高时（小窗 + 展开子菜单）自动上移左移到窗内，放不下交给 .pet-menu 的 max-height 滚动
  const menuRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!menu || !menuRef.current) return
    const el = menuRef.current
    const rect = el.getBoundingClientRect()
    const dx = Math.min(0, winSize.width - 4 - rect.right)
    const dy = Math.min(0, winSize.height - 4 - rect.bottom)
    el.style.transform = dx || dy ? `translate(${dx}px, ${dy}px)` : ''
  }, [menu, winSize.width, winSize.height])
  useEffect(() => {
    if (!menu) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeMenu() }
    window.addEventListener('pointerdown', closeMenu)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', closeMenu)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu, closeMenu])
  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    // 菜单弹在光标处并 clamp 进窗体（菜单约 190 高，往左上收）
    const x = Math.min(e.clientX, winSize.width - 150)
    const y = Math.min(e.clientY, winSize.height - 200)
    setMenu({ x: Math.max(x, 4), y: Math.max(y, 4), sub: null })
    reportMenu(true)
  }
  const openSettingsFromMenu = () => {
    closeMenu()
    bridge.pet.windowEvent({ type: 'open-settings' })
  }
  const hidePet = () => {
    closeMenu()
    void bridge.pet.setEnabled(false)
  }
  /** 投喂：eat 态动画（素材包缺 eat 退回 happy）+ 本地零食台词 + 主进程落数值 */
  const feedPet = (foodId: string) => {
    closeMenu()
    brainRef.current = createPetBrain(manifestRef.current.states.eat ? 'eat' : 'happy')
    showBubble(pickFoodLine(foodId))
    void bridge.pet.feed(foodId)
  }

  // —— 聊天面板：真 AI 脑（pet:send-chat → persona+历史+记忆 → LLM；失败主进程兜底 pet-lines）——
  const openChat = () => {
    setChatOpen(true)
    bridge.pet.windowEvent({ type: 'chat', open: true })
    const history = snapshotRef.current?.chatHistory ?? []
    setChatLog(history.slice(-3).map((item) => ({ role: item.role, text: item.text })))
    window.setTimeout(() => chatInputRef.current?.focus(), 50)
  }
  const closeChat = () => {
    setChatOpen(false)
    bridge.pet.windowEvent({ type: 'chat', open: false })
  }
  const submitChat = () => {
    const text = chatDraft.trim()
    if (!text || chatBusy) return
    setChatDraft('')
    setChatBusy(true)
    setChatLog((log) => [...log.slice(-2), { role: 'user' as const, text }])
    void bridge.pet.sendChat(text).then((reply) => {
      const line = reply?.text || FALLBACK_LINE
      setChatLog((log) => [...log.slice(-2), { role: 'pet' as const, text: line }])
      showBubble(line)
      // 回复携带的动作驱动一段小动画（happy/think 等）
      if (reply && !draggingRef.current) brainRef.current = createPetBrain(reply.action)
    }).catch(() => {
      setChatLog((log) => [...log.slice(-2), { role: 'pet' as const, text: FALLBACK_LINE }])
    }).finally(() => setChatBusy(false))
  }

  const sprite = petSpriteRect(winSize.width, winSize.height, petSpriteScale(zoom))
  const bubbleOffset = assetsRef.current.manifest.bubble.offset
  const snapshot = snapshotRef.current
  return (
    <div className="pet-stage" onContextMenu={onContextMenu}>
      <div
        className={`pet-sprite ${dragging ? 'dragging' : ''}`}
        style={{ left: sprite.left, top: sprite.top, width: sprite.width, height: sprite.height }}
        onPointerEnter={onSpriteEnter}
        onPointerLeave={onSpriteLeave}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={onDoubleClick}
      >
        <img className="pet-sprite-img" style={{ imageRendering: spriteRendering }} src={frameSrc} draggable={false} alt="小助理" />
      </div>
      {snapshot && statusVisible && !chatOpen && !menu && (
        <div className="pet-status-bar" style={{ left: sprite.left + sprite.width / 2, top: Math.max(4, sprite.top - 8) }}>
          <div className="pet-status-row primary">
            {snapshot.life ? `♥ ${snapshot.life.affection} · ${snapshot.life.tier}` : '♥ ——'}
            {snapshot.life ? ` · 心情 ${snapshot.life.mood}（${snapshot.life.moodLabel}）` : ''}
          </div>
          <div className="pet-status-row">
            {snapshot.brainStatus.source === 'llm' && 'AI 脑：走模型'}
            {snapshot.brainStatus.source === 'fallback' && `AI 脑：兜底台词${snapshot.brainStatus.lastError ? `（${snapshot.brainStatus.lastError}）` : ''}`}
            {snapshot.brainStatus.source === 'none' && 'AI 脑：尚未发言'}
            {snapshot.brainStatus.silenced ? ' · 静默中' : ''}
          </div>
          <div className="pet-status-row">
            {(() => {
              const preset = snapshot.presets.find((item) => item.id === snapshot.activePresetId)
              if (!preset) return '预设：未接 AI'
              return `预设 ${preset.name} · 模型 ${snapshot.model || '网关默认'}`
            })()}
          </div>
        </div>
      )}
      {bubble && !chatOpen && (
        <div className="pet-bubble" style={{ left: sprite.left + bubbleOffset[0], top: sprite.top + bubbleOffset[1] }}>
          {bubble}
        </div>
      )}
      {chatOpen && (
        <div className="pet-chat">
          <div className="pet-chat-head">
            <span>和小助理聊聊</span>
            <button className="pet-chat-close" onClick={closeChat} aria-label="关闭聊天">✕</button>
          </div>
          <div className="pet-chat-log">
            {chatLog.length === 0 && <div className="pet-chat-empty">还没有对话，说点什么吧</div>}
            {chatLog.map((item, index) => (
              <div key={index} className={`pet-chat-line ${item.role}`}>{item.text}</div>
            ))}
          </div>
          <form className="pet-chat-input" onSubmit={(e) => { e.preventDefault(); submitChat() }}>
            <input
              ref={chatInputRef}
              value={chatDraft}
              onChange={(e) => setChatDraft(e.target.value)}
              placeholder="说点什么…"
              maxLength={200}
            />
            <button type="submit" disabled={!chatDraft.trim() || chatBusy}>{chatBusy ? '思考中…' : '发送'}</button>
          </form>
        </div>
      )}
      {menu && (
        <div ref={menuRef} className="pet-menu" style={{ left: menu.x, top: menu.y }} onPointerDown={(e) => e.stopPropagation()}>
          <button className="pet-menu-item" onClick={() => { closeMenu(); openChat() }}>聊天</button>
          <div className="pet-menu-sub">
            <button className="pet-menu-item" onClick={() => setMenu((cur) => (cur ? { ...cur, sub: cur.sub === 'feed' ? null : 'feed' } : cur))}>
              投喂 ▸
            </button>
            {menu.sub === 'feed' && (
              <div className="pet-menu-submenu">
                {PET_FOODS.map((food) => (
                  <button key={food.id} className="pet-menu-item" onClick={() => feedPet(food.id)}>{food.name}</button>
                ))}
              </div>
            )}
          </div>
          <div className="pet-menu-sub">
            <button className="pet-menu-item" onClick={() => setMenu((cur) => (cur ? { ...cur, sub: cur.sub === 'zoom' ? null : 'zoom' } : cur))}>
              尺寸 ▸
            </button>
            {menu.sub === 'zoom' && (
              <div className="pet-menu-submenu">
                {[1, 1.5, 2].map((step) => (
                  <button
                    key={step}
                    className="pet-menu-item"
                    onClick={() => {
                      closeMenu()
                      if (step !== zoom) void bridge.pet.setZoom(step)
                    }}
                  >
                    {step === 1 ? '100%' : step === 1.5 ? '150%' : '200%'}{step === zoom ? ' ✓' : ''}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button className="pet-menu-item" onClick={openSettingsFromMenu}>设置</button>
          <div className="pet-menu-sub">
            <button className="pet-menu-item" onClick={() => setMenu((cur) => (cur ? { ...cur, sub: cur.sub === 'pack' ? null : 'pack' } : cur))}>
              切换素材包 ▸
            </button>
            {menu.sub === 'pack' && (
              <div className="pet-menu-submenu">
                {(snapshotRef.current?.packs ?? []).filter((pack) => pack.ok).map((pack) => (
                  <button
                    key={pack.id}
                    className="pet-menu-item"
                    onClick={() => {
                      closeMenu()
                      void bridge.pet.setPack(pack.id)
                    }}
                  >
                    {pack.builtin ? pack.id : `${pack.id}（用户）`}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="pet-menu-sep" />
          <button className="pet-menu-item danger" onClick={hidePet}>隐藏小助理</button>
        </div>
      )}
    </div>
  )
}
