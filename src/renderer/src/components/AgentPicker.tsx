import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Check, ChevronDown, Search } from 'lucide-react'
import type { AgentInfo } from '../api'
import { useInteractionLayer } from '../hooks/useInteractionLayer'

export function AgentPicker({ agents, value, onChange }: {
  agents: AgentInfo[]
  value: string
  onChange: (agentId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const optionsRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  const [menuLayout, setMenuLayout] = useState<{ left: number; top?: number; bottom?: number; width: number; optionsHeight: number } | null>(null)
  const selected = agents.find((agent) => agent.id === value)
  const options = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return agents
    return agents.filter((agent) => [agent.name, agent.role, agent.backend, agent.model, agent.note].filter(Boolean).join(' ').toLowerCase().includes(needle))
  }, [agents, query])
  const activeIndex = options.length ? Math.min(active, options.length - 1) : -1

  useLayoutEffect(() => {
    if (!open) {
      setMenuLayout(null)
      return
    }
    const updateLayout = () => {
      const trigger = triggerRef.current?.getBoundingClientRect()
      if (!trigger) return
      const edge = 12
      const width = Math.min(620, Math.max(240, window.innerWidth - edge * 2))
      const left = Math.min(Math.max(edge, trigger.left), Math.max(edge, window.innerWidth - width - edge))
      const below = window.innerHeight - trigger.bottom - edge
      const above = trigger.top - edge
      const belowPlacement = below >= 220 || below >= above
      const available = Math.max(150, (belowPlacement ? below : above) - 5)
      setMenuLayout({
        left,
        ...(belowPlacement ? { top: trigger.bottom + 5 } : { bottom: window.innerHeight - trigger.top + 5 }),
        width,
        optionsHeight: Math.max(84, Math.min(240, available - 58))
      })
    }
    updateLayout()
    window.addEventListener('resize', updateLayout)
    document.addEventListener('scroll', updateLayout, true)
    return () => {
      window.removeEventListener('resize', updateLayout)
      document.removeEventListener('scroll', updateLayout, true)
    }
  }, [open])

  useEffect(() => {
    if (!open || activeIndex < 0) return
    const list = optionsRef.current
    const item = list?.querySelector<HTMLElement>('.agent-picker-option.active')
    if (!list || !item) return
    const bounds = list.getBoundingClientRect()
    const target = item.getBoundingClientRect()
    if (target.top < bounds.top) list.scrollTop += target.top - bounds.top
    else if (target.bottom > bounds.bottom) list.scrollTop += target.bottom - bounds.bottom
  }, [activeIndex, menuLayout, open, options])

  useInteractionLayer<HTMLDivElement>({
    open,
    onClose: () => setOpen(false),
    kind: 'popover',
    name: 'agent-picker',
    closeOnOutside: true,
    initialFocusRef: searchRef,
    restoreFocusRef: triggerRef,
    layerRef: rootRef
  })

  const choose = (agent: AgentInfo) => {
    onChange(agent.id)
    setOpen(false)
    setQuery('')
  }

  return <div className="agent-picker-root" ref={rootRef}>
    <button
      ref={triggerRef}
      type="button"
      className="agent-picker-trigger"
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={listId}
      onClick={() => {
        const nextOpen = !open
        setOpen(nextOpen)
        setQuery('')
        if (nextOpen) {
          const selectedIndex = agents.findIndex((agent) => agent.id === value)
          setActive(selectedIndex >= 0 ? selectedIndex : 0)
        } else {
          setActive(0)
        }
      }}
    >
      {selected ? <>
        <span className="agent-avatar sm" style={{ background: selected.color }}>{selected.name.slice(0, 1)}</span>
        <span className="agent-picker-selected"><strong>{selected.name}</strong><small>{selected.role || '未标注角色'} · {selected.backend}{selected.model ? ` · ${selected.model}` : ''}</small></span>
      </> : <span className="agent-picker-empty">选择执行 Agent</span>}
      <ChevronDown size={14} className={open ? 'flip' : ''} aria-hidden="true" />
    </button>
    {open && <div className="agent-picker-menu" role="dialog" aria-label="选择执行 Agent" style={{ ...(menuLayout ?? {}), visibility: menuLayout ? 'visible' : 'hidden', '--agent-picker-options-max-height': `${menuLayout?.optionsHeight ?? 240}px` } as CSSProperties}>
      <label className="agent-picker-search"><Search size={13} aria-hidden="true" /><input ref={searchRef} role="combobox" value={query} onChange={(event) => { setQuery(event.target.value); setActive(0) }} onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
        if (event.key === 'ArrowDown') { event.preventDefault(); setActive((current) => Math.min(options.length - 1, current + 1)) }
        else if (event.key === 'ArrowUp') { event.preventDefault(); setActive((current) => Math.max(0, current - 1)) }
        else if (event.key === 'Enter') { event.preventDefault(); if (activeIndex >= 0) choose(options[activeIndex]) }
      }} placeholder="搜索名称、角色、后端或模型" aria-label="搜索 Agent" aria-controls={listId} aria-expanded="true" aria-haspopup="listbox" aria-autocomplete="list" aria-activedescendant={activeIndex >= 0 ? `${listId}-${options[activeIndex].id}` : undefined} autoComplete="off" /> </label>
      <div className="agent-picker-options" ref={optionsRef} id={listId} role="listbox" aria-label="可用 Agent">
        {options.map((agent, index) => <button key={agent.id} id={`${listId}-${agent.id}`} type="button" role="option" aria-selected={agent.id === value} className={`agent-picker-option${index === activeIndex ? ' active' : ''}`} onMouseEnter={() => setActive(index)} onClick={() => choose(agent)}>
          <span className="agent-avatar sm" style={{ background: agent.color }}>{agent.name.slice(0, 1)}</span>
          <span className="agent-picker-option-text"><strong>{agent.name}</strong><small>{agent.role || '未标注角色'} · {agent.backend}{agent.model ? ` · ${agent.model}` : ''}</small></span>
          {agent.id === value && <Check size={14} aria-hidden="true" />}
        </button>)}
        {options.length === 0 && <p className="agent-picker-empty-state">没有匹配的 Agent</p>}
      </div>
    </div>}
  </div>
}
