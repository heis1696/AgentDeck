// 共享目录技能库：SKILL.md 的解析/增删改/导入（纯 Node，不 import electron，目录由参数注入——便于 smoke 测试）
// 布局：<root>/README.md + <root>/skills/<name>/SKILL.md（+ 附加文件）
import fs from 'node:fs'
import path from 'node:path'
import type { SkillDetail, SkillMeta } from '../shared/skills'

/** 技能名即目录名；与 ZCode plugin 命名一致，同时杜绝路径逃逸（不含 / \ .. 等） */
export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/

export function isValidSkillName(name: string): boolean {
  return SKILL_NAME_PATTERN.test(name)
}

function assertName(name: string): string {
  if (typeof name !== 'string' || !isValidSkillName(name)) throw new Error(`技能名非法（需匹配 ${SKILL_NAME_PATTERN.source}）: ${name}`)
  return name
}

export function skillsDir(root: string): string {
  return path.join(root, 'skills')
}

function skillDir(root: string, name: string): string {
  const dir = path.join(skillsDir(root), assertName(name))
  // 纵深防御：即使 name 合法，也确认解析结果仍在共享目录内
  assertInside(skillsDir(root), dir)
  return dir
}

/** path.relative 逃逸校验：child 必须落在 parent 之下 */
export function assertInside(parent: string, child: string): void {
  const rel = path.relative(parent, child)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`路径越界: ${child}`)
}

/** 按行解析 YAML frontmatter（--- 分隔、key: value），不引入 YAML 依赖；无 frontmatter 时 body 为原文 */
export function parseFrontmatter(raw: string): { data: Record<string, string>; body: string } {
  const lines = raw.split(/\r?\n/)
  if ((lines[0] ?? '').trim() !== '---') return { data: {}, body: raw }
  const data: Record<string, string> = {}
  let close = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { close = i; break }
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(lines[i])
    if (match) {
      const value = match[2].trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')
      data[match[1]] = value
    }
  }
  if (close === -1) return { data: {}, body: raw }
  return { data, body: lines.slice(close + 1).join('\n').replace(/^\n+/, '') }
}

function serializeFrontmatter(name: string, description: string): string {
  const lines = ['---', `name: ${name}`]
  if (description.trim()) lines.push(`description: ${description.trim().replace(/\r?\n/g, ' ')}`)
  lines.push('---')
  return lines.join('\n')
}

/** 首次访问共享目录时生成 README.md 与 skills/（幂等；README 已存在不覆盖） */
export function ensureSharedDir(root: string): void {
  fs.mkdirSync(skillsDir(root), { recursive: true })
  const readme = path.join(root, 'README.md')
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(
      readme,
      [
        '# AgentDeck 共享目录',
        '',
        '本目录存放 AgentDeck 的**用户资产**：可手动编辑、可备份、可入库同步。应用状态（任务、设置、队伍）仍在应用自己的 userData 目录，两者互不混写。',
        '',
        '## 布局',
        '',
        '```',
        '~/.agentdeck/  （或你在设置里自定义的目录）',
        '├── README.md            本说明文件',
        '└── skills/              技能库（标准 SKILL.md 格式，与 Claude Code / Codex / ZCode 等工具互通）',
        '    └── <skill-name>/',
        '        ├── SKILL.md     必需：YAML frontmatter（name/description）+ Markdown 正文',
        '        └── <附加文件>    随技能一起安装/导入/导出',
        '```',
        '',
        '## 说明',
        '',
        '- 在 AgentDeck「技能」页新建/编辑/导入技能，或直接用任意编辑器修改本目录下的文件后刷新。',
        '- 「共享目标」可把技能一键安装到 `~/.claude/skills`、`~/.codex/skills`、`~/.zcode/skills` 与跨工具共享位 `~/.agents/skills`；改动源文件后目标会标记为过期，可一键重新同步。',
        '- 后续版本的提示词模板、命令等用户资产也计划放在本目录（预留，v1 仅实现 skills）。',
        ''
      ].join('\n')
    )
  }
}

function listFiles(dir: string, base = dir): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(full, base))
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'))
  }
  return out
}

function toMeta(root: string, name: string): SkillMeta | null {
  const dir = skillDir(root, name)
  const skillFile = path.join(dir, 'SKILL.md')
  let raw: string
  try {
    raw = fs.readFileSync(skillFile, 'utf8')
  } catch {
    return null
  }
  const { data } = parseFrontmatter(raw)
  let updatedAt = 0
  try {
    updatedAt = fs.statSync(skillFile).mtimeMs
  } catch {}
  return {
    name,
    description: data.description ?? '',
    dir,
    files: listFiles(dir),
    updatedAt,
    bodyBytes: Buffer.byteLength(raw)
  }
}

