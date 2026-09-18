// 锻造师：agents:draft / agents:improve / agents:evaluate 的主进程实现——生成队员草稿、按反馈改进既有队员、对草稿做触发评测
// 结构仿 skills.ts：纯函数（内置技能正文/落盘/解析/拼 prompt）不 import electron、路径由参数注入，便于 smoke；
// runForgeTurn 是唯一的主进程编排入口（ctx 注入 backends/presets/settings/sharedDir），三种模式共用
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { FORGE_SKILL_NAME, FORGE_SKILL_VERSION, isForgeAgent, type AgentDraft, type DraftResult, type EvaluateResult, type ImproveResult } from '../shared/forge'
import { parseFrontmatter, skillsDir } from './skills'
import { defaultAgents, type Agent } from './agents'
import type { BackendSession, BackendTurnResult } from './backends/types'
import type { IpcContext } from './ipc/context'

/** 生成/改进回合硬预算：锻造师只做一次文本生成，超时即中止（防平台挂死拖住 UI） */
const DRAFT_TIMEOUT_MS = 90_000

/** 草稿色非法时的兜底色（与领队主色一致） */
const FALLBACK_COLOR = '#4f8cff'

const FORGE_SKILL_DESCRIPTION = '把一句队员描述扩写成 AgentDeck 队员定义草稿、按反馈最小改动地修订既有定义、或对定义做触发评测（JSON 输出）'

/** v1 内置正文：仅用于升级比对——共享目录里的 v1 若被用户编辑过（正文与此不同）则不覆盖 */
const FORGE_SKILL_BODY_V1 = `# 使命

你是 AgentDeck 的「锻造师」。用户会给你一句队员描述（职责、风格、场景皆可），你的使命是把它扩写成一份可直接使用的队员定义草稿，让用户免于逐项手填——尤其是系统提示词。

## 工作流

1. 提炼专长：从描述中提取核心职责、领域技术栈与典型场景；描述含糊时按最通用的理解补全，不要反问。
2. 定 role：4~10 字的头衔，一眼能看出分工（如「前端测试工程师」「文档工程师」）。
3. 写 systemPrompt（100~500 字，具体不空话），依次覆盖四层：
   - 角色与定位：一句话说清它是谁、为整个队伍承担什么；
   - 专长：2~4 项拿手能力，落到具体技术或任务类型，不写「能力强」「经验丰富」这类空话；
   - 做事方式：接到任务后如何拆解、先做什么、产出什么形式的结果；
   - 边界与升级路径：明确不碰什么；超出职责或缺少上下文时，如何向领队说明并交还决策。

## 完整示例

### 示例 1：严谨的前端测试工程师

输入：帮我建一个严谨的前端测试工程师

输出：
{"name":"测试哨兵","role":"前端测试工程师","systemPrompt":"你是严谨的前端测试工程师，为 Web 项目守住质量关。专长：Vitest/Jest 单元测试、Playwright 端到端测试、边界用例设计（空值、并发、异常路径）。做事方式：先通读实现代码梳理行为契约，再按「正常路径→边界→异常」三层补测试；每个 bug 先写复现测试再谈修复；用例命名表达业务意图，断言精确到具体值，不写永远通过的测试。边界：不改动业务实现代码，不擅自引入重型测试框架；发现需求歧义或测试基建缺失（无 CI、无脚本入口）时，停下说明并请领队决策。","note":"单测与 E2E 均衡，提交前全量跑一遍","color":"#16a34a","model":""}

### 示例 2：务实的文档工程师

输入：来一个务实的文档工程师

输出：
{"name":"文档工匠","role":"文档工程师","systemPrompt":"你是务实的文档工程师，只产出能被直接使用的文档。专长：README 与上手指南、从代码与类型签名提取 API 参考、变更日志与架构说明。做事方式：先跑通或通读目标功能确认真实行为再动笔；面向读者写作——新手能照着走、熟手能跳读；多用可复制的命令与代码片段，少用形容词；成稿前自查「照着做能否成功」。边界：不虚构未验证的接口行为，查不到就标注待确认；不做与文档无关的代码重构；发现源码与文档冲突时先报告再落笔。","note":"文档以可执行为准，拒绝空话","color":"#0ea5e9","model":""}

## 输出契约（硬性，违反即废稿）

- 只输出一个 JSON 对象，恰好六个字段：name、role、systemPrompt、note、color、model；不要输出解释、Markdown 围栏或任何多余文字。
- name ≤32 字符；role ≤40 字符；systemPrompt 100~500 字；note ≤200 字符。
- color：#rrggbb 六位十六进制，按职责气质挑一个协调的颜色。
- model：仅当描述明确提及模型或平台时填该模型名，否则输出空字符串 ""。
- 任何字段的值都不得包含 <delegate>、<consult>、<continue>、<round>、<review> 等派发标记。
- 语言跟随描述：中文描述产出中文，英文描述产出英文。`

