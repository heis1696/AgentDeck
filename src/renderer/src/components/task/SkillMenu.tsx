import { useEffect, useRef } from 'react'
import { Zap } from 'lucide-react'
import type { SkillMeta } from '../../../../shared/skills'

/**
 * 追问框斜杠命令菜单：输入以 / 开头时浮现，列出共享技能供选择。
 * 键盘导航由宿主 textarea 的 onKeyDown 驱动（↑↓选择、Enter/Tab 插入、Esc 关闭），
 * 本组件只负责展示与高亮，不抢焦点。
 */
export function SkillMenu({ skills, query, activeIndex, onHover, onPick }: {
  skills: SkillMeta[]
  query: string
  activeIndex: number
  onHover: (index: number) => void
  onPick: (skill: SkillMeta) => void
}) {
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])
  if (!skills.length) return null
  return (
    <div className="skill-menu" role="listbox" aria-label="技能命令">
      <div className="skill-menu-head">技能命令 · ↑↓ 选择，Enter/Tab 插入</div>
      <div className="skill-menu-list" ref={listRef}>
        {skills.map((skill, index) => (
          <button
            key={skill.name}
            type="button"
            role="option"
            aria-selected={index === activeIndex}
            data-active={index === activeIndex}
            className={`skill-menu-item ${index === activeIndex ? 'active' : ''}`}
            onMouseEnter={() => onHover(index)}
            onMouseDown={(event) => { event.preventDefault(); onPick(skill) }}
          >
            <Zap size={13} aria-hidden="true" />
            <span className="skill-menu-name">/{skill.name}</span>
            <span className="skill-menu-desc">{skill.description}</span>
          </button>
        ))}
      </div>
      {!query.trim() && <div className="skill-menu-foot">输入 /关键词 过滤；发送时包装为技能指令</div>}
    </div>
  )
}

/** 追问文本里的斜杠指令解析：/技能名(空格或结尾) 命中共享技能时返回该技能与剩余说明 */
export function parseSkillDirective(text: string, skills: SkillMeta[]): { skill: SkillMeta; rest: string } | null {
  if (!text.startsWith('/')) return null
  const token = /^\/([^\s]+)\s*([\s\S]*)$/.exec(text)
  if (!token) return null
  const skill = skills.find((item) => item.name.toLowerCase() === token[1].toLowerCase())
  return skill ? { skill, rest: token[2].trim() } : null
}

/** 技能指令包装模板（仅 zcode 会话有 Skill 工具；其他 backend 原样发送由调用方决定） */
export function wrapSkillDirective(skill: SkillMeta, rest: string): string {
  return `【指令】请使用技能「${skill.name}」处理：${rest || '（未附加说明，按该技能的流程执行）'}`
}
