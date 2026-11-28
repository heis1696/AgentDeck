// AgentDeck 平台认知层（Host Framing）、MCP 模式瘦身协议文案与防自动压缩状态锚点。
// 全部为纯字符串/纯函数（不 import electron、不放解析器与业务逻辑）。
// 既有 Prompt 文本标记协议（delegation.ts / handoff.ts）保持完整零改动，作为非 MCP 后端与逃生开关的兜底通道。
import type { AgentLike } from '../delegate'
import {
  CHILD_BACKGROUND_MAX,
  REPORT_INLINE_MAX,
  REPORT_PROMPT_HEADER,
  isCaptainLike,
  rejectHandlingGuide
} from './delegation'

export type HostRoleKind = 'leader' | 'worker' | 'solo' | 'office'
export type HostWorkspaceKind = 'isolated-worktree' | 'shared-readonly' | 'main-workspace' | 'non-git'

export interface HostFramingInput {
  agent?: AgentLike
  team?: AgentLike[]
  roleKind: HostRoleKind
  workspaceKind: HostWorkspaceKind
  transport: 'mcp' | 'prompt'
  canHandoff?: boolean
  maxRounds?: number
  /** true（默认）时把【你的身份】人设并入本块（适合原生 systemPrompt 层与 MCP initialize.instructions）；
   *  false 时跳过人设，由 buildAgentPrompt 在首条消息注入，避免双份人设。 */
  includePersona?: boolean
}

function resolveSubordinates(agent: AgentLike | undefined, team: AgentLike[] | undefined): AgentLike[] {
  if (!agent?.subordinates?.length || !team?.length) return []
  return agent.subordinates
    .map((id) => team.find((candidate) => candidate.id === id))
    .filter((candidate): candidate is AgentLike => !!candidate)
}

function resolveConsultPeers(agent: AgentLike | undefined, team: AgentLike[] | undefined, subs: AgentLike[]): AgentLike[] {
  if (!agent || !team?.length) return []
  const subIds = new Set(subs.map((sub) => sub.id))
  return team.filter((candidate) => {
    if (candidate.id === agent.id || candidate.backend.toLowerCase() === 'dsh' || subIds.has(candidate.id)) return false
    return isCaptainLike(candidate)
  })
}

function workspaceContractText(kind: HostWorkspaceKind): string {
  switch (kind) {
    case 'isolated-worktree':
      return '你运行在 AgentDeck 分配的独占 git worktree 中：你的文件改动由平台在终态自动提交并合入集成分支，不会直接改写用户主工作区；引用代码位置一律使用仓库相对路径。'
    case 'shared-readonly':
      return '你运行在共享只读协作工作区中：只做代码检索、审阅与汇报，不要修改、创建或删除文件，也不要执行会改变工作区或 Git 状态的操作。'
    case 'main-workspace':
      return '你运行在任务指定的仓库工作区中；若派发写代码子单，平台会为队员创建独立隔离 worktree，并在全部完成后合入集成分支。'
    case 'non-git':
      return '当前工作目录不是 Git 仓库，任务直接在指定目录中执行。'
  }
}

function roleSummaryText(roleKind: HostRoleKind, agent?: AgentLike): string {
  const name = agent?.name ? `「${agent.name}」` : ''
  switch (roleKind) {
    case 'leader':
      return `你是 AgentDeck 协作团队中的领队${name}：负责拆解目标、判断哪些工作自己做、哪些派给名下队员并行执行、审核队员交付并产出最终结论。`
    case 'worker':
      return `你是 AgentDeck 领队派发出的独立执行队员${name}：专注完成分配给你的子任务并在本轮交付结果；执行中无人应答追问，遇到合理歧义请自行决策并在报告里写明假设。`
    case 'office':
      return `你正运行在队长${name}的 AgentDeck 办公室长期会话中：专门承接团队会议讨论与跨队长咨询；不执行日常派单或阶段接力。`
    case 'solo':
      return `你是 AgentDeck 托管任务中的独立执行者${name}：端到端完成任务并将清晰结果交付回看板与 Issue 时间线。`
  }
}

/**
 * 构建 AgentDeck 宿主运行环境声明（Host Framing）：
 * - 原生支持系统提示层的后端（claude/codex/dsh-acp）直接放入 system/developer prompt，免疫自动上下文压缩；
 * - MCP 后端同时写入 MCP `initialize.instructions`，在无 systemPrompt 入参的后端（如 zcode）上同样免疫压缩；
 * - 明确界定「CLI 原生工具/子代理 vs AgentDeck 团队协作」的互补分工，不阉割任何原生能力。
 */
