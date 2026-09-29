// 目标模式域提示词集中地：自动推进协议块、推进任务 prompt 组装（首次与兜底新会话同一构造器）、
// 同会话续轮回灌、规格歧义澄清问题。全部中文，与其余协议块同一语言。
// 纯文案模块：不 import electron；checkpoint 解析与状态机仍在 goal-controller.ts。
// 措辞约定与注入地图见 docs/PROMPTS.md。
import { ROUND_MARK, ROUND_OUTCOMES } from './delegation'

/**
 * 目标模式协议块：每个推进任务的首条消息都注入（首次推进与兜底新会话同一构造器）。
 * 与解析侧的契约：checkpoint 从任务最终结果解析（取最后一个可解析的 JSON 代码块）；
 * 停止条件按原文子串识别（summary + blockers），所以命中时必须照抄原文。
 */
export const GOAL_BLOCK = `【目标模式（自动推进协议）】
本任务在目标模式下运行：你的每次执行（一次"推进"）结束后，系统读取你的 checkpoint，自动发起下一次推进，直到全部完成条件达成，或命中停止条件、用完预算。
- checkpoint 写在本次推进最后一条回复的末尾，用 \`\`\`json 代码块包裹，放在所有其他代码块之后：
  {"summary":"本次推进摘要","completedConditions":["已达成的完成条件原文"],"incompleteConditions":["未达成的完成条件原文"],"nextPlan":"下一次推进的计划","blockers":["阻塞项，没有就给空数组"]}
- 派了队员的话，"最后一条回复"指处理完全部回灌、给出最终总结的那一条；派单的那条回复里不写 checkpoint。
- completedConditions 和 incompleteConditions 逐条照抄完成条件原文：不改写、不合并、不遗漏，每条只放进其中一个列表。
- 全部完成条件都达成时：completedConditions 填全部条件，incompleteConditions 给空数组，nextPlan 留空字符串，不再派单。
- 需要人来决定的事项写进 blockers，不要自己猜着执行；命中停止条件时，把该停止条件的原文照抄进 blockers（系统按原文识别）。
- 推进默认在当前会话里继续；只有确实到了需要换新会话的阶段边界，才按【阶段接力】输出接力标记。`

/** 推进任务 prompt 组装：首次推进与兜底新会话（phaseIndex>0，同会话续聊不可用时新建）同一结构——
 *  兜底会话看不到之前的上下文，因此同样携带完成/停止条件与 GOAL_BLOCK，并前置上次 checkpoint。 */
export function goalLaunchPrompt(input: {
  goalText: string
  phaseIndex: number
  resultConditions: string[]
  stopConditions: string[]
  previous?: { summary: string; nextPlan: string; incompleteConditions?: string[] } | null
}): string {
  const { goalText, phaseIndex, resultConditions, stopConditions, previous } = input
  const parts = [goalText.trim()]
  if (phaseIndex > 0) {
    const recap = previous ? [
      `- 摘要：${previous.summary || '（无）'}`,
      `- 计划：${previous.nextPlan || '（无）'}`,
      ...(previous.incompleteConditions?.length ? [`- 未达成的完成条件：\n${previous.incompleteConditions.map((c) => `  - ${c}`).join('\n')}`] : [])
    ].join('\n') : '- （上一次没有留下 checkpoint）'
    parts.push(`【接续进度】这是本目标的第 ${phaseIndex + 1} 次推进，运行在新会话里，看不到之前的对话。上一次推进的 checkpoint：\n${recap}\n请据此继续，不要从头重做。`)
  }
  parts.push(`完成条件（逐条对照推进，全部达成才算完成）：\n${resultConditions.map((condition) => `- ${condition}`).join('\n')}`)
  if (stopConditions.length) parts.push(`停止条件（命中任意一条就停下等待用户）：\n${stopConditions.map((condition) => `- ${condition}`).join('\n')}`)
  parts.push(GOAL_BLOCK)
  return parts.join('\n\n')
}

/** 同会话续轮回灌（自动续轮时注入）：上次 checkpoint + 下一次推进的步骤 */
export function goalRoundRecap(input: {
  runCount: number
  summary?: string
  incomplete: string[]
  nextPlan?: string
  blockers?: string[]
  failures: number
  taskError?: string
}): string {
  const { runCount, summary, incomplete, nextPlan, blockers, failures, taskError } = input
  const lines = [
    `【系统·目标模式】第 ${runCount} 次推进已结束，checkpoint 已记录。`,
    `- 摘要：${summary ?? '（本次没有 checkpoint）'}`,
    incomplete.length ? `- 未达成的完成条件：\n${incomplete.map((c) => `  - ${c}`).join('\n')}` : '- 未达成的完成条件：（无）'
  ]
  if (nextPlan) lines.push(`- 上次定下的计划：${nextPlan}`)
  if (blockers?.length) lines.push(`- 阻塞：${blockers.join('；')}`)
  if (failures > 0) lines.push(`- 上一次推进失败：${taskError || '（原因未知）'}（自动续轮 ${failures}/2——连续失败到 2 次就终止本目标，不再自动续轮）`)
  lines.push(
    '请开始下一次推进：',
    `1. 第一行输出本次评估 ${ROUND_MARK}（${ROUND_OUTCOMES}）`,
    '2. 继续执行；你有可派发的队员时也可以派单。',
    '3. 本次推进结束时，照常按【目标模式】协议在最后一条回复末尾输出 checkpoint；全部完成条件都达成时按协议收尾。'
  )
  return lines.join('\n')
}

/** 验收标准仍含歧义时的逐条澄清问题（goals:evolve 返回给调用方，面向用户） */
export function ambiguousCriterionQuestion(id: string, text: string): string {
  return `验收标准 ${id} 仍有歧义，继续推进前请先澄清：${text}`
}

/** 没有可指向的具体标准时的兜底澄清问题 */
export const AMBIGUITY_CLARIFY_FALLBACK = '开始执行前，请先澄清目标的预期结果与约束条件'