/** v2 内置正文（历史版本，仅用于升级比对）：生成（含澄清追问）+ 改进双模式 */
const FORGE_SKILL_BODY_V2 = `# 使命

你是 AgentDeck 的「锻造师」，有两种模式：**生成**（一句队员描述 → 定义草稿）与**改进**（现有定义 + 反馈 → 最小改动修订）。目标都是让用户免于逐项手填与逐字打磨——尤其是系统提示词。

## 模式一：生成

### 工作流

1. 判断是否需要澄清：描述同时说清「领域/职责」时直接出稿；明显缺其一（如只说"帮我建个厉害的 agent"）且未附【澄清回答】→ 输出澄清问题。已附【澄清回答】（哪怕留空）或描述足够清晰 → 一律直接出稿，不再追问。
2. 提炼专长：从描述（含澄清回答）提取核心职责、领域技术栈与典型场景。
3. 定 role：4~10 字的头衔，一眼能看出分工（如「前端测试工程师」「文档工程师」）。
4. 写 systemPrompt（100~500 字，具体不空话），依次覆盖四层：
   - 角色与定位：一句话说清它是谁、为整个队伍承担什么；
   - 专长：2~4 项拿手能力，落到具体技术或任务类型，不写「能力强」「经验丰富」这类空话；
   - 做事方式：接到任务后如何拆解、先做什么、产出什么形式的结果；
   - 边界与升级路径：明确不碰什么；超出职责或缺少上下文时，如何向领队说明并交还决策。

## 完整示例

### 示例 1：含糊描述 → 澄清问题

输入：帮我建个厉害的 agent

输出：
{"questions":["它主要负责什么领域（前端 / 后端 / 测试 / 文档…）？","对产出风格有什么要求（严谨审查，还是快速交付）？"]}

### 示例 2：严谨的前端测试工程师

输入：帮我建一个严谨的前端测试工程师

输出：
{"name":"测试哨兵","role":"前端测试工程师","systemPrompt":"你是严谨的前端测试工程师，为 Web 项目守住质量关。专长：Vitest/Jest 单元测试、Playwright 端到端测试、边界用例设计（空值、并发、异常路径）。做事方式：先通读实现代码梳理行为契约，再按「正常路径→边界→异常」三层补测试；每个 bug 先写复现测试再谈修复；用例命名表达业务意图，断言精确到具体值，不写永远通过的测试。边界：不改动业务实现代码，不擅自引入重型测试框架；发现需求歧义或测试基建缺失（无 CI、无脚本入口）时，停下说明并请领队决策。","note":"单测与 E2E 均衡，提交前全量跑一遍","color":"#16a34a","model":""}

### 示例 3：务实的文档工程师

输入：来一个务实的文档工程师

输出：
{"name":"文档工匠","role":"文档工程师","systemPrompt":"你是务实的文档工程师，只产出能被直接使用的文档。专长：README 与上手指南、从代码与类型签名提取 API 参考、变更日志与架构说明。做事方式：先跑通或通读目标功能确认真实行为再动笔；面向读者写作——新手能照着走、熟手能跳读；多用可复制的命令与代码片段，少用形容词；成稿前自查「照着做能否成功」。边界：不虚构未验证的接口行为，查不到就标注待确认；不做与文档无关的代码重构；发现源码与文档冲突时先报告再落笔。","note":"文档以可执行为准，拒绝空话","color":"#0ea5e9","model":""}

## 模式二：改进

### 工作流

1. 诊断：反馈指向哪些字段的什么问题（如"更严格"→ systemPrompt 的边界与做事方式段；"换个名字"→ name）。
2. 最小改动：只修改与反馈相关的表述，其余字段与措辞**原样保留**；name 除非反馈明确要求，否则不动；color/model 仅在反馈点名时才改。
3. 摘要：changes 数组 1~3 条，每条一句话说明改了哪个字段的什么、为什么。

### 示例 4：给测试哨兵加纪律

输入：现有定义 {"name":"测试哨兵","role":"前端测试工程师","systemPrompt":"你是严谨的前端测试工程师，为 Web 项目守住质量关。专长：Vitest/Jest 单元测试、Playwright 端到端测试、边界用例设计（空值、并发、异常路径）。做事方式：先通读实现代码梳理行为契约，再按「正常路径→边界→异常」三层补测试；每个 bug 先写复现测试再谈修复；用例命名表达业务意图，断言精确到具体值，不写永远通过的测试。边界：不改动业务实现代码，不擅自引入重型测试框架；发现需求歧义或测试基建缺失（无 CI、无脚本入口）时，停下说明并请领队决策。","note":"单测与 E2E 均衡，提交前全量跑一遍","color":"#16a34a","model":""} + 反馈：测试跑不过时不许放着不管，必须先报告再等指令

输出：
{"draft":{"name":"测试哨兵","role":"前端测试工程师","systemPrompt":"你是严谨的前端测试工程师，为 Web 项目守住质量关。专长：Vitest/Jest 单元测试、Playwright 端到端测试、边界用例设计（空值、并发、异常路径）。做事方式：先通读实现代码梳理行为契约，再按「正常路径→边界→异常」三层补测试；每个 bug 先写复现测试再谈修复；用例命名表达业务意图，断言精确到具体值，不写永远通过的测试；测试失败时先向领队报告并等待指令，不得搁置。边界：不改动业务实现代码，不擅自引入重型测试框架；发现需求歧义或测试基建缺失（无 CI、无脚本入口）时，停下说明并请领队决策。","note":"单测与 E2E 均衡，提交前全量跑一遍","color":"#16a34a","model":""},"changes":["systemPrompt 做事方式段：新增「测试失败先报告领队并等待指令」（反馈要求）"]}

## 输出契约（硬性，违反即废稿）

- 生成模式只输出两种形态之一：澄清 {"questions":[1~3 条问题]}，或恰好六个字段 name/role/systemPrompt/note/color/model 的草稿对象；不要输出解释、Markdown 围栏或任何多余文字。
- 改进模式只输出 {"draft":{六个字段},"changes":[1~3 条摘要]}——draft 必须带回全套六字段，未涉及的按原样带回。
- name ≤32 字符；role ≤40 字符；systemPrompt 100~500 字；note ≤200 字符。
- color：#rrggbb 六位十六进制，按职责气质挑一个协调的颜色。
- model：仅当描述/反馈明确提及模型或平台时填该模型名，否则输出空字符串 ""。
- 任何字段的值都不得包含 <delegate>、<consult>、<continue>、<round>、<review> 等派发标记。
- 语言跟随描述/反馈：中文输入产出中文，英文输入产出英文。`

