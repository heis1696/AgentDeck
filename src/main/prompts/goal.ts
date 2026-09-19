// 目标模式域提示词集中地：自动推进协议块、目标任务 prompt 组装（中英分支）、续轮回灌、歧义澄清指令。
// 纯文案模块：不 import electron；checkpoint 解析与状态机仍在 goal-controller.ts。

/** 目标模式协议块：首阶段任务注入，约定 checkpoint 输出与自动续轮语义 */
export const GOAL_BLOCK = `【目标模式（自动推进协议）】
本任务运行在目标模式下：每轮结束后系统会核对你的 checkpoint 并自动驱动你进入下一轮，直到全部完成条件达成。
- 每轮收尾时，在回复末尾输出一个 checkpoint JSON 代码块（用 \`\`\`json 包裹）：
  {"summary":"本轮摘要","completedConditions":["已达成的完成条件原文"],"incompleteConditions":["未达成的完成条件原文"],"nextPlan":"下一轮计划","blockers":["阻塞项，没有则空数组"]}
- completedConditions 与 incompleteConditions 必须逐条对照目标完成条件的原文填写：不改写、不合并、不遗漏。
- 全部完成条件达成的那一轮：completedConditions 一次性填入所有条件，nextPlan 留空，不再派发任何工作，直接收尾。
- 需要并行推进或依靠队员专长时，用 <delegate> 派发队员；队员结果回灌后，由你按回灌指令给出审核结论。
- 只有确需更换会话的阶段边界才使用 <continue>（简报必须自包含）；常规推进不要硬切会话。
- 遇到必须由人工决策的事项，或已命中停止条件时，如实写入 blockers，不要自行猜测执行。`

/** 目标任务 prompt 组装：首阶段（中文，注入 GOAL_BLOCK）/ 续阶段（英文，优先携带上轮 checkpoint） */
export function goalLaunchPrompt(input: {
  goalText: string
  phaseIndex: number
  resultConditions: string[]
  stopConditions: string[]
  previous?: { summary: string; nextPlan: string } | null
}): string {
  const { goalText, phaseIndex, resultConditions, stopConditions, previous } = input
  if (phaseIndex === 0) {
    return `${goalText}\n\n完成条件（逐条对照推进，全部达成才算完成）：\n${resultConditions.map((condition) => `- ${condition}`).join('\n')}${stopConditions.length ? `\n\n停止条件（命中任意一条即停下等待用户）：\n${stopConditions.map((condition) => `- ${condition}`).join('\n')}` : ''}\n\n${GOAL_BLOCK}`
  }
  if (previous?.nextPlan) {
    return `${goalText}\n\nCheckpoint summary from the last round:\n${previous.summary}\n\nNext plan drawn up last round (carry it out this round):\n${previous.nextPlan}`
  }
  return `${goalText}\n\nCompletion conditions (work through them one by one; the goal is complete only when every condition below is met):\n${resultConditions.map((condition) => `- ${condition}`).join('\n')}${stopConditions.length ? `\n\nStop conditions (hitting any one means halt and wait for the user):\n${stopConditions.map((condition) => `- ${condition}`).join('\n')}` : ''}`
}

/** 续轮回灌：上一轮 checkpoint 摘要 + 未完成条件 + 继续推进指令（自动续轮时注入） */
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
  let content = `【系统·目标模式】第 ${runCount} 轮已结束并记录 checkpoint。\n`
  content += `- 摘要：${summary ?? '（无 checkpoint）'}\n`
  content += `- 未完成条件：${incomplete.map((c) => `${c}`).join('、')}\n`
  if (nextPlan) content += `- 上一轮下一步计划：${nextPlan}\n`
  if (blockers?.length) content += `- 阻塞：${blockers.join('、')}\n`
  if (failures > 0) content += `- 上一轮失败原因：${taskError || '（未知）'}（自动续轮 ${failures}/2）\n`
  content += `请继续推进目标：先输出一行 <round outcome="..." reason="..."/> 自评，再继续执行或派发；完成条件全部达成时按【目标模式】协议输出 checkpoint 收尾。`
  return content
}

/** 验收标准仍含歧义的逐条澄清指令（英文——goal 域澄清通道为英文文案） */
export function ambiguousCriterionQuestion(id: string, text: string): string {
  return `Acceptance criterion ${id} still reads ambiguous; clarify it before any further work: ${text}`
}

/** 无可指向标准时的兜底澄清指令 */
export const AMBIGUITY_CLARIFY_FALLBACK = 'Clarify the goal outcome and its constraints before any execution begins'