export function buildHostFraming(input: HostFramingInput): string {
  const { agent, team, roleKind, workspaceKind, transport, canHandoff, maxRounds, includePersona = true } = input
  const subs = roleKind === 'leader' ? resolveSubordinates(agent, team) : []
  const peers = roleKind === 'leader' ? resolveConsultPeers(agent, team, subs) : []
  const sections: string[] = []

  const envLines = [
    '【运行环境：AgentDeck 本地多 Agent 协作派单平台】',
    '你当前不是在终端里与用户单机闲聊，而是运行在 AgentDeck 平台托管的一个独立任务（Task / Issue）中。',
    '- 平台外层负责任务看板、隔离 worktree、跨后端队员调度、结果汇总回灌、分支集成与跨重启持久留痕。',
    '- 你的最终回复会作为本轮交付物进入 AgentDeck 看板与上游（用户或领队），结束回复即表示本轮交付完成。',
    `- 当前角色：${roleSummaryText(roleKind, agent)}`,
    `- 工作区契约：${workspaceContractText(workspaceKind)}`
  ]
  sections.push(envLines.join('\n'))

  if (includePersona && agent) {
    const personaLines = [
      agent.role ? `你的定位：${agent.role}` : '',
      agent.systemPrompt?.trim() || ''
    ].filter(Boolean)
    if (personaLines.length) {
      sections.push(`【你的身份】\n${personaLines.join('\n')}`)
    }
  }

  const boundaryLines = [
    '【原生能力与 AgentDeck 协作的分工】',
    '- 你所属 CLI 自带的全部原生工具与内置子代理（本地文件读写、终端命令、检索工具、内置 subagent/Agent/Task 等）照常全力使用：适合在你自己的工作区内做代码探索、资料分析与单兵深挖。',
    '- 涉及调用 AgentDeck 团队里的其他成员（不同模型/不同 CLI 后端、各自独立隔离 worktree、结果落入看板并经审核合入集成分支）时，使用 AgentDeck 协作通道，不要用内置子代理替代团队派单。'
  ]
  sections.push(boundaryLines.join('\n'))

  if (transport === 'mcp') {
    const toolLines = [
      '【AgentDeck MCP 工具通道（不受上下文自动压缩影响）】',
      '- 本会话已挂载 AgentDeck 专属 MCP 工具（`agentdeck_*`），工具定义与权限按你的当前角色动态注入。',
      '- 若长对话触发自动压缩导致对当前身份、任务目标、队员分工或剩余预算拿不准，随时调用 `agentdeck_context` 取回权威上下文。'
    ]
    if (roleKind === 'leader' && subs.length > 0) {
      const rosterBrief = subs
        .map((sub) => `${sub.name}（${sub.backend}${sub.role ? '，' + sub.role : ''}${sub.sharedWorkspace ? '，只读共享' : ''}${sub.note ? '，' + sub.note : ''}）`)
        .join('；')
      toolLines.push(`- 可驱使队员：${rosterBrief}${maxRounds ? `（单领队轮数上限 ${maxRounds} 轮）` : ''}`)
      toolLines.push('- 派单请调用 `agentdeck_dispatch_worker`：工具会当场校验名单/防环/预算并异步建单入队；校验失败会立刻返回报错与有效名单供本回合直接改派。提交完本批所有派单后请直接结束当前回复，不要轮询等待，AgentDeck 会在全部子单终态后自动发起下一轮汇总回灌。')
      toolLines.push('- 收到队员结果回灌后：用 `agentdeck_submit_review` 审核 done 子单，用 `agentdeck_read_report` 按需翻阅超长报告全文，可选用 `agentdeck_record_round` 记录本轮评估。')
      if (peers.length > 0) {
        toolLines.push(`- 跨队长咨询（只要意见不派活）：可调用 \`agentdeck_consult_captain\`，对象：${peers.map((p) => `${p.name}（${p.backend}）`).join('、')}。`)
      }
    }
    if (canHandoff && roleKind !== 'worker' && roleKind !== 'office') {
      toolLines.push('- 分阶段长任务到达明确阶段边界、需要硬切新会话推进下一阶段时，调用 `agentdeck_handoff_phase` 登记自包含简报。')
    }
    sections.push(toolLines.join('\n'))
  }

  return sections.join('\n\n')
}

