import { useId, useMemo, useRef, useState } from 'react'
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
  const listId = useId()
  const selected = agents.find((agent) => agent.id === value)
  const options = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return agents
    return agents.filter((agent) => [agent.name, agent.role, agent.backend, agent.model, agent.note].filter(Boolean).join(' ').toLowerCase().includes(needle))
  }, [agents, query])
  const activeIndex = options.length ? Math.min(active, options.length - 1) : -1

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
      onClick={() => { setOpen((current) => !current); setQuery(''); setActive(0) }}
    >
      {selected ? <>
        <span className="agent-avatar sm" style={{ background: selected.color }}>{selected.name.slice(0, 1)}</span>
        <span className="agent-picker-selected"><strong>{selected.name}</strong><small>{selected.role || '未标注角色'} · {selected.backend}{selected.model ? ` · ${selected.model}` : ''}</small></span>
      </> : <span className="agent-picker-empty">选择执行 Agent</span>}
      <ChevronDown size={14} className={open ? 'flip' : ''} aria-hidden="true" />
    </button>
    {open && <div className="agent-picker-menu" role="dialog" aria-label="选择执行 Agent">
      <label className="agent-picker-search"><Search size={13} aria-hidden="true" /><input ref={searchRef} value={query} onChange={(event) => { setQuery(event.target.value); setActive(0) }} onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
        if (event.key === 'ArrowDown') { event.preventDefault(); setActive((current) => Math.min(options.length - 1, current + 1)) }
        else if (event.key === 'ArrowUp') { event.preventDefault(); setActive((current) => Math.max(0, current - 1)) }
        else if (event.key === 'Enter') { event.preventDefault(); if (activeIndex >= 0) choose(options[activeIndex]) }
      }} placeholder="搜索名称、角色、后端或模型" aria-label="搜索 Agent" aria-controls={listId} aria-activedescendant={activeIndex >= 0 ? `${listId}-${options[activeIndex].id}` : undefined} autoComplete="off" /> </label>
      <div className="agent-picker-options" id={listId} role="listbox" aria-label="可用 Agent">
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
