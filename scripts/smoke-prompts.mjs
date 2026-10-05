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
/** 标记属性值的占位符扫描：verdict="agree|disagree|abstain" 这种写法看着像值，模型会照抄，
 *  而解析器只认字面值、会静默丢弃整条标记。属性值里出现 | 一律视为缺陷。 */
const placeholderAttrs = (text) => [...text.matchAll(/<[a-z][^>]*?=[^>]*?\|[^>]*?\/?>/g)].map((m) => m[0])

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
// 机制说明（防把 CLI 自带 subagent/Task 的先验套到派单上）：位置在语法行之后、「写派单」之前，
// 五条边界逐条可查；回灌细则不在此复述（单一发射点仍在「写派单」的回灌规则行）
const mechAt = block.indexOf('不是你的子例程')
check(block.indexOf('</delegate>') < mechAt && mechAt < block.indexOf('写派单：'), '派发协议：机制说明位于派单语法行之后、「写派单」之前')
check(['不是你的子例程', '单向一次性', '回灌有界', '另一个 agent', '同一份上下文里的临时代劳'].every((s) => block.includes(s)), '派发协议：机制说明五条边界齐备（独立任务/单向一次/回灌有界/另一 agent/取舍）')
check(block.split('git 改动摘录').length - 1 === 1, '单一发射点：回灌细则全文只讲一次（机制说明只指路不复述）')
check(p.REPORT_INLINE_MAX === delegate.REPORT_INLINE_MAX && block.includes(`${p.REPORT_INLINE_MAX} 字（回灌界）`), '单一发射点：协议里的回灌界 = 回灌组装用的 REPORT_INLINE_MAX')
check(block.includes(`只附前 ${p.CHILD_BACKGROUND_MAX} 字`), '单一发射点：背景截断上限写进协议（不再承诺「原文会附上」却静默截断）')
check(block.includes(p.ROUND_MARK) && block.includes(p.ROUND_OUTCOMES), '派发协议：round 标记与 outcome 三值定义同源')
// round 三值必须与渲染层的显示映射对齐：ROUND_OUTCOMES 是文字列举（不写 | 占位符），
// 渲染层 ROUND_LABEL 是权威映射表。两边漂移时，合法值会显示成原样英文（用户看到 action 而非「已行动」）。
{
  const markdown = fs.readFileSync(path.join(root, 'src/renderer/src/components/Markdown.tsx'), 'utf8')
  const labelBlock = markdown.match(/const ROUND_LABEL[^=]*=\s*\{([^}]*)\}/)?.[1] ?? ''
  const labeled = [...labelBlock.matchAll(/([a-z_]+)\s*:/g)].map((m) => m[1]).sort()
  // 三值从示例标记 + 取值说明里抽取，而不是另抄一份常量（另抄一份就测不出漂移）
  const sample = p.ROUND_MARK.match(/outcome="([a-z_]+)"/)?.[1] ?? ''
  const stated = [...p.ROUND_OUTCOMES.matchAll(/\b(action|no_action|failed)\b/g)].map((m) => m[1])
  const three = [...new Set([sample, ...stated])].sort()
  check(three.length === 3 && three.join(',') === 'action,failed,no_action', `round 三值恰好三个：${three.join('/')}`)
  check(labeled.join(',') === three.join(','), `round 三值与渲染层 ROUND_LABEL 对齐（${labeled.join('/') || '未取到映射'}）`)
  check(delegate.parseRoundNotes(`${p.ROUND_MARK}`).length === 1, 'round 示例标记可被解析器认下（示例给的是合法实例）')
}
check(block.includes('去重') && block.includes('改写指令'), '派发协议：说明相同派单会被去重、重派必须改写')
check(!block.includes('不含任何标记'), '派发协议：不再有「最终总结不含任何标记」与 round/review 的冲突说法')
check(p.buildDelegationBlock({ ...leader, subordinates: [] }, team) === '', '无队员不注入派发协议')
// 稀疏建树（可选）小节（WORKTREE-BIG-REPO-PERF §7.1）：sparse 属性只文字示范属性名与取值形态，
// 不给第二个 <delegate 字样、不给带尖括号的完整标签（上方 parseDelegates/split 断言已覆盖该红线）
check(block.includes('【稀疏建树（可选）】') && block.includes('sparse="目录1/子目录,目录2"'), '派发协议：稀疏建树小节存在（属性文字示范，缺省全量）')
check(block.indexOf('【稀疏建树（可选）】') > block.indexOf('写派单：') && block.indexOf('【稀疏建树（可选）】') < block.indexOf('何时派单：'), '派发协议：稀疏建树小节位于「写派单」之后、「何时派单」之前')

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
// 审核示例给的是合法实例：解析器认得出（示例必须可解析，否则模型照抄即失效）。
// 反向对照：写成 | 占位符时解析器直接丢弃整条——这正是示例不能写占位符的原因。
check(delegate.parseReviews('<review of="#单号" verdict="pass|fail" note="x"/>').length === 0, '下一步：占位符写法的审核标记会被解析器丢弃（所以示例必须给合法值）')
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
check(recap.includes('最后一条回复末尾输出 checkpoint') && recap.includes('completedConditions') && !recap.includes('完成条件全部达成时按【目标模式】协议输出 checkpoint'), '续轮回灌：每次推进都交 checkpoint（本地给出最小字段提示，不再只在全部达成时）')
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
// 主动性钩子：该交接时不交接的故障形态是 agent 从不主动判断有无后续阶段、做完就停。
// 固化三段措辞（检查动作、两种处置），并钉住位置——必须在保守默认句之前（列表开头）。
check(p.CONTINUE_BLOCK.includes('先主动检查是否还有后续阶段') &&
  p.CONTINUE_BLOCK.includes('有明确后续阶段，就在收尾回复的最后一行交接') &&
  p.CONTINUE_BLOCK.includes('没有后续阶段、或任务原文根本没提分阶段，就正常收尾，不输出任何标记'),
  '接力协议：收尾前主动检查后续阶段（检查动作 + 有/无后续阶段两种处置的措辞）')