/** MCP 模式下的领队协作摘要（替代大段 XML 标记语法墙，仅讲业务边界与工具用法） */
export function buildMcpDelegationBlock(agent: AgentLike, team: AgentLike[]): string {
  const subs = resolveSubordinates(agent, team)
  if (!subs.length) return ''
  const roster = subs
    .map((a) => `- ${a.name}（${a.backend}${a.role ? '，' + a.role : ''}${a.sharedWorkspace ? '，只读协作：只检查汇报，不改动文件' : ''}${a.note ? '，' + a.note : '，专长未说明'}）`)
    .join('\n')
  const peers = resolveConsultPeers(agent, team, subs)
  const consultSection = peers.length
    ? `\n\n【队长间咨询（MCP 工具：agentdeck_consult_captain）】\n需要其他队长（不是你的队员）提供专业意见或复核时调用 \`agentdeck_consult_captain\`，只拿意见不派活；提交后结束本回合等待意见回灌。\n可咨询的队长：\n${peers.map((a) => `- ${a.name}（${a.backend}${a.role ? '，' + a.role : ''}）`).join('\n')}`
    : ''

  return `【你可驱使的队员】
${roster}

【AgentDeck MCP 派发约定】
需要队员并行协作或借助其他后端专长时，直接调用 \`agentdeck_dispatch_worker\` 工具（可同回合多次调用实现真并行，无需输出任何 XML 标签）：
- 派单创建的是独立持久任务：队员在独立隔离 worktree（只读协作队员共享你的工作区）中执行，改动经集成分支合入；通信单向一次性，已派出的单无法中途补话。
- 指令只写增量与仓库相对路径：系统会自动附带你的任务原文前 ${CHILD_BACKGROUND_MAX} 字作为背景，超长时把本单关键约束写进 \`prompt\`。
- 回灌规则：子单结果不超过 ${REPORT_INLINE_MAX} 字时整段回灌；超过时回灌 git 改动摘录，需要读完整报告时调用 \`agentdeck_read_report\`，预计结果很长且只需压缩结论时传 \`summary: true\`。
- 可选参数：大仓只触达明确目录时可传 \`sparse: ["目录1", "目录2"]\`；复杂任务可传 \`thinking\` 覆盖队员思考强度。
- 即时校验：工具会当场返回接单结果或具体拒因；若被拒单，可在本回合直接按提示改派或自己完成。
- 派完收尾：提交完本批所有派单后直接结束当前回复，不要轮询等待；全部子单终态后系统会自动开启下一轮回灌结果。
- 你的身份设定优先于本约定：琐碎小事自己做，身份设定排除的派发动作不做。${consultSection}`
}

/** MCP 模式下的阶段接力约定（无 XML 标记，统一调用 agentdeck_handoff_phase） */
export const MCP_CONTINUE_BLOCK = `【阶段接力（分阶段任务使用 · MCP 工具：agentdeck_handoff_phase）】
每完成一个阶段、在收尾之前，先主动检查是否还有后续阶段（查看任务原文分阶段描述、计划文档或简报阶段号）：
- 有明确后续阶段且当前阶段已完成时，调用 \`agentdeck_handoff_phase({ start: "auto" | "parked", brief, thinking? })\` 交接给新会话：\`brief\` 必须自包含（下一阶段目标、计划路径、本阶段成果与 commit、关键文件:行号、约束与验收标准）。
- 没有后续阶段、任务原文未分阶段、阶段进行中拿不准，或需要用户确认方案/提供凭据时，不要调用该工具，正常留在当前会话收尾。
- 仅在明确要求用户手动点击启动时才传 \`start: "parked"\`（并在回复里写明停在哪一阶段）；正常连续推进传 \`start: "auto"\`。`

/** MCP 模式下用户点「接力下一阶段」按钮时注入的合成指令 */
export const MCP_HANDOFF_CUE = '【系统】用户点了「接力下一阶段」按钮，确认进入下一阶段。请调用 `agentdeck_handoff_phase` 工具，传入 `start: "auto"` 与自包含的下一阶段简报 `brief`（下一阶段目标、方案或计划路径、本阶段成果与 commit、关键文件:行号、约束与验收）。如果确实没有明确的下一阶段，不要调用工具，直接说明原因。'

export interface TurnAnchorInput {
  agentName?: string
  roleLabel: string
  transport: 'mcp' | 'prompt'
  remainingRounds?: number
  subordinates?: AgentLike[]
  activeReportSeqs?: number[]
}

/**
 * 回合级轻量防压缩状态锚点（3 行以内）：
 * 附在回灌/续轮消息末尾，即便底层 CLI 刚触发自动上下文压缩，也能立即把角色、模式、剩余预算与可派名单重新锚进窗口。
 */