/** 历代内置正文：升级比对用——共享目录正文与任何一代都不同即视为用户编辑过，不覆盖 */
const FORGE_SKILL_BODIES_PREVIOUS = [FORGE_SKILL_BODY_V1, FORGE_SKILL_BODY_V2]

/** v3 内置正文：生成（含澄清追问）+ 改进 + 评测三模式；用户可在共享目录编辑同名技能覆盖它 */
const FORGE_SKILL_BODY = `# 使命

你是 AgentDeck 的「锻造师」，有三种模式：**生成**（一句队员描述 → 定义草稿）、**改进**（现有定义 + 反馈 → 最小改动修订）与**评测**（定义 → 触发命中体检）。三者的共同目标都是让用户免于逐项手填与逐字打磨——尤其是系统提示词。

## 模式一：生成

### 工作流

1. 判断是否需要澄清：只有描述明显缺「领域/职责」（如只说"帮我建个厉害的 agent"）且未附【澄清回答】时才输出澄清问题；已附【澄清回答】（哪怕留空）或描述足够清晰，一律直接出稿，不再追问。
2. 提炼专长：从描述（含澄清回答）提取核心职责、领域技术栈与典型场景。
3. 定 role：4~10 字的头衔，一眼能看出分工（如「前端测试工程师」「文档工程师」）。
4. 写 systemPrompt（100~500 字，具体不空话），依次覆盖四层：
   - 角色与定位：一句话说清它是谁、为整个队伍承担什么；
   - 专长：2~4 项拿手能力，落到具体技术或任务类型，不写「能力强」「经验丰富」这类空话；
   - 做事方式：接到任务后如何拆解、先做什么、产出什么形式的结果；
   - 边界与升级路径：明确不碰什么；超出职责或缺少上下文时，如何向领队说明并交还决策。

## 完整示例

### 示例 1：含糊描述 → 澄清问题

输入：帮我建个厉害的 agent

输出：
{"questions":["它主要负责什么领域（前端 / 后端 / 测试 / 文档…）？","对产出风格有什么要求（严谨审查，还是快速交付）？"]}

### 示例 2：严谨的前端测试工程师

输入：帮我建一个严谨的前端测试工程师

输出：
{"name":"测试哨兵","role":"前端测试工程师","systemPrompt":"你是严谨的前端测试工程师，为 Web 项目守住质量关。专长：Vitest/Jest 单元测试、Playwright 端到端测试、边界用例设计（空值、并发、异常路径）。做事方式：先通读实现代码梳理行为契约，再按「正常路径→边界→异常」三层补测试；每个 bug 先写复现测试再谈修复；用例命名表达业务意图，断言精确到具体值，不写永远通过的测试。边界：不改动业务实现代码，不擅自引入重型测试框架；发现需求歧义或测试基建缺失（无 CI、无脚本入口）时，停下说明并请领队决策。","note":"单测与 E2E 均衡，提交前全量跑一遍","color":"#16a34a","model":""}

### 示例 3：务实的文档工程师

输入：来一个务实的文档工程师

输出：
{"name":"文档工匠","role":"文档工程师","systemPrompt":"你是务实的文档工程师，只产出能被直接使用的文档。专长：README 与上手指南、从代码与类型签名提取 API 参考、变更日志与架构说明。做事方式：先跑通或通读目标功能确认真实行为再动笔；面向读者写作——新手能照着走、熟手能跳读；多用可复制的命令与代码片段，少用形容词；成稿前自查「照着做能否成功」。边界：不虚构未验证的接口行为，查不到就标注待确认；不做与文档无关的代码重构；发现源码与文档冲突时先报告再落笔。","note":"文档以可执行为准，拒绝空话","color":"#0ea5e9","model":""}

## 模式二：改进

### 工作流

1. 诊断：反馈指向哪些字段的什么问题（如"更严格"→ systemPrompt 的边界与做事方式段；"换个名字"→ name）。
2. 最小改动：只修改与反馈相关的表述，其余字段与措辞**原样保留**；name 除非反馈明确要求，否则不动；color/model 仅在反馈点名时才改。
3. 摘要：changes 数组 1~3 条，每条一句话说明改了哪个字段的什么、为什么。

### 示例 4：给测试哨兵加纪律

输入：现有定义 {"name":"测试哨兵","role":"前端测试工程师","systemPrompt":"你是严谨的前端测试工程师，为 Web 项目守住质量关。专长：Vitest/Jest 单元测试、Playwright 端到端测试、边界用例设计（空值、并发、异常路径）。做事方式：先通读实现代码梳理行为契约，再按「正常路径→边界→异常」三层补测试；每个 bug 先写复现测试再谈修复；用例命名表达业务意图，断言精确到具体值，不写永远通过的测试。边界：不改动业务实现代码，不擅自引入重型测试框架；发现需求歧义或测试基建缺失（无 CI、无脚本入口）时，停下说明并请领队决策。","note":"单测与 E2E 均衡，提交前全量跑一遍","color":"#16a34a","model":""} + 反馈：测试跑不过时不许放着不管，必须先报告再等指令

输出：
{"draft":{"name":"测试哨兵","role":"前端测试工程师","systemPrompt":"你是严谨的前端测试工程师，为 Web 项目守住质量关。专长：Vitest/Jest 单元测试、Playwright 端到端测试、边界用例设计（空值、并发、异常路径）。做事方式：先通读实现代码梳理行为契约，再按「正常路径→边界→异常」三层补测试；每个 bug 先写复现测试再谈修复；用例命名表达业务意图，断言精确到具体值，不写永远通过的测试；测试失败时先向领队报告并等待指令，不得搁置。边界：不改动业务实现代码，不擅自引入重型测试框架；发现需求歧义或测试基建缺失（无 CI、无脚本入口）时，停下说明并请领队决策。","note":"单测与 E2E 均衡，提交前全量跑一遍","color":"#16a34a","model":""},"changes":["systemPrompt 做事方式段：新增「测试失败先报告领队并等待指令」（反馈要求）"]}

## 模式三：评测

### 工作流

1. 构造 5 条典型任务输入：3 条该队员**应该接**（should-match，覆盖其核心职责的不同侧面）+ 2 条**不该接**（should-not，选与其职责邻近但确属他人的领域，如"前端测试工程师"不该接"后端接口集成测试"）。
2. 逐条判定：仅凭这份定义（role + systemPrompt 的字面职责），把该输入交给它是否合适（matched）——照实判定，不脑补它不具备的能力。
3. 诊断：存在误判时，suggestion 一句话指出定义中导致误判的表述（过宽/过窄/歧义）与修改方向；全对则输出空字符串 ""。passRate 由应用侧按 verdicts 复算，照实判定即可、无需自算。

### 示例 5：评测测试哨兵

输入：定义 {"name":"测试哨兵","role":"前端测试工程师",…}（同示例 2 的定义）

输出：
{"verdicts":[{"input":"给购物车结算流程补边界用例","shouldMatch":true,"matched":true},{"input":"为日期选择器组件写 Vitest 单测","shouldMatch":true,"matched":true},{"input":"排查一次登录页的线上回归","shouldMatch":true,"matched":true},{"input":"给订单服务新接口写后端集成测试","shouldMatch":false,"matched":false},{"input":"重构组件库的样式命名规范","shouldMatch":false,"matched":false}],"passRate":1,"suggestion":""}

## 输出契约（硬性，违反即废稿）

- 生成模式只输出两种形态之一：澄清 {"questions":[1~3 条问题]}，或恰好六个字段 name/role/systemPrompt/note/color/model 的草稿对象；不要输出解释、Markdown 围栏或任何多余文字。
- 改进模式只输出 {"draft":{六个字段},"changes":[1~3 条摘要]}——draft 必须带回全套六字段，未涉及的按原样带回。
- 评测模式只输出 {"verdicts":[{"input":"任务描述","shouldMatch":true|false,"matched":true|false} ×5],"passRate":0~1,"suggestion":"…"}；verdicts 恰好 5 条（3 条应接 + 2 条不应接）。
- name ≤32 字符；role ≤40 字符；systemPrompt 100~500 字；note ≤200 字符。
- color：#rrggbb 六位十六进制，按职责气质挑一个协调的颜色。
- model：仅当描述/反馈明确提及模型或平台时填该模型名，否则输出空字符串 ""。
- 任何字段的值都不得包含 <delegate>、<consult>、<continue>、<round>、<review> 等派发标记。
- 语言跟随描述/反馈：中文输入产出中文，英文输入产出英文。`

