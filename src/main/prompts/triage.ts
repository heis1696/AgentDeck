// 分诊师域提示词集中地：thinking-triage 技能正文（版本化升级比对链）、SKILL.md 组装、评估上下文 prompt 组装。
// 纯文案模块：不 import electron；落盘/解析/编排（ensureTriageSkill/parseTriageResponse/assessTaskThinking）留在 thinking-triage.ts。
// 升级规则同 forge.ts：改内置正文必须 ① TRIAGE_SKILL_VERSION +1（src/shared/triage.ts）② 把旧正文逐字追加进 TRIAGE_SKILL_BODIES_PREVIOUS。
import { TRIAGE_SKILL_NAME, TRIAGE_SKILL_VERSION, type TriageAssessKind } from '../../shared/triage'
import type { ThinkingLevel } from '../../shared/types'

const TRIAGE_SKILL_DESCRIPTION = '评估待执行任务的复杂度与风险，为 AgentDeck 动态思考强度输出最佳思考档位（off/low/medium/high/max）与一句理由（JSON 输出）'

/** 现行 v1 内置正文：放开 off–max 全 5 档，但通过软规则守住代码任务底线 */
export const TRIAGE_SKILL_BODY = `# 使命

你是 AgentDeck 的「分诊师」。你的唯一职责是在任务或追问执行前，快速评估难度与风险，为目标 Agent 分配最合适的思考强度档位（level），做到**简单任务快且省、复杂任务深且稳**。

## 五档标尺

- **off**：仅限纯闲聊、寒暄问候、极简纯文本格式转换或一句话翻译。**任何涉及读代码、改文件、排错、写测试或项目分析的任务，严禁给 off**。
- **low**：单文件明确小改（改文案、加注释、改单一常量/配置、简单重命名）、明确目标的快速查询或信息摘录。
- **medium**：常规单模块功能实现、补充单元测试、根因已较清晰的常规 bug 修复、中等长度技术文档编写。
- **high**：跨多文件/跨模块改动、需要权衡技术方案的设计与重构、根因不明的问题排查、领队需要拆解并行派单的中大型任务。
- **max**：核心状态机/并发/竞态/死锁/数据一致性疑难排查、大规模架构重构、高风险不可逆变更、或此前低/中档已失败返工的复杂任务。

## 判定守则

1. **宁防返工，不过度抠门**：表面一句话（如「修一下偶发失败」「排查为什么卡住」）若背后可能涉及并发、状态机或跨进程边界，至少给 \`high\`。
2. **关注角色与后端提示**：
   - 若目标为**领队**（需阅读全局并拆解委派），不要把多模块需求的规划压得过低；
   - 若上下文注明目标后端**启动后不支持中途升档**（如 \`dsh\`），拿不准时宁可高选一档；
   - 若为**同会话追问**且已给出当前档位，明显变难时果断升档；仅是顺手小补改时可结合当前档位评估。
3. **只做分诊，不做题**：绝不要尝试解答任务本身，不要展开长篇分析，直接给出档位与一句简短理由。

## 输出契约（硬性，违反即废稿）

- 只输出一个 JSON 对象，恰好两个字段：\`level\` 与 \`reason\`；不要输出解释、Markdown 代码围栏或任何多余文字。
- \`level\` 必须是以下五个小写字符串之一：\`"off"\`、\`"low"\`、\`"medium"\`、\`"high"\`、\`"max"\`。
- \`reason\` 用简洁中文一句话说明判档依据（不超过 30 字），不得包含任何尖括号协议标记。

## 示例

输入：把 README.md 里的拼写错误 "recieve" 改成 "receive"
输出：{"level":"low","reason":"单文件明确拼写修正"}

输入：排查 Windows 下并发派单偶发 worktree 锁冲突与状态残留，并补齐回滚验证
输出：{"level":"max","reason":"涉及并发锁冲突、状态机一致性与回滚验证"}`

/** 历代内置正文（用于升级比对：仅未编辑的旧版自动升级；v1 暂无旧版） */
export const TRIAGE_SKILL_BODIES_PREVIOUS: readonly string[] = []

export const TRIAGE_SKILL_MD = `---\nname: ${TRIAGE_SKILL_NAME}\ndescription: ${TRIAGE_SKILL_DESCRIPTION}\nversion: ${TRIAGE_SKILL_VERSION}\n---\n\n${TRIAGE_SKILL_BODY}\n`

export interface TriagePromptContext {
  prompt: string
  handoff?: string
  kind: TriageAssessKind
  targetName?: string
  targetRole?: string
  targetBackend?: string
  isLeader?: boolean
  switchMode?: 'per-turn' | 'startup-only' | 'none'
  currentThinking?: ThinkingLevel
}

const KIND_LABELS: Record<TriageAssessKind, string> = {
  task: '新任务首轮',
  followup: '同会话追问',
  delegate: '委派子任务',
  goal: '目标模式阶段',
  handoff: '阶段接力后继'
}

/** 构造用户侧待评估输入块（HTTP 直连与 CLI 单回合共用同一上下文构造） */
export function buildTriageUserContent(ctx: TriagePromptContext): string {
  const meta: string[] = [`场景：${KIND_LABELS[ctx.kind]}`]
  if (ctx.targetName) {
    meta.push(`执行者：${ctx.targetName}${ctx.targetRole ? `（${ctx.targetRole}）` : ''}${ctx.isLeader ? ' · 领队（可拆解委派）' : ''}`)
  }
  if (ctx.targetBackend) {
    const modeHint = ctx.switchMode === 'startup-only'
      ? '（启动后不可中途升档，拿不准宁可高选一档）'
      : ctx.switchMode === 'per-turn'
        ? '（支持后续回合热切与安全网升档）'
        : ''
    meta.push(`平台：${ctx.targetBackend}${modeHint}`)
  }
  if (ctx.currentThinking) meta.push(`当前会话思考档位：${ctx.currentThinking}`)

  const parts = [
    `【评估上下文】\n${meta.join('\n')}`,
    `【待评估任务正文】\n${ctx.prompt.trim().slice(0, 3000)}`
  ]
  if (ctx.handoff?.trim()) {
    parts.push(`【交接备注】\n${ctx.handoff.trim().slice(0, 800)}`)
  }
  parts.push('请按输出契约直接输出单行 JSON（仅含 level 与 reason）。')
  return parts.join('\n\n')
}

/** CLI 兜底通路：单条拼装 prompt（技能正文 + 评估输入） */
export function buildTriagePrompt(skillBody: string, ctx: TriagePromptContext): string {
  return `${skillBody.trim()}\n\n---\n\n${buildTriageUserContent(ctx)}`
}

/** HTTP 直连快通路：system + user 双消息 */
export function buildTriageMessages(skillBody: string, ctx: TriagePromptContext): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    { role: 'system', content: skillBody.trim() },
    { role: 'user', content: buildTriageUserContent(ctx) }
  ]
}