check(p.CONTINUE_BLOCK.indexOf('先主动检查是否还有后续阶段') > -1 &&
  p.CONTINUE_BLOCK.indexOf('先主动检查是否还有后续阶段') < p.CONTINUE_BLOCK.indexOf('阶段进行中、拿不准要不要切会话'),
  '接力协议：主动性检查位于「什么时候用」列表开头（保守默认句之前）')
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
const defenseReview = r(p.reviewPrompt('', 1, '议题', p.meetingData('最新答辩'), ['Gamma'], 'defense'))
const finalReview = r(p.reviewPrompt('', 1, '议题', p.meetingData('最终纪要'), [], 'minutes'))
check(defenseReview.includes('答辩复核') && defenseReview.includes('解决提议') && defenseReview.includes('其他人无权替你关闭') && defenseReview.includes('Gamma'), '答辩复核：作者确认反对并保留只读调查能力')
check(finalReview.includes('最终纪要确认') && finalReview.includes('必须重新表态') && finalReview.includes('最终纪要'), '最终确认：针对真实纪要重新表态')
check(r(p.reportPrompt('', 2, '议题', [], p.meetingData('上一轮未决反对'))).includes('上一轮未决反对'), '后续汇报：注入前轮讨论，不能只重发议题')
const forced = r(p.forcedSynthesisPrompt('', '会议轮数预算耗尽', p.meetingData('{}'), ['Alpha']))
check(forced.includes('强制综合') && forced.includes('会议优先') && forced.includes(p.ENVELOPE_SCHEMA) && forced.includes('resolved=false'), '强制综合：补上会议优先与完整纪要 schema')
check(!forced.includes('<investigate') && forced.includes('不需要表态标记'), '强制综合：不许调查、不要求未消费的表态')
const office = r(p.officeSessionPrompt('Alpha'))
check(office.includes('办公室会话') && office.includes('Alpha') && office.includes('不派发工作') && !office.includes('你的定位'), '办公室引导：只说会话用途（人设由 buildAgentPrompt 注入一次）')
check(
  sessions.isOfficeTask({ officeAgentId: 'ag_x' }) &&
  // 判据只认创建侧写入的 officeAgentId：键形是用户可构造的（requestId/idempotencyKey 会成为 dedupeKey）
  !sessions.isOfficeTask({ agentId: 'ag_x', dedupeKey: 'office_ag_x' }) &&
  !sessions.isOfficeTask({ dedupeKey: 'goal_1:phase_0' }) &&
  !sessions.isOfficeTask({}),
  '办公室任务识别：只认 officeAgentId（用户任务自命 office_ 键形也不被误判）'
)
check(
  sessions.isOfficeTask({ officeAgentId: 'ag_x' }) &&
  !sessions.isOfficeTask({ agentId: 'ag_lead', dedupeKey: 'office_ag_x' }),
  '办公室任务识别：键形与 agentId 不匹配的旧键同样不被误判（旧单由迁移补字段）'
)
check(r(p.investigationTaskPrompt('查 a.ts 的调用方')).startsWith('只读调查：'), '调查子任务指令')
check(r(p.investigationFeedback([{ to: 'Gamma', text: 'fact' }])).includes('调查结果') && p.investigationFeedback([{ to: 'Gamma', text: 'x' }]).includes('表态标记'), '调查回灌：提醒原回合格式要求仍然有效')
check(r(p.actionItemTaskPrompt('补测试', ['覆盖率 80%', 'CI 绿'])).includes('验收条件：\n- 覆盖率 80%\n- CI 绿'), '行动项任务：验收条件逐条列出')