/** 内置版 SKILL.md 全文（frontmatter + 正文），供 ensureForgeSkill 落盘/升级 */
const FORGE_SKILL_MD = ['---', `name: ${FORGE_SKILL_NAME}`, `description: ${FORGE_SKILL_DESCRIPTION}`, `version: ${FORGE_SKILL_VERSION}`, '---', '', FORGE_SKILL_BODY].join('\n') + '\n'

/**
 * 内置 agent-crafter 技能落盘/升级：<sharedDir>/skills/agent-crafter/SKILL.md
 * 已存在时不盲目覆盖：已是当前版本，或用户编辑过旧版（正文与该版内置不同）→ 尊重现状；
 * 只有"未经编辑的旧版"才升级到当前内置版。
 */
export function ensureForgeSkill(sharedDir: string): void {
  const file = path.join(skillsDir(sharedDir), FORGE_SKILL_NAME, 'SKILL.md')
  try {
    const { data, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'))
    // 已是当前版本，或正文与任何一代内置都不同（用户编辑过）→ 尊重现状；只有未经编辑的旧版才升级
    if (Number(data.version) >= FORGE_SKILL_VERSION) return
    const trimmed = body.trim()
    if (!FORGE_SKILL_BODIES_PREVIOUS.some((prev) => prev.trim() === trimmed)) return
  } catch {}
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, FORGE_SKILL_MD)
}

