import { useEffect, useRef } from 'react'
import { MessagesSquare, Target, Zap } from 'lucide-react'
import type { SkillMeta } from '../../../../shared/skills'

/** 内置本地命令：选中后由前端直接打开对应浮窗/创建流程，不发给后端 */
export type LocalCommandKey = 'goal' | 'meeting'

export type MenuItem =
  | { kind: 'command'; key: LocalCommandKey; name: string; desc: string; icon: typeof Target }
  | { kind: 'skill'; skill: SkillMeta }

const LOCAL_COMMANDS: Array<{ key: LocalCommandKey; name: string; desc: string; icon: typeof Target }> = [
  { key: 'goal', name: 'goal', desc: '启动目标模式', icon: Target },
  { key: 'meeting', name: 'meeting', desc: '召集团队会议', icon: MessagesSquare }
]

/** 菜单条目 = 内置命令（前）+ 共享技能（后），按 /query 过滤；宿主键盘导航与组件渲染共用同一份列表 */
export function buildMenuItems(skills: SkillMeta[], query: string, includeSkills: boolean): MenuItem[] {
  const q = query.trim().toLowerCase()
  const hitCommand = (text: string) => !q || text.toLowerCase().includes(q)
  const commands = LOCAL_COMMANDS
    .filter((command) => hitCommand(command.name) || hitCommand(command.desc))
    .map((command) => ({ kind: 'command' as const, ...command }))
  const lower = q
  const skillItems = includeSkills
    ? (q ? skills.filter((skill) => skill.name.toLowerCase().includes(lower) || skill.description.toLowerCase().includes(lower)) : skills)
      .map((skill) => ({ kind: 'skill' as const, skill }))
    : []
  return [...commands, ...skillItems]
}

/**
 * 追问框斜杠命令菜单：输入以 / 开头时浮现，顶部为内置「命令」组（本地动作），
 * 下方为「技能」组（共享技能）。键盘导航由宿主 textarea 的 onKeyDown 驱动
 * （↑↓选择、Enter/Tab 插入、Esc 关闭），本组件只负责展示与高亮，不抢焦点。
 *
 * 无障碍（审查项 5）：宿主 textarea 是 role="combobox" 且**始终持有 DOM 焦点**，
 * 本组件是它的 listbox 弹层（aria-controls 指向下面的 id），高亮项通过宿主的
 * aria-activedescendant 指认。因此选项一律 tabIndex={-1}：Tab 序列里只有输入框，
 * 焦点绝不会掉进选项里（选项被点选走的是 mousedown + preventDefault，不搬焦点）。
 */
export const SKILL_MENU_LISTBOX_ID = 'skill-menu-listbox'
export const skillMenuOptionId = (index: number) => `skill-menu-opt-${index}`

export function SkillMenu({ items, activeIndex, onHover, onPickCommand, onPickSkill }: {
  items: MenuItem[]
  activeIndex: number
  onHover: (index: number) => void
  onPickCommand: (key: LocalCommandKey) => void
  onPickSkill: (skill: SkillMeta) => void
}) {
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [activeIndex])
  if (!items.length) return null
  const firstCommand = items.findIndex((item) => item.kind === 'command')
  const firstSkill = items.findIndex((item) => item.kind === 'skill')
  return (
    <div className="skill-menu">
      <div className="skill-menu-head">命令与技能 · {items.length} 项 · ↑↓ 选择，Enter/Tab 确认</div>
      <div className="skill-menu-list" id={SKILL_MENU_LISTBOX_ID} role="listbox" aria-label="命令与技能" ref={listRef}>
        {items.map((item, index) => (
          <div key={item.kind === 'command' ? `cmd-${item.key}` : `skill-${item.skill.name}`} className="skill-menu-slot">
            {index === firstCommand && <div className="skill-menu-group">命令</div>}
            {index === firstSkill && <div className="skill-menu-group">技能</div>}
            {item.kind === 'command' ? (
              <button
                type="button"
                role="option"
                id={skillMenuOptionId(index)}
                tabIndex={-1}
                aria-selected={index === activeIndex}
                data-active={index === activeIndex}
                className={`skill-menu-item is-command ${index === activeIndex ? 'active' : ''}`}
                onMouseEnter={() => onHover(index)}
                onMouseDown={(event) => { event.preventDefault(); onPickCommand(item.key) }}
              >
                <item.icon size={13} aria-hidden="true" />
                <span className="skill-menu-name">/{item.name}</span>
                <span className="skill-menu-desc">{item.desc}</span>
                <span className="skill-menu-tag">本地</span>
              </button>
            ) : (
              <button
                type="button"
                role="option"
                id={skillMenuOptionId(index)}
                tabIndex={-1}
                aria-selected={index === activeIndex}
                data-active={index === activeIndex}
                className={`skill-menu-item ${index === activeIndex ? 'active' : ''}`}
                onMouseEnter={() => onHover(index)}
                onMouseDown={(event) => { event.preventDefault(); onPickSkill(item.skill) }}
              >
                <Zap size={13} aria-hidden="true" />
                <span className="skill-menu-name">/{item.skill.name}</span>
                <span className="skill-menu-desc">{item.skill.description}</span>
              </button>
            )}
          </div>
        ))}
      </div>
      <div className="skill-menu-foot">/goal /meeting 为本地命令，直接打开面板；技能发送时包装为技能指令</div>
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