// ================= 示例回灌真实解析器 =================
// 只断言「文案包含常量」是恒真检查：常量与文案同源。这里把 prompt 里实际渲染出的标记
// 抠出来喂给真实解析器——解析器认不认，才是这条契约的验收口径。
console.log('示例回灌解析器：')
const meeting_mod = await bundle('src/main/meeting-controller.ts', 'meeting-controller.cjs')

// 审核：报告里给的示例标记必须被 parseReviews 认下（of 必须形如 #数字）
const reviewExample = normal.match(/<review of="#1"[^>]*\/>/)?.[0] ?? ''
check(!!reviewExample && delegate.parseReviews(reviewExample).length === 1, `审核示例标记可被解析：${reviewExample}`)
check(delegate.parseReviews(reviewExample)[0].verdict === 'pass', '审核示例 verdict 取合法值')
check(delegate.parseReviews('<review of="#单号" verdict="pass|fail" note="x"/>').length === 0, '对照：占位符写法的审核标记确实解析不通过（所以示例必须给实例）')

// 表态：会议每一类发言渲染出的实例必须被 parseStance 认下，且处于最后一行
for (const [name, text] of [['汇报轮', report], ['质疑轮', challenge], ['答辩轮', defense], ['答辩复核', defenseReview], ['最终纪要确认', finalReview], ['综合轮', r(p.synthPrompt('', 1, '议题', p.meetingData('x'), [], ['Alpha']))]]) {
  const line = text.trim().split('\n').pop() ?? ''
  const stance = meeting_mod.parseStance(text)
  check(!!stance && line.startsWith('<stance'), `${name}：渲染出的末行表态可被解析（${stance?.verdict ?? 'null'}）`)
}

// 反对：质疑轮的示例标记可被 parseObjections 认下（ref 非空）
const objectionExample = challenge.match(/<objection [^>]*>[^<]*<\/objection>/)?.[0] ?? ''
check(!!objectionExample && meeting_mod.parseObjections(objectionExample, 'critic').length === 1, `反对示例标记可被解析：${objectionExample}`)

