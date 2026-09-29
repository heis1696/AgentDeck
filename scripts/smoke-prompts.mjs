// 提示词契约冒烟（纯本地、不起后端）：把 src/main/prompts 渲染出来，固化「去歧义」重做后的契约——
// 协议标记与解析器对得上、同一规则只有一处定义、规则只在相关时出现、注入缺口不回退、锻造升级链不断。
// 改 src/main/prompts/** 或其调用点的文案后跑：npm run smoke:prompts（约定见 docs/PROMPTS.md）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
// 产物放仓库内 out/（gitignore）：agent-forge 链路顶层 require('electron')，需从仓库 node_modules 解析
const bundleDir = path.join(root, 'out', 'smoke-prompts')
fs.mkdirSync(bundleDir, { recursive: true })
const bundle = async (source, name) => {
  const outfile = path.join(bundleDir, name)
  await build({ entryPoints: [path.join(root, source)], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node18', external: ['electron'], logLevel: 'silent' })
  return import(pathToFileURL(outfile).href)
}

const [p, delegate, forge, skills, sessions, goal, sharedForge] = await Promise.all([
  bundle('src/main/prompts/index.ts', 'prompts.cjs'),
  bundle('src/main/delegate.ts', 'delegate.cjs'),
  bundle('src/main/agent-forge.ts', 'agent-forge.cjs'),
  bundle('src/main/skills.ts', 'skills.cjs'),
  bundle('src/main/agent-sessions.ts', 'agent-sessions.cjs'),
  bundle('src/main/goal-controller.ts', 'goal-controller.cjs'),
  bundle('src/shared/forge.ts', 'shared-forge.cjs')
])

let failures = 0
const check = (condition, label) => {
  console.log(`  ${condition ? 'OK' : 'FAIL'} ${label}`)
  if (!condition) failures++
}
const rendered = []
const r = (text) => { rendered.push(text); return text }

// ================= 委派域 =================
console.log('委派域：')
const leader = { id: 'ag_lead', name: 'Lead', backend: 'zcode', role: '领队', systemPrompt: '你是开发领队。', subordinates: ['ag_c', 'ag_x'] }
const team = [
  leader,
  { id: 'ag_c', name: 'Claude', backend: 'claude', role: '工程师', note: '擅长 TS' },
  { id: 'ag_x', name: 'Codex', backend: 'codex', role: '工程师' },
  { id: 'ag_peer', name: 'Captain2', backend: 'claude', role: '队长', subordinates: ['ag_c'] },
  { id: 'ag_dcap', name: 'DshCap', backend: 'dsh', role: '队长', subordinates: [] }
]
const block = r(p.buildDelegationBlock(leader, team))
check(block.includes('<consult') && block.includes('可咨询的队长') && block.includes('Captain2'), '派发协议：咨询语法与可咨询队长名单')
check(!block.slice(block.indexOf('可咨询的队长')).includes('DshCap'), '派发协议：dsh 队长不进咨询名单')
check(block.slice(block.indexOf('可咨询的队长')).split('\n').slice(1).every((line) => line.startsWith('- ')), '派发协议：咨询名单之后只有名单条目（规则不会被读成名单项）')
const exampleCalls = delegate.parseDelegates(block)
check(exampleCalls.length === 1 && exampleCalls[0].to === '队员名', '派发协议：全文只有语法行一张完整示例标记（复述协议不会冒出别的派单）')
check(delegate.findUnmatchedDelegateOpens(block).length === 0, '派发协议：没有半截标记示例（复述不会产生残缺拒单）')
check(block.split('<delegate').length - 1 === 1, '派发协议：summary 用文字教（不再给第二个标记字样）')
check(p.REPORT_INLINE_MAX === delegate.REPORT_INLINE_MAX && block.includes(`${p.REPORT_INLINE_MAX} 字（回灌界）`), '单一发射点：协议里的回灌界 = 回灌组装用的 REPORT_INLINE_MAX')
check(block.includes(`只附前 ${p.CHILD_BACKGROUND_MAX} 字`), '单一发射点：背景截断上限写进协议（不再承诺「原文会附上」却静默截断）')
check(block.includes(p.ROUND_MARK) && block.includes(p.ROUND_OUTCOMES), '派发协议：round 标记与 outcome 三值定义同源')
check(block.includes('去重') && block.includes('改写指令'), '派发协议：说明相同派单会被去重、重派必须改写')
check(!block.includes('不含任何标记'), '派发协议：不再有「最终总结不含任何标记」与 round/review 的冲突说法')
check(p.buildDelegationBlock({ ...leader, subordinates: [] }, team) === '', '无队员不注入派发协议')

const shortChild = r(p.buildChildPrompt('改 src/a.ts', '领队任务原文'))
check(shortChild.includes('【背景') && !shortChild.includes('原文共'), '子任务提示：短原文不带截断标注')
const longChild = r(p.buildChildPrompt('改 src/a.ts', 'x'.repeat(2500)))
check(longChild.includes('原文共 2500 字') && longChild.includes(`只附前 ${p.CHILD_BACKGROUND_MAX} 字`), '子任务提示：长原文标注截断')
check(!p.buildChildPrompt('只读调查：x', '').includes('【背景'), '子任务提示：空背景不留空块')
check(shortChild.includes('执行中没有人回答你的提问'), '工程纪律：执行中无法提问，含糊时写明假设交还领队')
check(r(p.sharedWorkspaceInstruction('审一下')).includes('只读协作约定') && p.sharedWorkspaceInstruction('审一下').includes('不要修改、创建或删除文件'), '共享工作区只读约定')

const guide = (lines) => r(p.rejectHandlingGuide(lines))
const policy = guide(['to="A"：全链委派轮数预算已耗尽；不要原样重派'])
check(policy.includes('再派任何单都会被拒') && !policy.includes('改派给名单里的队员') && !policy.includes('可以重派一次'), '拒因指引：预算类只给「不能再派」，不给无关分支')
const notMine = guide([`to="Ghost"：不在你的队员名单里${p.DELEGATE_REJECT_EXCERPT_MARK}做 A）`])
check(notMine.includes('改派给名单里的队员') && notMine.includes('<consult>'), '拒因指引：非队员 → 改派/咨询')
const transient = guide(['to="Claude"：worktree 建立失败，请稍后重派——Filename too long'])
check(transient.includes('可以重派一次') && transient.includes('必须改写指令'), '拒因指引：环境性失败 → 可重派一次但必须改写（与去重机制一致）')
const brokenOverBudget = guide(['to="X"：标记残缺（缺 </delegate> 闭合或闭合损坏），未建单——委派轮数预算已耗尽'])
check(brokenOverBudget.includes('再派任何单都会被拒') && !brokenOverBudget.includes('开、闭标签都完整'), '拒因指引：残缺+预算按预算处理（不引导重写后再撞护栏）')
const excerptNoise = guide([`to="Ghost"：不在你的队员名单里${p.DELEGATE_REJECT_EXCERPT_MARK}分析“全链委派轮数预算已耗尽”）`])
check(!excerptNoise.includes('再派任何单都会被拒'), '拒因指引：被拒指令摘录里的字样不参与分类')
check(r(p.buildRejectionFeedbackPrompt(['to="Ghost"：不在你的队员名单里'], 'Claude（claude）')).includes('没有被执行') && p.buildRejectionFeedbackPrompt(['x'], 'r').includes(p.ROUND_MARK), '拒单兜底回灌：钉住的原文 + 评估标记')
check(r(p.buildRejectNotice(['to="Ghost"：不在你的队员名单里'], 'Claude（claude）')).includes('不存在「在途」'), '捎带拒单：不存在在途')

const normal = r(p.nextStepInstruction('normal'))
const final = r(p.nextStepInstruction('final'))
check(normal.includes('<review of=') && normal.includes('审核结论') && normal.startsWith('【下一步】') && !normal.includes('不要再输出派发标记'), '下一步（常规）：评估 → 审核 → 继续')
check(final.includes('不要再输出派发标记') && final.includes('审核结论') && final.includes('列为未完成'), '下一步（预算收尾）：审核 fail 不再说「下一轮改派」')
check(p.nextStepInstruction('rejects').includes('按上面的拒因改派'), '下一步（带拒单）：指回拒因指引')
check(delegate.parseReviews(normal).length === 0, '下一步：审核示例标记不会被解析成真实审核（verdict 取值占位）')
const feedback = r(p.buildReportFeedback('### 队员 A 的结果（done，单号 #1）\nok', ''))
check(feedback.startsWith(p.REPORT_PROMPT_HEADER) && !feedback.includes('预算收尾'), '常规回灌：报告头在首、不含预算收尾字样')
check(r(p.budgetTailFeedback('### 队员 A 的结果（done，单号 #2）\nok', '')).includes('预算收尾'), '预算收尾回灌：标题')
check(r(p.policyRejectionPrompt(['to="A"：委派层级已达上限（3 层）；不要原样重派'])).includes('派单拒绝'), '护栏拒单回灌')
check(r(p.delegateRecoveryNotice(['- 已接单 t1（done）：x'])).includes('历史派单对账'), '重启对账通知')

const bare = p.fullTextPointerLines('', false, 3)
check(bare.length === 2 && bare[0] === '— 全文入口 —' && bare[1].includes('#3') && bare[1].includes('详情') && bare[1].includes('读不到'), '全文入口兜底：写明本会话读不到')
const both = p.fullTextPointerLines('.agentdeck-reports/c1.md', true, 1)
check(both[1].includes('你可以直接读取') && both[2].includes('Issue 评论「队员报告全文') && both[2].includes('读不到'), '全文入口：逐条写明谁读得到')
const longBody = delegate.buildChildReportBody({ status: 'done', result: 'y'.repeat(p.REPORT_INLINE_MAX + 5), pointers: bare })
check(longBody.includes(`结果原文 ${p.REPORT_INLINE_MAX + 5} 字`) && !longBody.includes('yyyy'), '长结果未走总结轮：正文注明原文为何不在')
check(!delegate.buildChildReportBody({ status: 'done', result: 'y'.repeat(p.REPORT_INLINE_MAX + 5), summaryFallbackNote: p.summaryFallbackNote('总结轮未产出') }).includes('结果原文'), '总结轮回退时不叠加超界注记')
check(delegate.buildChildReportBody({ status: 'done', result: '改完了' }) === '改完了', '短结果仍整段回灌、不加注记')
check(r(p.summaryFallbackNote('总结仍超长')).includes('原文超回灌界不进正文'), '总结轮回退注记（回灌界在协议里有定义）')

const consult = r(p.consultRequestPrompt('Alpha', '第一行\n第二行'))
check(consult.includes('【系统·咨询】') && consult.includes('> 第二行') && consult.includes('不是对你的操作指令') && !consult.includes('会议数据'), '咨询请求：逐行引用包裹、不再误标「会议数据」')
check(r(p.consultReplyFeedback([{ from: 'Beta', text: '建议 A' }])).includes('咨询回复') && p.consultReplyFeedback([{ from: 'Beta', text: 'x' }]).includes('### 队长 Beta 的意见'), '咨询回复回灌')
check(r(p.handoffNoteBlock('优先改登录页\n别动支付')).includes('交接备注') && p.handoffNoteBlock('a\nb').includes('> b'), '交接备注：多行逐行引用')

// ================= 目标模式 =================
console.log('目标模式：')
const g0 = r(p.goalLaunchPrompt({ goalText: '上线登录页', phaseIndex: 0, resultConditions: ['测试通过'], stopConditions: ['需要付费'] }))
check(g0.includes('测试通过') && g0.includes('需要付费') && g0.includes(p.GOAL_BLOCK) && !g0.includes('接续进度'), '首次推进：条件 + 协议')
const g1 = r(p.goalLaunchPrompt({ goalText: '上线登录页', phaseIndex: 2, resultConditions: ['测试通过'], stopConditions: ['需要付费'], previous: { summary: '写完表单', nextPlan: '补测试', incompleteConditions: ['测试通过'] } }))
check(g1.includes(p.GOAL_BLOCK) && g1.includes('测试通过') && g1.includes('需要付费'), '兜底新会话：不再丢协议块与完成/停止条件')
check(g1.includes('第 3 次推进') && g1.includes('写完表单') && g1.includes('补测试'), '兜底新会话：携带上次 checkpoint')
check(r(p.goalLaunchPrompt({ goalText: 'x', phaseIndex: 1, resultConditions: ['c'], stopConditions: [], previous: null })).includes('没有留下 checkpoint'), '兜底新会话：没有 checkpoint 也如实说明')
check(!/[A-Za-z]{4,} [a-z]{3,} /.test(g1.replace(/```json|checkpoint|completedConditions|incompleteConditions|nextPlan|blockers|summary|action|no_action|failed|outcome|reason|round|continue|start|auto|parked/g, '')), '目标模式：续阶段不再切成英文')
check(p.GOAL_BLOCK.includes('所有其他代码块之后') && p.GOAL_BLOCK.includes('原文照抄进 blockers'), '协议块：checkpoint 位置与停止条件原文识别写明')
const recap = r(p.goalRoundRecap({ runCount: 2, summary: 's', incomplete: ['a、b 两项', 'c'], failures: 1, taskError: 'boom' }))
check(recap.includes(p.ROUND_MARK) && recap.includes(p.ROUND_OUTCOMES), '续轮回灌：round 标记附带取值定义（非领队也读得懂）')
check(recap.includes('照常按【目标模式】协议') && !recap.includes('完成条件全部达成时按【目标模式】协议输出 checkpoint'), '续轮回灌：每次推进都交 checkpoint（不再只在全部达成时）')
check(recap.includes('  - a、b 两项\n  - c') && recap.includes('自动续轮 1/2') && recap.includes('失败'), '续轮回灌：条件逐行列出（条件内含顿号也不歧义）')
const multi = '跑了：\n```bash\nnpm test\n```\n结论如下。\n```json\n{"summary":"done","completedConditions":["测试通过"],"incompleteConditions":[],"nextPlan":"","blockers":[]}\n```'
check(goal.parseCheckpoint(multi, ['测试通过'])?.summary === 'done', 'checkpoint 解析：前面有别的代码块也取到末尾的 checkpoint')
check(goal.parseCheckpoint('{"summary":"ok","completedConditions":["x"]}', ['x'])?.completedConditions.length === 1, 'checkpoint 解析：裸 JSON 照旧')
check(/[一-鿿]/.test(p.ambiguousCriterionQuestion('ac_1', '页面要快')) && /[一-鿿]/.test(p.AMBIGUITY_CLARIFY_FALLBACK), '澄清问题统一中文')

// ================= 阶段接力 / 系统回合 =================
console.log('阶段接力：')
check(p.CONTINUE_BLOCK.startsWith('【阶段接力') && p.CONTINUE_BLOCK.includes('阶段2：按 docs/plan.md §3 实现模型选择 UI；阶段1 已完成数据管道（commit 09a47a4'), '接力协议：标题前缀与示例指纹保持')
check(delegate.parseContinue(p.CONTINUE_BLOCK).length === 0 && delegate.parseContinue(`复述：\n${p.CONTINUE_BLOCK}\n好的`).length === 0, '接力协议：整块复述不会触发接力')
check(p.CONTINUE_BLOCK.split('<continue').length - 1 === 1, '接力协议：全块只有带指纹的示例一处开标记（末尾锚定无从越过示例起算）')
check(!p.HANDOFF_CUE.includes('<continue') && !p.GOAL_BLOCK.includes('<continue'), '接力按钮指令/目标协议块不写标记字样（复述不产生越界起点）')
check(delegate.parseContinue(`${p.HANDOFF_CUE}\n好的。<continue start="auto">阶段2：按 docs/plan.md 实施 UI；阶段1 已完成数据层；验收：构建通过</continue>`)[0]?.brief.startsWith('阶段2：按 docs/plan.md 实施 UI'), '复述按钮指令后再输出真实标记：简报完整不被污染')
check(p.CONTINUE_BLOCK.includes('什么时候用') && p.CONTINUE_BLOCK.includes('怎么写'), '接力协议：按「何时用 / 怎么写」两段组织')
check(p.RETITLE_PROMPT.includes('重起一个简短标题') && p.RETITLE_PROMPT.includes('60 个字符') && p.RETITLE_PROMPT.includes('语言跟随'), '标题回合：中英文上限与语言')
check(p.HANDOFF_RECEIVE_CUE.includes('【系统·接力接收】') && p.HANDOFF_START_CONFIRMED_CUE.includes('【系统·手动启动确认】'), '接手/启动确认标题')
rendered.push(p.CONTINUE_BLOCK, p.HANDOFF_CUE, p.HANDOFF_RECEIVE_CUE, p.HANDOFF_START_CONFIRMED_CUE, p.RETITLE_PROMPT)

// ================= 会议 =================
console.log('会议：')
const daily = ['<delegate>', '<consult>', '<round>', '<review>', '<continue>']
check(daily.every((mark) => p.meetingPriority([]).includes(mark)), '会议优先：日常协议标记逐一点名（不再用「等」）')
check(!p.meetingPriority([]).includes('<investigate') && p.meetingPriority(['Gamma']).includes('<investigate') && p.meetingPriority(['Gamma']).includes('Gamma'), '会议优先：只有名下有队员时才教 investigate，并列出可调查的人')
check(r(p.meetingPriority(null)).includes('不要发起调查') && !p.meetingPriority(null).includes('<investigate'), '会议优先（强制收束）：不许调查')
const report = r(p.reportPrompt('', 1, '议题', []))
check(report.includes('汇报轮') && report.includes(p.STANCE_MARK) && report.includes(p.STANCE_MEANING), '汇报轮：表态语法 + 表态对象定义')
const challenge = r(p.challengePrompt('', 1, '议题', p.meetingData('汇报原文'), ['Gamma']))
check(challenge.includes('质疑轮') && challenge.includes('<stance verdict=') && challenge.includes('<objection ref=') && challenge.includes('没有实质问题就不提') && challenge.includes('其余不写 priority'), '质疑轮：允许零反对 + priority 规则完整')
const defense = r(p.defensePrompt('', 1, '议题', p.meetingData('- obj_1 [a.ts:1] x'), [], ['Alpha', 'Beta']))
check(defense.includes('答辩轮') && defense.includes('"decisions"') && defense.includes('"actionItems"') && defense.includes('照抄') && defense.includes('Alpha、Beta'), '答辩轮：纪要 schema + ref 照抄 + owner 候选')
check(r(p.synthPrompt('', 1, '议题', p.meetingData('（本轮没有反对）'), [], ['Alpha'])).includes('综合轮'), '综合轮')
const forced = r(p.forcedSynthesisPrompt('', '会议轮数预算耗尽', p.meetingData('{}'), ['Alpha']))
check(forced.includes('强制综合') && forced.includes('会议优先') && forced.includes(p.ENVELOPE_SCHEMA) && forced.includes('resolved=false'), '强制综合：补上会议优先与完整纪要 schema')
check(!forced.includes('<investigate') && forced.includes('不需要表态标记'), '强制综合：不许调查、不要求未消费的表态')
const office = r(p.officeSessionPrompt('Alpha'))
check(office.includes('办公室会话') && office.includes('Alpha') && office.includes('不派发工作') && !office.includes('你的定位'), '办公室引导：只说会话用途（人设由 buildAgentPrompt 注入一次）')
check(sessions.isOfficeTask({ dedupeKey: 'office_ag_x' }) && !sessions.isOfficeTask({ dedupeKey: 'goal_1:phase_0' }) && !sessions.isOfficeTask({}), '办公室任务识别')
check(r(p.investigationTaskPrompt('查 a.ts 的调用方')).startsWith('只读调查：'), '调查子任务指令')
check(r(p.investigationFeedback([{ to: 'Gamma', text: 'fact' }])).includes('调查结果') && p.investigationFeedback([{ to: 'Gamma', text: 'x' }]).includes('表态标记'), '调查回灌：提醒原回合格式要求仍然有效')
check(r(p.actionItemTaskPrompt('补测试', ['覆盖率 80%', 'CI 绿'])).includes('验收条件：\n- 覆盖率 80%\n- CI 绿'), '行动项任务：验收条件逐条列出')

// ================= 锻造 =================
console.log('锻造：')
const prev = p.FORGE_SKILL_BODIES_PREVIOUS
check(prev.length === 4 && new Set(prev).size === 4 && !prev.includes(p.FORGE_SKILL_BODY), '历代正文 V1–V4 齐全、互不相同、不含现行版')
check(!p.FORGE_SKILL_BODY.includes('passRate') && ['<delegate>', '<consult>', '<investigate>', '<continue>', '<round>', '<review>'].every((m) => p.FORGE_SKILL_BODY.includes(m)), 'v5 正文：去掉 passRate、协议标记逐一点名')
check(p.FORGE_SKILL_MD.includes(`version: ${sharedForge.FORGE_SKILL_VERSION}`) && sharedForge.FORGE_SKILL_VERSION === 5, 'SKILL.md frontmatter 版本 = FORGE_SKILL_VERSION = 5')
const evalPrompt = r(p.buildEvaluatePrompt(p.FORGE_SKILL_BODY, { name: 'x', systemPrompt: 'y' }))
check(!evalPrompt.split('\n---\n').pop().includes('passRate'), '评测任务尾部重申不再要求 passRate')
check(r(p.buildDraftPrompt(p.FORGE_SKILL_BODY, '测试工程师', [''])).includes('问1 答：（留空）'), '生成任务：澄清回答留空的写法')
const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-forge-shared-'))
const skillFile = path.join(skills.skillsDir(shared), 'agent-crafter', 'SKILL.md')
const writeSkill = (version, body) => {
  fs.mkdirSync(path.dirname(skillFile), { recursive: true })
  fs.writeFileSync(skillFile, `---\nname: agent-crafter\ndescription: x\nversion: ${version}\n---\n\n${body}\n`)
}
prev.forEach((body, i) => {
  writeSkill(i + 1, body)
  forge.ensureForgeSkill(shared)
  check(fs.readFileSync(skillFile, 'utf8') === p.FORGE_SKILL_MD, `升级链：未编辑的 v${i + 1} 升到 v${sharedForge.FORGE_SKILL_VERSION}`)
})
writeSkill(3, `${prev[2]}\n\n（用户自己加的一行）`)
forge.ensureForgeSkill(shared)
check(fs.readFileSync(skillFile, 'utf8').includes('（用户自己加的一行）'), '升级链：用户编辑过的旧版不覆盖')
fs.rmSync(shared, { recursive: true, force: true })

// ================= 人设与渲染卫生 =================
console.log('人设与渲染卫生：')
check(!p.OPENCODE_PERSONA.includes('先问清') && p.OPENCODE_PERSONA.includes('交给领队'), 'OpenCode 人设：不再要求执行中追问')
check(!p.LEAD_PERSONA.includes('琐碎小事'), '领队人设：不复述派发协议（规则单点在派发协议）')
rendered.push(p.LEAD_PERSONA, p.CLAUDE_PERSONA, p.CODEX_PERSONA, p.OPENCODE_PERSONA, p.DSH_PERSONA, p.GOAL_BLOCK, p.FORGE_SKILL_BODY)
const dirty = rendered.filter((text) => /undefined|\[object Object\]|NaN|\$\{/.test(text))
check(dirty.length === 0, `渲染卫生：${rendered.length} 段渲染文本无 undefined/[object Object]/NaN/未展开的 \${}`)
check(rendered.every((text) => !/\n{3,}/.test(text)), '渲染卫生：没有连续空两行以上的拼接缝')

if (failures) {
  console.log(`\n❌ PROMPTS SMOKE FAILED（${failures} 项）`)
  process.exit(1)
}
console.log('\n✅ PROMPTS SMOKE PASSED')
