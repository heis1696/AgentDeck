// 共享目录技能模型：AgentDeck 共享目录（默认 ~/.agentdeck）中的 SKILL.md 技能资产，
// 以及安装到各 agent CLI 技能目录（~/.claude/skills 等）的同步状态契约。

/** 技能列表项（name 即技能目录名） */
export interface SkillMeta {
  name: string
  description: string
  /** 技能目录绝对路径（共享目录下 skills/<name>） */
  dir: string
  /** 技能目录内全部文件（相对路径，含 SKILL.md），随安装一起拷贝 */
  files: string[]
  updatedAt: number
  /** SKILL.md 字节数 */
  bodyBytes: number
}

/** 技能详情（body 为去 frontmatter 后正文） */
export interface SkillDetail {
  name: string
  description: string
  body: string
  files: string[]
}

/** 单个安装目标的技能同步状态 */
export type SyncState = 'in-sync' | 'outdated' | 'missing'

/** 技能安装目标（各 agent CLI 的用户级技能目录） */
export interface SkillTarget {
  id: string
  label: string
  dir: string
  hint: string
}