// 纪要：答辩/综合/强制综合**实际渲染出**的 JSON 实例必须过 parseEnvelope 的字段校验。
// 从渲染文本里抠（而不是直接 JSON.parse 常量）：常量与文案同源，只断言常量是恒真检查。
const envelopeOf = (text) => {
  const block = text.match(/```json\s*([\s\S]*?)```/)?.[1]
  if (block) return block.trim()
  return text.match(/\{"decisions"[\s\S]*?\}/)?.[0] ?? ''
}
const renderedInstances = [['答辩轮', defense], ['综合轮', r(p.synthPrompt('', 1, '议题', p.meetingData('x'), [], ['Alpha']))], ['强制综合', forced]]
for (const [name, text] of renderedInstances) {
  const instance = envelopeOf(text)
  const parsed = instance ? meeting_mod.parseEnvelope(instance) : null
  check(!!instance && parsed !== null, `${name}：渲染出的纪要实例可被 parseEnvelope 接受`)
  // 空数组实例：照抄不会往纪要里塞假条目（示例反对会被 mergeEnvelopeObjections 登记成真反对）
  check(!!parsed && parsed.objections.length === 0 && parsed.actionItems.length === 0 && parsed.decisions.length === 0 && parsed.openQuestions.length === 0,
    `${name}：示例是空骨架，照抄不产生假纪要条目`)
}
check(renderedInstances.every(([, text]) => text.includes(p.ENVELOPE_FIELDS)), '纪要字段形状用文字说明（不靠示例内容教学）')
check(meeting_mod.parseEnvelope(JSON.stringify({ decisions: ['x'], objections: [{ text: 't', ref: 'r', resolved: true }], actionItems: [{ title: 'a', owner: 'Alpha', acceptance: ['ok'] }], openQuestions: [] })) !== null, '纪要最小合法实例可被接受')
// 字段在场却类型错误必须整体拒绝：宽容成空集会把 `{}` 带进 minutesFromRound 的 .map()，
// 在轮次异常兜底之外抛错，留下 active 却无调度器的僵尸会议（审码判官 P1 复现）
check(meeting_mod.parseEnvelope(JSON.stringify({ decisions: [], objections: {}, actionItems: [], openQuestions: [] })) === null, 'object-valued objections field is rejected, not coerced to empty')
check(meeting_mod.parseEnvelope(JSON.stringify({ decisions: [], actionItems: 'none', openQuestions: [] })) === null, 'string-valued actionItems field is rejected')
check(meeting_mod.parseEnvelope(JSON.stringify({ decisions: [], openQuestions: 7 })) === null, 'number-valued openQuestions field is rejected')
check(meeting_mod.parseEnvelope(JSON.stringify({ decisions: [] })) !== null, 'absent optional fields still default to empty sets')

// 接力：协议示例带指纹，复述不触发；显式 auto 且非示例的简报才触发
const continueExample = p.CONTINUE_BLOCK.match(/<continue start="auto">[\s\S]*?<\/continue>/)?.[0] ?? ''
check(!!continueExample && delegate.parseContinue(continueExample).length === 0, '接力示例（带指纹）即使位于末尾也不触发')
check(delegate.parseContinue('<continue start="auto">阶段2：按 docs/plan.md 实施 UI；阶段1 已完成数据层；验收：构建通过</continue>').length === 1, '真实接力简报仍可触发')
// 遗留反例（parseContinue）：agent 正文先出现开标记、末尾才写真实标记。修复前末尾锚定
// 从第一个开标记起算，简报会把「我会输出 <continue…> 标记」连同中间正文一起拼进去。
const nestedContinue = '<continue start="auto">我会输出 <continue start="auto"> 标记</continue>\n中间的讨论正文。\n<continue start="auto">阶段2：按 docs/plan.md 实施 UI；阶段1 已完成数据层；验收：构建通过</continue>'
const nestedParsed = delegate.parseContinue(nestedContinue)[0]
check(!!nestedParsed && nestedParsed.start === 'auto' && nestedParsed.brief === '阶段2：按 docs/plan.md 实施 UI；阶段1 已完成数据层；验收：构建通过', '接力反例（正文先出现开标记）：简报只取末尾真实标记那段，不含中间正文')