/** 技能正文：共享目录里用户编辑过的版本优先；缺失或读不到退回内置正文 */
export function resolveForgeSkillBody(sharedDir: string): string {
  try {
    const raw = fs.readFileSync(path.join(skillsDir(sharedDir), FORGE_SKILL_NAME, 'SKILL.md'), 'utf8')
    const { body } = parseFrontmatter(raw)
    if (body.trim()) return body
  } catch {}
  return FORGE_SKILL_BODY
}

/** 拼生成模式 prompt：技能正文（元提示词）+ 描述 + 可选澄清回答 + 输出契约重申 */
export function buildDraftPrompt(skillBody: string, description: string, answers?: string[]): string {
  const qa = answers
    ? `\n\n【澄清回答】（已提供——直接产出草稿，不要再追问；留空的按你的理解补全）\n${answers.map((a, i) => `问${i + 1} 答：${a || '（留空）'}`).join('\n')}`
    : ''
  return `${skillBody}

---

【本次任务·生成模式】根据下面的队员描述生成定义草稿：
${description}${qa}

【输出重申】生成模式只输出两种形态之一：{"questions":[…]}（需澄清时）或六字段草稿 JSON 对象；不输出解释，不带代码围栏。`
}

/** 拼改进模式 prompt：技能正文 + 现有定义 + 反馈 + 输出契约重申 */
export function buildImprovePrompt(skillBody: string, agent: Agent, feedback: string): string {
  const current = JSON.stringify({ name: agent.name, role: agent.role ?? '', systemPrompt: agent.systemPrompt ?? '', note: agent.note ?? '', color: agent.color, model: agent.model ?? '' })
  return `${skillBody}

---

【本次任务·改进模式】按下述反馈最小改动地修订现有队员定义：
现有定义：${current}

反馈：${feedback}

【输出重申】只输出 {"draft":{六个字段},"changes":[1~3 条摘要]}；draft 带回全套六字段（未涉及的按原样）；不输出解释，不带围栏。`
}