/** 列出共享目录全部技能（名字升序；缺 SKILL.md 或名字非法的目录跳过） */
export function listSkills(root: string): SkillMeta[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(skillsDir(root), { withFileTypes: true })
  } catch {
    return []
  }
  const metas: SkillMeta[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !isValidSkillName(entry.name)) continue
    const meta = toMeta(root, entry.name)
    if (meta) metas.push(meta)
  }
  return metas.sort((a, b) => a.name.localeCompare(b.name))
}

/** 读取技能详情（body 为去 frontmatter 后正文）；不存在返回 null */
export function readSkill(root: string, name: string): SkillDetail | null {
  const meta = toMeta(root, name)
  if (!meta) return null
  const raw = fs.readFileSync(path.join(meta.dir, 'SKILL.md'), 'utf8')
  return { name: meta.name, description: meta.description, body: parseFrontmatter(raw).body, files: meta.files }
}

/** 写入 SKILL.md（tmp + rename）；originName 存在 = 重命名（目录改名），目标已存在且与 originName 不同 → 报错 */
export function saveSkill(root: string, name: string, input: { description: string; body: string; originName?: string }): SkillMeta {
  assertName(name)
  if (typeof input.description !== 'string' || typeof input.body !== 'string') throw new Error('description/body 必须是字符串')
  const sourceName = input.originName === undefined ? name : assertName(input.originName)
  const target = skillDir(root, name)
  if (sourceName !== name) {
    if (fs.existsSync(target)) throw new Error(`技能目录已存在，无法重命名: ${name}`)
    const source = skillDir(root, sourceName)
    if (fs.existsSync(source)) {
      // 整目录改名，附加文件跟随
      fs.mkdirSync(skillsDir(root), { recursive: true })
      fs.renameSync(source, target)
    }
  }
  fs.mkdirSync(target, { recursive: true })
  const file = path.join(target, 'SKILL.md')
  const content = `${serializeFrontmatter(name, input.description)}\n\n${input.body.replace(/^\n+/, '')}`
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, content)
  fs.renameSync(tmp, file)
  const meta = toMeta(root, name)
  if (!meta) throw new Error(`技能保存后读取失败: ${name}`)
  return meta
}

/** 删除技能目录（幂等） */
export function deleteSkill(root: string, name: string): void {
  fs.rmSync(skillDir(root, name), { recursive: true, force: true })
}

/** 由导入源推导技能名：小写化、非法字符折叠为 -；导入重名时调用方负责换名 */
function sanitizeSkillName(raw: string): string {
  const folded = raw.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-._]+|[-._]+$/g, '').slice(0, 128)
  return isValidSkillName(folded) ? folded : `skill-${folded}`.slice(0, 128)
}

/** 导入技能：source 为目录（含 SKILL.md）或单个 .md 文件；重名自动 -2/-3… 后缀 */
export function importSkill(root: string, source: string): SkillMeta {
  if (typeof source !== 'string' || !source.trim()) throw new Error('导入源路径不能为空')
  const stat = fs.statSync(source)
  let baseName: string
  let copy: (target: string) => void
  if (stat.isDirectory()) {
    if (!fs.existsSync(path.join(source, 'SKILL.md'))) throw new Error(`目录缺少 SKILL.md，无法导入: ${source}`)
    baseName = sanitizeSkillName(path.basename(source))
    copy = (target) => fs.cpSync(source, target, { recursive: true })
  } else if (stat.isFile() && /\.md$/i.test(source)) {
    baseName = sanitizeSkillName(path.basename(source, path.extname(source)))
    copy = (target) => {
      fs.mkdirSync(target, { recursive: true })
      fs.copyFileSync(source, path.join(target, 'SKILL.md'))
    }
  } else {
    throw new Error(`导入源必须是含 SKILL.md 的目录或 .md 文件: ${source}`)
  }
  ensureSharedDir(root)
  let name = baseName
  for (let n = 2; fs.existsSync(skillDir(root, name)); n++) name = `${baseName}-${n}`
  const target = skillDir(root, name)
  copy(target)
  const meta = toMeta(root, name)
  if (!meta) throw new Error(`技能导入后读取失败: ${name}`)
  return meta
}