// ================= 办公室身份端到端 =================
// P1 回归：公开建单入口允许自定义 requestId/idempotencyKey，它们会成为 dedupeKey。
// 用户任务因此可以自称 office_*——那不该让它被当成办公室会话（跳过派发协议、忽略派单）。
console.log('办公室身份：')
{
  const [{ TaskService }, { TaskStore }] = await Promise.all([
    bundle('src/main/task-service.ts', 'task-service.cjs'),
    bundle('src/main/store.ts', 'store.cjs')
  ])
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-office-identity-'))
  const store = new TaskStore(dir)
  const service = new TaskService({ store })
  // 旧键形（office_<id>）被用户任务占用：这正是修复前的碰撞场景。用户任务不带 officeAgentId，
  // 所以它永远不是办公室会话；办公室会话必须**另建**而不是复用这张用户单。
  const impersonator = service.createTask({ title: '用户任务', prompt: '干活', backend: 'zcode', agentId: 'ag_lead', requestId: `${sessions.OFFICE_TASK_KEY_PREFIX}ag_lead` })
  check(!sessions.isOfficeTask(impersonator), '用户任务用 requestId 自称 office_* 也不会被误判为办公室会话')

  const registryBundles = await bundle('src/main/agent-sessions.ts', 'agent-sessions-v2.cjs')
  const agents = [
    { id: 'ag_lead', name: 'Lead', backend: 'zcode', role: '领队', subordinates: ['ag_c'] },
    { id: 'ag_c', name: 'Claude', backend: 'claude', role: '工程师' }
  ]
  const registry = new registryBundles.AgentSessionRegistry({
    store, taskService: service, getAgents: () => agents,
    // enqueue 推到终态：ensure() 会等首回合结束，空实现会让它一直等到超时
    runner: {
      enqueue: (task) => { store.update(task.id, { status: 'done' }) },
      followUp: async () => ({ ok: true, finalText: '' })
    }
  })
  // 同键直撞（P1 核心反例）：用户任务先占了 ag_lead 的新键形（requestId 是自由串，键形可被构造）。
  // 注册表查找 ag_lead 时必须绕开它——键形隔离只防误撞，身份核验才是这道闸。
  const v2Collide = service.createTask({ title: '同键用户任务', prompt: '干活', backend: 'zcode', agentId: 'ag_lead', requestId: sessions.OFFICE_TASK_KEY_V2_PREFIX + 'ag_lead' })
  check(service.deduped(sessions.OFFICE_TASK_KEY_V2_PREFIX + 'ag_lead')?.id === v2Collide.id, '同键直撞前提成立：用户任务确实占了 ag_lead 的新键')
  check(registry.get('ag_lead') === null, 'P1 反例（同键直撞）：键被用户任务占用时 get() 不复用它（旧行为会返回用户单）')
  check(!sessions.isOfficeTask(v2Collide) && v2Collide.officeAgentId === undefined, '被占用的用户记录不被写入 officeAgentId（原样未动）')
  // 建单路径同样必须绕开占键记录（复审查出的漏洞）：ensure() 若沿用同一个键，
  // createTask 会"键命中即复用"、把这张用户单当办公室会话返回，核验形同虚设
  const ensured = await registry.ensure('ag_lead')
  check(ensured.id !== v2Collide.id, 'P1 反例（建单路径）：ensure() 不会复用占键的用户任务（改用备用键位另建）')
  check(sessions.isOfficeTask(ensured) && ensured.officeAgentId === 'ag_lead', 'P1 反例（建单路径）：新建的确实是该队长的办公室单')
  check(service.deduped(sessions.OFFICE_TASK_KEY_V2_PREFIX + 'ag_lead')?.id === v2Collide.id, '占键的用户记录保持原样（键未被改写）')
  check(registry.get('ag_lead')?.id === ensured.id, 'P1：备用键位的办公室单可被后续查找复用（会话不丢）')

  // 身份匹配时的正常复用（对照组）：换一位键未被占用的队长，注册表仍复用同一张办公室单
  const office = service.createTask({ title: 'Claude·办公室', prompt: '引导', backend: 'claude', agentId: 'ag_c', suppressIssue: true, officeAgentId: 'ag_c', dedupeKey: sessions.OFFICE_TASK_KEY_V2_PREFIX + 'ag_c' })
  check(sessions.isOfficeTask(office) && office.officeAgentId === 'ag_c', '注册表创建的真实办公室任务带 officeAgentId 并被识别')
  check(registry.get('ag_c')?.id === office.id, '对照组：身份匹配的办公室单被正常复用')
  check(office.id !== impersonator.id && office.id !== v2Collide.id, '办公室单与两张用户单都是不同记录')

  // 旧键形的历史办公室单：迁移（store.ts：旧键形 + 标题/suppressIssue + agentId ∈ 注册名册）
  // 补过 officeAgentId，注册表应收养它而不是另建。
  // 收养失败会让线上已存在的办公室会话被抛弃、续聊历史留在旧单——这是改键形的最大回归面。
  // 迁移的可信来源是 userDataDir/agents.json（TaskStore 构造时读）：测试环境显式落一份名册，
  // ag_lead 才算「注册表可能写过键位」的队长。
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-office-legacy-'))
  fs.writeFileSync(path.join(dir2, 'agents.json'), JSON.stringify(agents))
  const legacyStore = new TaskStore(dir2)
  const legacyService = new TaskService({ store: legacyStore })
  const legacyTask = legacyStore.create({ title: 'Lead·办公室', prompt: '引导', backend: 'zcode', agentId: 'ag_lead', suppressIssue: true, trigger: 'meeting' })
  legacyStore.update(legacyTask.id, { dedupeKey: sessions.OFFICE_TASK_KEY_PREFIX + 'ag_lead' })
  // 重开一次让 store 迁移按旧键形补 officeAgentId（迁移在建库时跑）
  const reopened = new TaskStore(dir2)
  const migrated = reopened.list().find((task) => task.id === legacyTask.id)
  check(migrated?.officeAgentId === 'ag_lead', '旧键形办公室单被迁移补上 officeAgentId')
  const legacyRegistry = new registryBundles.AgentSessionRegistry({
    store: reopened, taskService: new TaskService({ store: reopened }), getAgents: () => agents,
    // enqueue 把任务推到终态：ensure() 会等首回合结束，空实现会让它一直等到超时
    runner: {
      enqueue: (task) => { reopened.update(task.id, { status: 'done' }) },
      followUp: async () => ({ ok: true, finalText: '' })
    }
  })
  check(legacyRegistry.get('ag_lead')?.id === legacyTask.id, '旧键形的历史办公室单被收养（不另建、不丢续聊历史）')
  // get() 是只读查询：收养时不改键，键的改写留给有副作用的 ensure()
  check(reopened.get(legacyTask.id)?.dedupeKey === sessions.OFFICE_TASK_KEY_PREFIX + 'ag_lead', '只读 get() 不改写历史单的键（无副作用）')
  await legacyRegistry.ensure('ag_lead')
  check(reopened.get(legacyTask.id)?.dedupeKey === sessions.OFFICE_TASK_KEY_V2_PREFIX + 'ag_lead', 'ensure() 收养后键被改写为新键形')
  check(reopened.list().filter((task) => task.officeAgentId === 'ag_lead').length === 1, '收养不会另建第二张办公室单')

  // 遗留反例（迁移伪造）：三重键全部可由建单侧构造——requestId 会成为 dedupeKey、sidecar 的
  // suppressIssue 不受白名单约束。修复前这张单重开即被补写 officeAgentId，进而被 legacyLookup
  // 收养成队长的办公室会话。现在迁移还要求 agentId 在注册名册里：ag_peer 是队长，但不在
  // dir2 的 agents.json 名册里，不得补写。
  const forged = legacyService.createTask({ title: 'Peer·办公室', prompt: '引导', backend: 'claude', agentId: 'ag_peer', suppressIssue: true, requestId: sessions.OFFICE_TASK_KEY_PREFIX + 'ag_peer' })
  const reforged = new TaskStore(dir2).list().find((task) => task.id === forged.id)
  check(reforged?.officeAgentId === undefined, '迁移伪造反例：键形/标题/suppressIssue 齐备但 agentId 不在注册名册，不补写 officeAgentId')
  fs.rmSync(dir2, { recursive: true, force: true })

  // 咨询受理边界：发起人的直属队员即便顶着队长头衔也不可被咨询（与 buildDelegationBlock 同一名单）
  const captains = [
    { id: 'ag_lead', name: 'Lead', backend: 'zcode', role: '领队', subordinates: ['ag_sub'] },
    { id: 'ag_sub', name: 'SubCap', backend: 'zcode', role: '队长', subordinates: [] },
    { id: 'ag_peer', name: 'Peer', backend: 'claude', role: '队长', subordinates: [] },
    // 非中文定位的队长：曾同时出现在展示名单里、却被受理层拒绝（判据两处各写一份的漂移）
    { id: 'ag_cap', name: 'Cap', backend: 'claude', role: 'captain', subordinates: [] }
  ]
  const consultRegistry = new registryBundles.AgentSessionRegistry({
    store, taskService: service, getAgents: () => captains,
    runner: { enqueue: (task) => { store.update(task.id, { status: 'done' }) }, followUp: async () => ({ ok: true, finalText: '' }) }
  })
  check(consultRegistry.resolve('Peer', 'ag_lead')?.id === 'ag_peer', '咨询受理：非直属的队长可被咨询')
  check(consultRegistry.resolve('Cap', 'ag_lead')?.id === 'ag_cap', '咨询受理：非中文定位的队长（captain）同样可被咨询')
  check(consultRegistry.resolve('SubCap', 'ag_lead') === null, '咨询受理：直属队员顶着队长头衔也不可被咨询')
  check(consultRegistry.resolve('Lead', 'ag_lead') === null, '咨询受理：发起人本人不可被咨询')
  check(consultRegistry.resolve('', 'ag_lead') === null, '咨询受理：空引用不误命中第一个队长')
  // 受理名单与展示名单必须同源：提示词里列出的可咨询队长，受理层一个都不能拒
  {
    const shown = p.buildDelegationBlock(captains[0], captains)
      .slice(p.buildDelegationBlock(captains[0], captains).indexOf('可咨询的队长'))
      .split('\n').slice(1).filter((line) => line.startsWith('- '))
      .map((line) => line.replace(/^- /, '').split('（')[0].trim())
    const rejected = shown.filter((name) => consultRegistry.resolve(name, 'ag_lead') === null)
    check(shown.length > 0 && rejected.length === 0,
      `咨询受理名单与提示词一致（展示 ${shown.join('/')}，被受理层拒绝：${rejected.join('/') || '无'}）`)
  }
  fs.rmSync(dir, { recursive: true, force: true })
}