export function buildTurnAnchor(input: TurnAnchorInput): string {
  const parts: string[] = [
    `身份：${input.agentName ? `${input.agentName}（${input.roleLabel}）` : input.roleLabel}`,
    `协议：${input.transport === 'mcp' ? 'AgentDeck MCP（agentdeck_* 工具）' : 'AgentDeck 协议标记'}`
  ]
  if (typeof input.remainingRounds === 'number') {
    parts.push(`本链剩余委派轮数：${Math.max(0, input.remainingRounds)}`)
  }
  if (input.subordinates?.length) {
    parts.push(`可派队员：${input.subordinates.map((s) => `${s.name}(${s.backend}${s.sharedWorkspace ? '/只读' : ''})`).join('、')}`)
  }
  if (input.activeReportSeqs?.length) {
    parts.push(`本轮可审核/查阅单号：${input.activeReportSeqs.map((seq) => `#${seq}`).join('、')}`)
  }
  const tail = input.transport === 'mcp'
    ? '\n（若对话发生过自动压缩，可调用 `agentdeck_context` 获取完整平台角色与团队详情。）'
    : ''
  return `【AgentDeck 状态锚点】${parts.join(' ｜ ')}${tail}`
}

/** MCP 模式下的委派结果回灌（零 XML 语法，引导调用 agentdeck_submit_review / agentdeck_read_report / agentdeck_dispatch_worker） */
export function buildMcpReportFeedback(
  report: string,
  rejectNotice: string,
  opts: { mode?: 'normal' | 'rejects' | 'final'; anchor?: string } = {}
): string {
  const mode = opts.mode ?? (rejectNotice ? 'rejects' : 'normal')
  const header = mode === 'final'
    ? `${REPORT_PROMPT_HEADER}\n\n【预算收尾】委派轮数预算已用完；以下是循环结束前收编完成的队员结果，此后不再受理新派单。`
    : REPORT_PROMPT_HEADER
  const step3 = mode === 'final'
    ? '3. 委派轮数预算已用完：不要再调用 `agentdeck_dispatch_worker`。直接输出最终总结；审核为 fail 或未完成的工作，自己补做或在总结里列为未完成。'
    : mode === 'rejects'
      ? '3. 还有工作就调用 `agentdeck_dispatch_worker` 继续派单（包括按拒因改派），派完本批直接结束回复；确认没有遗留工作再输出最终总结。'
      : '3. 还有工作就调用 `agentdeck_dispatch_worker` 继续派单并在派完后直接结束回复；全部完成则直接输出最终总结。审核为 fail 的单需要改派、自己修复或在总结里列为未完成。'
  const next = [
    '【下一步】',
    '1. 对上面每个状态为 done 的子单调用 `agentdeck_submit_review({ seq, verdict: "pass" | "fail", note })` 给出审核结论（`seq` 取报告标题里的单号数字，如单号 #1 传 `1`）；需要阅读超长全文时调用 `agentdeck_read_report({ seq })`。',
    '2. 可选：调用 `agentdeck_record_round({ outcome: "action" | "no_action" | "failed", reason })` 记录本轮评估。',
    step3
  ].join('\n')
  return [header, `${report}${rejectNotice}`, next, opts.anchor ?? ''].filter(Boolean).join('\n\n')
}

/** MCP 模式下的兜底拒单回灌（仅当异步或回合末扫尾出现未同步送达的拒单时使用） */
export function buildMcpRejectionFeedbackPrompt(rejectLines: string[], rosterText: string, anchor?: string): string {
  const body = `【系统】以下派单没有被执行，队员没有收到任何指令：\n${rejectLines.map((r) => `- ${r}`).join('\n')}\n\n` +
    `${rejectHandlingGuide(rejectLines)}\n你的队员名单：${rosterText || '（空，无人可派）'}\n\n` +
    '【下一步】按拒因处理：调用 `agentdeck_dispatch_worker` 改派、自己完成，或在最终总结里列为未完成；可选调用 `agentdeck_record_round` 留痕。'
  return anchor ? `${body}\n\n${anchor}` : body
}

/** MCP 模式下的政策护栏早退回灌 */
export function buildMcpPolicyRejectionPrompt(rejectLines: string[], anchor?: string): string {
  const body = `【系统·派单拒绝】以下派单都没有建单：\n${rejectLines.map((r) => `- ${r}`).join('\n')}\n` +
    '本任务已达到委派上限（层级或轮数），之后的派单都不会被受理，不要再调用 `agentdeck_dispatch_worker`。请直接输出当前工作结论：被拒的工作自己完成，或在结论里列为未完成。'
  return anchor ? `${body}\n\n${anchor}` : body
}