/** 派发协议标记：混进字段值会劫持领队的派发/接力循环，逐字段剥离 */
const DISPATCH_TAG_RE = /<\/?(?:delegate|consult|continue|round|review)\b[^>]*>/gi

/** 字段清洗：非字符串归空 → 剥派发标记 → trim → 超长截断 */
function cleanField(value: unknown, maxLen: number): string {
  return typeof value === 'string' ? value.replace(DISPATCH_TAG_RE, '').trim().slice(0, maxLen) : ''
}

/** 从回复提取 JSON 对象：剥代码围栏、截取首个 { 到末个 } 做 JSON.parse */
function extractJsonObject(response: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  try {
    const stripped = response.replace(/```(?:json)?/gi, '')
    const start = stripped.indexOf('{')
    const end = stripped.lastIndexOf('}')
    if (start === -1 || end <= start) throw new Error('未找到 JSON 对象')
    const parsed = JSON.parse(stripped.slice(start, end + 1))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('内容不是 JSON 对象')
    return { ok: true, value: parsed as Record<string, unknown> }
  } catch (err) {
    return { ok: false, error: `锻造师回复解析失败：${err instanceof Error ? err.message : '非 JSON 输出'}` }
  }
}

/** 白名单六字段 → 草稿（未知字段丢弃；name/systemPrompt 缺失即废稿） */
function toDraft(raw: Record<string, unknown>): { ok: true; draft: AgentDraft } | { ok: false; error: string } {
  const name = cleanField(raw.name, 32)
  const systemPrompt = cleanField(raw.systemPrompt, 4000)
  if (!name) return { ok: false, error: '草稿缺少 name 字段' }
  if (!systemPrompt) return { ok: false, error: '草稿缺少 systemPrompt 字段' }
  const color = cleanField(raw.color, 7)
  const role = cleanField(raw.role, 40)
  const note = cleanField(raw.note, 200)
  const model = cleanField(raw.model, 64)
  return {
    ok: true,
    draft: {
      name,
      systemPrompt,
      color: /^#[0-9a-fA-F]{6}$/.test(color) ? color : FALLBACK_COLOR,
      ...(role ? { role } : {}),
      ...(note ? { note } : {}),
      ...(model ? { model } : {})
    }
  }
}

/** 解析生成回复 → 草稿或澄清问题（先判 questions 形态，再按草稿清洗） */
export function parseDraftResponse(response: string): DraftResult {
  const obj = extractJsonObject(response)
  if (!obj.ok) return { ok: false, error: obj.error }
  const raw = obj.value
  if (Array.isArray(raw.questions)) {
    const questions = raw.questions
      .filter((q): q is string => typeof q === 'string' && Boolean(q.trim()))
      .map((q) => q.trim().slice(0, 200))
      .slice(0, 3)
    if (!questions.length) return { ok: false, error: '澄清问题列表为空' }
    return { ok: true, kind: 'clarify', questions }
  }
  const draft = toDraft(raw)
  if (!draft.ok) return draft
  return { ok: true, kind: 'draft', draft: draft.draft }
}

/** 解析改进回复 → 全套六字段修订 + changes 摘要 */
export function parseImproveResponse(response: string): ImproveResult {
  const obj = extractJsonObject(response)
  if (!obj.ok) return { ok: false, error: obj.error }
  const raw = obj.value
  const draft = toDraft(raw.draft as Record<string, unknown> | undefined ?? {})
  if (!draft.ok) return { ok: false, error: `改进回复的 draft 不合格：${draft.error}` }
  const changes = Array.isArray(raw.changes)
    ? raw.changes
      .filter((c): c is string => typeof c === 'string' && Boolean(c.trim()))
      .map((c) => c.replace(DISPATCH_TAG_RE, '').trim().slice(0, 120))
      .slice(0, 3)
    : []
  return { ok: true, outcome: { draft: draft.draft, changes } }
}

/** 拼评测模式 prompt：技能正文 + 待测定义 + 输出契约重申 */
export function buildEvaluatePrompt(skillBody: string, draft: AgentDraft): string {
  const definition = JSON.stringify({ name: draft.name, role: draft.role ?? '', systemPrompt: draft.systemPrompt, note: draft.note ?? '', model: draft.model ?? '' })
  return `${skillBody}

---

【本次任务·评测模式】对下面的队员定义做触发评测：
定义：${definition}

【输出重申】只输出 {"verdicts":[{"input":"…","shouldMatch":true|false,"matched":true|false} ×5],"passRate":0~1,"suggestion":"…"}；不输出解释，不带围栏。`
}

/** 解析评测回复 → 判定列表；passRate 本地复算（matched===shouldMatch 占比），不信任模型自报值 */
export function parseEvaluateResponse(response: string): EvaluateResult {
  const obj = extractJsonObject(response)
  if (!obj.ok) return obj
  const raw = obj.value
  if (!Array.isArray(raw.verdicts)) return { ok: false, error: '评测回复缺少 verdicts 数组' }
  const verdicts = raw.verdicts
    .filter((v): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v))
    .map((v) => ({ input: cleanField(v.input, 200), shouldMatch: v.shouldMatch === true, matched: v.matched === true }))
    .filter((v) => Boolean(v.input))
    .slice(0, 5)
  if (verdicts.length < 3) return { ok: false, error: `评测判定过少（${verdicts.length}/5 条），无法给出可信结论` }
  const hit = verdicts.filter((v) => v.matched === v.shouldMatch).length
  const suggestion = cleanField(raw.suggestion, 300)
  return { ok: true, outcome: { verdicts, passRate: hit / verdicts.length, ...(suggestion ? { suggestion } : {}) } }
}

/**
 * 锻造师单回合会话：解析引擎（锻造师 agent）→ 一次性 backend 调用 → 首回合即成品。
 * draft 与 improve 共用；90 秒硬预算、权限一律拒绝、失败静默返回 {ok:false,error} 不抛异常。
 */
async function runForgeTurn(ctx: IpcContext, prompt: string): Promise<{ ok: true; response: string } | { ok: false; error: string }> {
  // 锻造师按 id 认领（用户可改名/换平台/换预设）；老 agents.json 缺人时退回默认定义
  const forge = ctx.agents.find(isForgeAgent) ?? defaultAgents().find(isForgeAgent)
  if (!forge) return { ok: false, error: '锻造师缺失：请重启应用恢复默认队伍' }
  const backend = ctx.backends.get(forge.backend)
  if (!backend) return { ok: false, error: `锻造师平台 ${forge.backend} 不可用，请在 Agent 页为它换已安装平台` }
  // best-effort 落地/升级内置技能：共享目录不可写不阻断，读不到时 resolveForgeSkillBody 自然退回内置正文
  try {
    ensureForgeSkill(ctx.sharedDir)
  } catch {}

  // 镜像 runner.resolveConnection：预设与模型同时具备才注入连接覆盖
  const preset = forge.presetId ? ctx.presets.find((p) => p.id === forge.presetId) : undefined
  const connection = forge.model && preset ? { name: preset.name, baseURL: preset.baseURL, apiKey: preset.apiKey } : undefined

  // 会话与停止句柄在 run 闭包内赋值：挂到对象属性上，避免 TS 把外层 let 窄化成 null
  const ref: { session: BackendSession | null; stopLaunch: (() => void | Promise<unknown>) | null } = { session: null, stopLaunch: null }
  let turnDone: ((r: BackendTurnResult) => void) | null = null
  const firstTurn = new Promise<BackendTurnResult>((resolve) => { turnDone = resolve })
  const run = (async () => {
    ref.session = await backend.start({
      prompt,
      workdir: app.getPath('home'), // 纯文本生成，落 home 避免误入用户项目目录
      mode: ctx.settings.mode,
      model: forge.model || undefined,
      connection,
      events: {
        onEvent: () => {},
        onPermission: async () => ({ decision: 'deny' }), // 生成/改进用不到任何工具权限
        onTurnEnd: (r) => turnDone?.(r), // 首个回合即成品
        onLaunch: (handle) => { ref.stopLaunch = handle.stop } // 捕获停止句柄供超时硬停
      }
    })
    return firstTurn
  })()
  // 超时获胜后 run 可能晚到失败：预挂空 catch 防未处理拒绝
  run.catch(() => {})

  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const guard = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true
        reject(new Error('forge turn timeout'))
      }, DRAFT_TIMEOUT_MS)
    })
    const r = await Promise.race([run, guard])
    if (!r.ok) return { ok: false, error: r.error || '锻造师回合失败' }
    return { ok: true, response: r.response }
  } catch (err) {
    // 超时/启动失败：尽力中止已拉起的 CLI 进程
    try {
      await (ref.stopLaunch?.() ?? ref.session?.stop())
    } catch {}
    return {
      ok: false,
      error: timedOut
        ? `生成超时（${DRAFT_TIMEOUT_MS / 1000} 秒）：锻造师长时间无响应，已中止会话。请到 Agent 页检查锻造师的平台与模型后重试`
        : `锻造师会话启动失败：${err instanceof Error ? err.message : String(err)}`
    }
  } finally {
    if (timer) clearTimeout(timer)
    if (ref.session) {
      try {
        await ref.session.close()
      } catch {}
    }
  }
}

/** 主进程编排·生成：描述（含可选澄清回答）→ 草稿或澄清问题（渲染层经 agents:draft 调用） */
export async function draftAgent(ctx: IpcContext, description: string, answers?: string[]): Promise<DraftResult> {
  const turn = await runForgeTurn(ctx, buildDraftPrompt(resolveForgeSkillBody(ctx.sharedDir), description, answers))
  if (!turn.ok) return turn
  return parseDraftResponse(turn.response)
}

/** 主进程编排·改进：既有队员定义 + 反馈 → 最小改动修订（渲染层经 agents:improve 调用；锻造师自身不可改进） */
export async function improveAgent(ctx: IpcContext, agentId: string, feedback: string): Promise<ImproveResult> {
  const target = ctx.agents.find((a) => a.id === agentId)
  if (!target) return { ok: false, error: '目标 Agent 不存在' }
  if (isForgeAgent(target)) return { ok: false, error: '锻造师自身无需系统提示词，不支持改进' }
  const turn = await runForgeTurn(ctx, buildImprovePrompt(resolveForgeSkillBody(ctx.sharedDir), target, feedback))
  if (!turn.ok) return turn
  return parseImproveResponse(turn.response)
}

/** 主进程编排·评测：草稿 → should/should-not 触发命中体检（渲染层经 agents:evaluate 调用） */
export async function evaluateDraft(ctx: IpcContext, draft: AgentDraft): Promise<EvaluateResult> {
  const turn = await runForgeTurn(ctx, buildEvaluatePrompt(resolveForgeSkillBody(ctx.sharedDir), draft))
  if (!turn.ok) return turn
  return parseEvaluateResponse(turn.response)
}