// ================= 锻造 =================
console.log('锻造：')
// 期望的历代正文数量由版本号推导（V1..V(n-1)），版本升级后不误报：
// 按升级规则，第 n 版正文要带 n-1 份历史正文做比对基准
const prev = p.FORGE_SKILL_BODIES_PREVIOUS
check(prev.length === sharedForge.FORGE_SKILL_VERSION - 1 && new Set(prev).size === prev.length && !prev.includes(p.FORGE_SKILL_BODY),
  `历代正文共 ${sharedForge.FORGE_SKILL_VERSION - 1} 份（V1–V${sharedForge.FORGE_SKILL_VERSION - 1}）、互不相同、不含现行版`)
check(!p.FORGE_SKILL_BODY.includes('passRate') && ['<delegate>', '<consult>', '<investigate>', '<continue>', '<round>', '<review>'].every((m) => p.FORGE_SKILL_BODY.includes(m)), 'v5 正文：去掉 passRate、协议标记逐一点名')
check(p.FORGE_SKILL_MD.includes(`version: ${sharedForge.FORGE_SKILL_VERSION}`), `SKILL.md frontmatter 版本 = FORGE_SKILL_VERSION = ${sharedForge.FORGE_SKILL_VERSION}`)
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
const badAttrs = [...rendered, p.FORGE_SKILL_BODY].flatMap((text) => placeholderAttrs(text))
check(badAttrs.length === 0, `标记属性里没有 | 占位符（会被照抄成非法值）：${badAttrs.slice(0, 3).join(' / ') || '无'}`)

if (failures) {
  console.log(`\n❌ PROMPTS SMOKE FAILED（${failures} 项）`)
  process.exit(1)
}
console.log('\n✅ PROMPTS SMOKE PASSED')
