// AgentDeck 纯 Node 零依赖 Per-Run MCP Server（Streamable HTTP，JSON-RPC 2.0）。
// 严守主进程热更链路零运行时 npm 依赖：仅使用 node:http / node:crypto。
//
// 安全与隔离契约：
// - 只监听 127.0.0.1:0（OS 临时回环端口），绝不对外网卡暴露；
// - 每个 Run 签发 32 字节随机 Bearer Token，以 SHA-256 + timingSafeEqual 校验；
// - Run 结束、取消或换手后立即吊销 Token，拒绝迟到/越权调用；
// - tools/list 按任务角色、会议回合、预算与暂停态动态生成，绝不越权暴露工具；
// - 所有工具均为短平快同步返回（派单只校验+异步入队，严禁在 MCP tool call 内阻塞等子任务）。
import http from 'node:http'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { isThinkingLevel, type ThinkingLevel } from '../shared/types'
import type { AgentLike, ConsultCall, ContinueCall, DelegateCall, InvestigateCall, ReviewCall, RoundNote } from './delegate'
import type { HostRoleKind, HostWorkspaceKind } from './prompts/host'

const MAX_BODY_BYTES = 4 * 1024 * 1024
const DEFAULT_PROTOCOL_VERSION = '2025-03-26'
const MAX_REPORT_CHUNK_CHARS = 32_000
const DEFAULT_REPORT_CHUNK_CHARS = 8_000

/** 内部 MCP 工具名常量（单源定义，供 MCP Server、权限自动放行与冒烟测试共用） */
export const AGENTDECK_MCP_SERVER_NAME = 'agentdeck' as const
export const AGENTDECK_MCP_TOOLS = {
  context: 'agentdeck_context',
  dispatchWorker: 'agentdeck_dispatch_worker',
  submitReview: 'agentdeck_submit_review',
  readReport: 'agentdeck_read_report',
  recordRound: 'agentdeck_record_round',
  consultCaptain: 'agentdeck_consult_captain',
  investigate: 'agentdeck_investigate',
  handoffPhase: 'agentdeck_handoff_phase'
} as const

const INTERNAL_TOOL_NAMES = new Set<string>(Object.values(AGENTDECK_MCP_TOOLS))

/** 识别 AgentDeck 内部协作 MCP 工具名（各 CLI 命名前缀差异：mcp__agentdeck__* / agentdeck:* / 裸名），
 *  供非 yolo 模式的权限桥自动放行，避免领队派单/审核弹人工权限确认。 */
export function isAgentDeckMcpToolName(toolName: string): boolean {
  const normalized = toolName.trim().toLowerCase()
  if (!normalized) return false
  if (INTERNAL_TOOL_NAMES.has(normalized)) return true
  if (normalized.startsWith('mcp__agentdeck__') || normalized.startsWith('agentdeck__') || normalized.startsWith('agentdeck:') || normalized.startsWith('agentdeck/')) {
    return true
  }
  return false
}

export interface McpToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface McpToolCallOutcome {
  payload: Record<string, unknown>
  isError: boolean
}

export interface McpActiveReportEntry {
  seq: number
  childId: string
  worker: string
  title: string
  status: string
  fullText: string
  copyPath?: string
  reviewable: boolean
}

/** 单个回合内经 MCP 通道收集的结构化动作台账（回合末由 runner / runDelegationLoop 消费） */
export interface McpTurnActionSnapshot {
  reviews: Array<ReviewCall & { childId: string; seq: number }>
  roundNotes: RoundNote[]
  consults: ConsultCall[]
  investigates: InvestigateCall[]
  handoff: ContinueCall | null
}

/** 由 TaskRunner 注入给单个 Run 的 MCP 宿主上下文端口 */
export interface McpRunBinding {
  readonly taskId: string
  readonly runId: string
  /** 当前运行是否仍有效（防旧 Run 迟到调用） */
  isActive(): boolean
  /** 每次合法工具调用续命空闲看门狗 */
  onActivity?(): void
  /** 握手 initialize.instructions（宿主平台声明，免疫自动压缩） */
  getInstructions(): string
  /** 当前角色快照（动态读取，支持同 Run 跨回合变化） */
  getContextSnapshot(): {
    taskId: string
    title: string
    roleKind: HostRoleKind
    agent?: { id: string; name: string; backend: string; role?: string; systemPrompt?: string }
    workspaceKind: HostWorkspaceKind
    workdir: string
    subordinates: AgentLike[]
    consultPeers: AgentLike[]
    remainingRounds: number
    currentDepth: number
    maxDepth: number
    spawnsSuspended: boolean
    canConsult: boolean
    canInvestigate: boolean
    canHandoff: boolean
  }
  /** 异步派发子任务：内部复用 ChildSpawner，同步返回接单或具名拒因 */
  dispatchWorker(call: DelegateCall): Promise<
    | { ok: true; childId: string; worker: string; status: string; isolatedWorktree: boolean; deduplicated?: boolean }
    | { ok: false; error: string }
  >
  /** 审核已完成子单：立刻落看板状态 */
  submitReview(input: { childId: string; seq: number; verdict: 'pass' | 'fail'; note?: string }): { ok: true } | { ok: false; error: string }
  /** 记录领队本轮评估 */
  recordRound(note: RoundNote): void
  /** 校验阶段接力是否允许（防重复阶段或超接力链上限） */
  validateHandoff(call: ContinueCall): { ok: true } | { ok: false; error: string }
}

interface ActiveRunEntry {
  readonly taskId: string
  readonly token: string
  readonly tokenDigest: Buffer
  readonly sessionHeaderId: string
  binding: McpRunBinding
  /** 当前是否有活跃执行（idle 期设为 false，拒绝闲置调用但保留常驻会话 Token 供 followUp 重绑） */
  active: boolean
  activeReports: Map<number, McpActiveReportEntry>
  turnReviews: Array<ReviewCall & { childId: string; seq: number }>
  turnRoundNotes: RoundNote[]
  turnConsults: ConsultCall[]
  turnInvestigates: InvestigateCall[]
  turnHandoff: ContinueCall | null
}

interface JsonRpcRequest {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: unknown
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function negotiateProtocolVersion(requested: unknown): string {
  if (typeof requested !== 'string') return DEFAULT_PROTOCOL_VERSION
  const trimmed = requested.trim()
  if (/^202[4-9]-\d{2}-\d{2}$/.test(trimmed)) return trimmed
  return DEFAULT_PROTOCOL_VERSION
}

function buildToolDefinitions(entry: ActiveRunEntry): McpToolDefinition[] {
  const snap = entry.binding.getContextSnapshot()
  const tools: McpToolDefinition[] = [
    {
      name: AGENTDECK_MCP_TOOLS.context,
      description: '查询你在 AgentDeck 协作平台中的权威上下文（当前角色、人设、工作区契约、可派队员及专长、剩余委派轮数与本轮可审核单号）。长对话触发自动上下文压缩后可随时调用以重新对齐。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    }
  ]

  if (snap.roleKind === 'leader' && snap.subordinates.length > 0 && !snap.spawnsSuspended && snap.remainingRounds > 0) {
    const workerNames = snap.subordinates.map((s) => s.name)
    const rosterDesc = snap.subordinates
      .map((s) => `${s.name}（${s.backend}${s.role ? '，' + s.role : ''}${s.sharedWorkspace ? '，只读共享不改文件' : ''}${s.note ? '，' + s.note : ''}）`)
      .join('；')
    tools.push({
      name: AGENTDECK_MCP_TOOLS.dispatchWorker,
      description: `向 AgentDeck 名下队员异步派发独立子任务（同回合可多次调用实现真并行，写代码队员在独立隔离 worktree 执行）。可派队员：${rosterDesc}。当场校验并返回接单结果或具体拒因；提交完本批所有派单后请直接结束当前回复，不要轮询等待，系统会在全部子任务结束后自动开启下一轮汇总回灌。`,
      inputSchema: {
        type: 'object',
        properties: {
          to: {
            type: 'string',
            enum: workerNames,
            description: `目标队员名称，必须从以下名单中选择：${rosterDesc}`
          },
          prompt: {
            type: 'string',
            description: '给队员的增量任务指令（目标、专属约束、验收要点；文件一律写仓库相对路径，系统会自动附带你的任务原文背景）'
          },
          reason: {
            type: 'string',
            description: '可选：一句话说明为何派给该队员（展示在任务时间线，便于人理解调度）'
          },
          summary: {
            type: 'boolean',
            description: '可选：预计结果超 2000 字且需要直接读压缩结论时设为 true'
          },
          sparse: {
            type: 'array',
            items: { type: 'string' },
            description: '可选：大仓稀疏检出目录前缀列表（仅目录粒度、不含通配符，如 ["src/main", "docs"]）；拿不准时省略走全量'
          },
          thinking: {
            type: 'string',
            enum: ['off', 'low', 'medium', 'high', 'max'],
            description: '可选：覆盖目标队员本次子任务的思考强度（off/low/medium/high/max）'
          }
        },
        required: ['to', 'prompt'],
        additionalProperties: false
      }
    })
  }

  const reviewableSeqs = [...entry.activeReports.values()].filter((r) => r.reviewable).map((r) => r.seq)
  if (reviewableSeqs.length > 0) {
    tools.push({
      name: AGENTDECK_MCP_TOOLS.submitReview,
      description: `对本轮已完成的委派子任务提交审核结论（maker/checker：pass 归档已完成，fail 标记受阻）。当前可审核单号：${reviewableSeqs.map((s) => `#${s}`).join('、')}。`,
      inputSchema: {
        type: 'object',
        properties: {
          seq: { type: 'integer', minimum: 1, description: `子单号数字（例如单号 #1 传 1；可选：${reviewableSeqs.join(', ')}）` },
          verdict: { type: 'string', enum: ['pass', 'fail'], description: '审核结论：pass 或 fail' },
          note: { type: 'string', description: '可选：一句话说明通过理由或退回原因' }
        },
        required: ['seq', 'verdict'],
        additionalProperties: false
      }
    })
  }

  if (entry.activeReports.size > 0) {
    const readableSeqs = [...entry.activeReports.keys()].sort((a, b) => a - b)
    tools.push({
      name: AGENTDECK_MCP_TOOLS.readReport,
      description: `按单号分页读取队员报告的完整原文（用于结果超过回灌界未内联全文时按需翻阅）。当前可查阅单号：${readableSeqs.map((s) => `#${s}`).join('、')}。`,
      inputSchema: {
        type: 'object',
        properties: {
          seq: { type: 'integer', minimum: 1, description: `子单号数字（可选：${readableSeqs.join(', ')}）` },
          offset: { type: 'integer', minimum: 0, description: '可选：起始字符偏移，默认 0' },
          limit: { type: 'integer', minimum: 200, maximum: MAX_REPORT_CHUNK_CHARS, description: `可选：本次读取字符数，默认 ${DEFAULT_REPORT_CHUNK_CHARS}，上限 ${MAX_REPORT_CHUNK_CHARS}` }
        },
        required: ['seq'],
        additionalProperties: false
      }
    })
  }

  if (snap.roleKind === 'leader') {
    tools.push({
      name: AGENTDECK_MCP_TOOLS.recordRound,
      description: '记录领队本轮执行评估（留痕展示于时间线，不影响流程）：action=本轮有新动作，no_action=结果已齐直接收尾，failed=受阻需部分完成或人工介入。',
      inputSchema: {
        type: 'object',
        properties: {
          outcome: { type: 'string', enum: ['action', 'no_action', 'failed'], description: '本轮评估结果' },
          reason: { type: 'string', description: '一句话说明本轮结果与下一步打算' }
        },
        required: ['outcome', 'reason'],
        additionalProperties: false
      }
    })
  }

  if (snap.canConsult && snap.consultPeers.length > 0) {
    const peerNames = snap.consultPeers.map((p) => p.name)
    const peerDesc = snap.consultPeers.map((p) => `${p.name}（${p.backend}${p.role ? '，' + p.role : ''}）`).join('；')
    tools.push({
      name: AGENTDECK_MCP_TOOLS.consultCaptain,
      description: `向其他队长咨询专业意见或复核（只拿意见不派活；提交后请结束当前回复，系统会在下一回合回灌对方意见）。可咨询队长：${peerDesc}。`,
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', enum: peerNames, description: `目标队长名称：${peerDesc}` },
          prompt: { type: 'string', description: '自包含的咨询问题（背景 + 需要对方确认什么）' },
          reason: { type: 'string', description: '可选：一句话说明咨询原因' }
        },
        required: ['to', 'prompt'],
        additionalProperties: false
      }
    })
  }

  if (snap.canInvestigate && snap.subordinates.length > 0) {
    const workerNames = snap.subordinates.map((s) => s.name)
    tools.push({
      name: AGENTDECK_MCP_TOOLS.investigate,
      description: '派发只读调查任务给名下队员（共享工作区只读检查，不修改文件，提交后结束回复等待调查结果回灌）。',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', enum: workerNames, description: `目标队员名称：${workerNames.join('、')}` },
          prompt: { type: 'string', description: '需要只读调查的问题与范围' },
          reason: { type: 'string', description: '可选：调查目的' },
          thinking: { type: 'string', enum: ['off', 'low', 'medium', 'high', 'max'], description: '可选：覆盖本次调查思考强度' }
        },
        required: ['to', 'prompt'],
        additionalProperties: false
      }
    })
  }

  if (snap.canHandoff) {
    tools.push({
      name: AGENTDECK_MCP_TOOLS.handoffPhase,
      description: '阶段接力：当前阶段已完成且存在明确后续阶段时，把下一阶段交给同一 Issue 上的新会话。简报 brief 必须自包含；若无后续阶段或需要等用户确认，不要调用此工具。',
      inputSchema: {
        type: 'object',
        properties: {
          start: { type: 'string', enum: ['auto', 'parked'], description: 'auto=下一阶段立即自动启动；parked=停放等待用户手动启动' },
          brief: { type: 'string', description: '自包含的下一阶段简报（阶段目标、计划文档路径、上一阶段成果与 commit、关键文件:行号、约束与验收标准）' },
          thinking: { type: 'string', enum: ['off', 'low', 'medium', 'high', 'max'], description: '可选：为下一阶段指定的思考强度' }
        },
        required: ['start', 'brief'],
        additionalProperties: false
      }
    })
  }

  return tools
}

function parseSparseArg(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined
  if (Array.isArray(raw)) {
    const items = raw.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
    return items.length ? items.join(',') : undefined
  }
  if (typeof raw === 'string' && raw.trim()) return raw.trim()
  return undefined
}

function parseThinkingArg(raw: unknown): { thinking?: ThinkingLevel; invalidThinking?: string } {
  if (typeof raw !== 'string' || !raw.trim()) return {}
  const lower = raw.trim().toLowerCase()
  if (isThinkingLevel(lower)) return { thinking: lower }
  return { invalidThinking: raw.trim().slice(0, 40) }
}

async function executeToolCall(entry: ActiveRunEntry, name: string, rawArgs: unknown): Promise<McpToolCallOutcome> {
  if (!entry.active || !entry.binding.isActive()) {
    return { isError: true, payload: { ok: false, error: '当前任务运行已结束或未在执行中，不再受理操作。' } }
  }
  entry.binding.onActivity?.()
  const args = asRecord(rawArgs) ?? {}
  const snap = entry.binding.getContextSnapshot()

  switch (name) {
    case AGENTDECK_MCP_TOOLS.context: {
      return {
        isError: false,
        payload: {
          platform: 'AgentDeck',
          taskId: snap.taskId,
          title: snap.title,
          roleKind: snap.roleKind,
          agent: snap.agent ?? null,
          workspace: { kind: snap.workspaceKind, workdir: snap.workdir },
          delegation: snap.roleKind === 'leader' ? {
            remainingRounds: snap.remainingRounds,
            currentDepth: snap.currentDepth,
            maxDepth: snap.maxDepth,
            spawnsSuspended: snap.spawnsSuspended,
            subordinates: snap.subordinates.map((s) => ({
              name: s.name,
              backend: s.backend,
              role: s.role ?? '',
              sharedWorkspace: !!s.sharedWorkspace,
              note: s.note ?? ''
            })),
            consultPeers: snap.consultPeers.map((p) => ({
              name: p.name,
              backend: p.backend,
              role: p.role ?? ''
            }))
          } : null,
          activeReports: [...entry.activeReports.values()].map((r) => ({
            seq: r.seq,
            worker: r.worker,
            title: r.title,
            status: r.status,
            reviewable: r.reviewable,
            fullChars: r.fullText.length
          })),
          canHandoff: snap.canHandoff
        }
      }
    }

    case AGENTDECK_MCP_TOOLS.dispatchWorker: {
      if (snap.roleKind !== 'leader' || snap.subordinates.length === 0) {
        return { isError: true, payload: { accepted: false, error: '当前任务角色没有可驱使的队员，不能派发子任务。' } }
      }
      if (snap.spawnsSuspended || snap.remainingRounds <= 0) {
        return { isError: true, payload: { accepted: false, error: '当前委派轮数预算已耗尽或已进入收尾阶段，不再受理新派单；请直接完成或输出最终总结。' } }
      }
      const to = typeof args.to === 'string' ? args.to.trim() : ''
      const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
      if (!to || !prompt) {
        return {
          isError: true,
          payload: {
            accepted: false,
            error: '参数缺失：to 与 prompt 均必须为非空字符串。',
            validWorkers: snap.subordinates.map((s) => ({ name: s.name, backend: s.backend, sharedWorkspace: !!s.sharedWorkspace }))
          }
        }
      }
      const reason = typeof args.reason === 'string' && args.reason.trim() ? args.reason.trim() : undefined
      const summary = args.summary === true
      const sparse = parseSparseArg(args.sparse)
      const { thinking, invalidThinking } = parseThinkingArg(args.thinking)
      const call: DelegateCall = {
        to,
        prompt,
        ...(reason ? { reason } : {}),
        ...(summary ? { summary: true } : {}),
        ...(sparse !== undefined ? { sparse } : {}),
        ...(thinking ? { thinking } : {}),
        ...(invalidThinking ? { invalidThinking } : {})
      }
      const res = await entry.binding.dispatchWorker(call)
      if (!res.ok) {
        return {
          isError: true,
          payload: {
            accepted: false,
            error: res.error,
            validWorkers: snap.subordinates.map((s) => ({ name: s.name, backend: s.backend, role: s.role ?? '', sharedWorkspace: !!s.sharedWorkspace })),
            hint: '本单未建单（队员未收到任何指令）。请按错误原因在本回合直接改派、调整参数或自行处理。'
          }
        }
      }
      return {
        isError: false,
        payload: {
          accepted: true,
          ...(res.deduplicated ? { deduplicated: true } : {}),
          childTaskId: res.childId,
          worker: res.worker,
          status: res.status,
          isolatedWorktree: res.isolatedWorktree,
          nextStep: res.deduplicated
            ? '完全相同的派单已在队列中，未重复建单。请继续提交其余新派单或结束当前回复等待回灌。'
            : '已异步派单并在后台执行。请继续提交本批其余派单（如有）；本批全部派完后请直接结束当前回复，不要轮询等待，AgentDeck 会在全部子任务结束后自动开启下一轮汇总回灌结果。'
        }
      }
    }

    case AGENTDECK_MCP_TOOLS.submitReview: {
      const seq = typeof args.seq === 'number' && Number.isInteger(args.seq) ? args.seq : Number.NaN
      const verdict = args.verdict === 'pass' || args.verdict === 'fail' ? args.verdict : null
      const note = typeof args.note === 'string' && args.note.trim() ? args.note.trim() : undefined
      const target = Number.isInteger(seq) ? entry.activeReports.get(seq) : undefined
      if (!target || !target.reviewable) {
        const available = [...entry.activeReports.values()].filter((r) => r.reviewable).map((r) => ({ seq: r.seq, worker: r.worker, title: r.title }))
        return { isError: true, payload: { ok: false, error: `单号 #${Number.isFinite(seq) ? seq : String(args.seq ?? '')} 不可审核或不存在。`, reviewableReports: available } }
      }
      if (!verdict) {
        return { isError: true, payload: { ok: false, error: 'verdict 必须为 "pass" 或 "fail"。' } }
      }
      const res = entry.binding.submitReview({ childId: target.childId, seq, verdict, note })
      if (!res.ok) return { isError: true, payload: { ok: false, error: res.error } }
      entry.turnReviews = entry.turnReviews.filter((r) => r.childId !== target.childId)
      entry.turnReviews.push({ of: `#${seq}`, seq, childId: target.childId, verdict, ...(note ? { note } : {}) })
      return { isError: false, payload: { ok: true, seq, childId: target.childId, worker: target.worker, verdict, ...(note ? { note } : {}) } }
    }

    case AGENTDECK_MCP_TOOLS.readReport: {
      const seq = typeof args.seq === 'number' && Number.isInteger(args.seq) ? args.seq : Number.NaN
      const target = Number.isInteger(seq) ? entry.activeReports.get(seq) : undefined
      if (!target) {
        const available = [...entry.activeReports.values()].map((r) => ({ seq: r.seq, worker: r.worker, status: r.status }))
        return { isError: true, payload: { ok: false, error: `未找到单号 #${Number.isFinite(seq) ? seq : String(args.seq ?? '')} 的报告。`, availableReports: available } }
      }
      const offset = typeof args.offset === 'number' && Number.isInteger(args.offset) && args.offset >= 0 ? args.offset : 0
      const rawLimit = typeof args.limit === 'number' && Number.isInteger(args.limit) ? args.limit : DEFAULT_REPORT_CHUNK_CHARS
      const limit = Math.max(200, Math.min(MAX_REPORT_CHUNK_CHARS, rawLimit))
      const totalChars = target.fullText.length
      const content = target.fullText.slice(offset, offset + limit)
      const nextOffset = offset + content.length
      return {
        isError: false,
        payload: {
          ok: true,
          seq: target.seq,
          childId: target.childId,
          worker: target.worker,
          status: target.status,
          totalChars,
          offset,
          returnedChars: content.length,
          hasMore: nextOffset < totalChars,
          ...(nextOffset < totalChars ? { nextOffset } : {}),
          content
        }
      }
    }

    case AGENTDECK_MCP_TOOLS.recordRound: {
      if (snap.roleKind !== 'leader') {
        return { isError: true, payload: { ok: false, error: '只有领队任务可记录本轮评估。' } }
      }
      const outcome = args.outcome === 'action' || args.outcome === 'no_action' || args.outcome === 'failed' ? args.outcome : ''
      const reason = typeof args.reason === 'string' ? args.reason.trim() : ''
      if (!outcome || !reason) {
        return { isError: true, payload: { ok: false, error: 'outcome（action/no_action/failed）与 reason（非空字符串）均必填。' } }
      }
      const note: RoundNote = { outcome, reason }
      entry.turnRoundNotes.push(note)
      entry.binding.recordRound(note)
      return { isError: false, payload: { ok: true, outcome, reason } }
    }

    case AGENTDECK_MCP_TOOLS.consultCaptain: {
      if (!snap.canConsult || snap.consultPeers.length === 0) {
        return { isError: true, payload: { accepted: false, error: '当前会话不允许发起跨队长咨询，或团队中没有其他可咨询队长。' } }
      }
      const to = typeof args.to === 'string' ? args.to.trim() : ''
      const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
      if (!to || !prompt) {
        return { isError: true, payload: { accepted: false, error: 'to 与 prompt 均必须为非空字符串。' } }
      }
      const peer = snap.consultPeers.find((p) => p.name.toLowerCase() === to.toLowerCase() || p.backend.toLowerCase() === to.toLowerCase())
      if (!peer) {
        return {
          isError: true,
          payload: {
            accepted: false,
            error: `"${to}" 不在可咨询队长名单里。`,
            validCaptains: snap.consultPeers.map((p) => ({ name: p.name, backend: p.backend, role: p.role ?? '' }))
          }
        }
      }
      const reason = typeof args.reason === 'string' && args.reason.trim() ? args.reason.trim() : undefined
      const key = `${peer.name}\n${prompt}`
      const duplicate = entry.turnConsults.some((c) => `${c.to}\n${c.prompt}` === key)
      if (!duplicate) {
        entry.turnConsults.push({ to: peer.name, prompt, ...(reason ? { reason } : {}) })
      }
      return {
        isError: false,
        payload: {
          accepted: true,
          ...(duplicate ? { deduplicated: true } : {}),
          to: peer.name,
          nextStep: '咨询请求已登记。请结束当前回复，AgentDeck 会向对方队长转达问题并在下一回合回灌对方意见。'
        }
      }
    }

    case AGENTDECK_MCP_TOOLS.investigate: {
      if (!snap.canInvestigate || snap.subordinates.length === 0) {
        return { isError: true, payload: { accepted: false, error: '当前回合不允许发起只读调查，或名下无可用队员。' } }
      }
      const to = typeof args.to === 'string' ? args.to.trim() : ''
      const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
      if (!to || !prompt) {
        return { isError: true, payload: { accepted: false, error: 'to 与 prompt 均必须为非空字符串。' } }
      }
      const worker = snap.subordinates.find((s) => s.name.toLowerCase() === to.toLowerCase() || s.backend.toLowerCase() === to.toLowerCase())
      if (!worker) {
        return {
          isError: true,
          payload: {
            accepted: false,
            error: `"${to}" 不在你的队员名单里。`,
            validWorkers: snap.subordinates.map((s) => ({ name: s.name, backend: s.backend }))
          }
        }
      }
      const reason = typeof args.reason === 'string' && args.reason.trim() ? args.reason.trim() : undefined
      const { thinking, invalidThinking } = parseThinkingArg(args.thinking)
      const key = `${worker.name}\n${prompt}`
      const duplicate = entry.turnInvestigates.some((c) => `${c.to}\n${c.prompt}` === key)
      if (!duplicate) {
        entry.turnInvestigates.push({
          to: worker.name,
          prompt,
          ...(reason ? { reason } : {}),
          ...(thinking ? { thinking } : {}),
          ...(invalidThinking ? { invalidThinking } : {})
        })
      }
      return {
        isError: false,
        payload: {
          accepted: true,
          ...(duplicate ? { deduplicated: true } : {}),
          to: worker.name,
          nextStep: '只读调查已登记。请结束当前回复，AgentDeck 会在调查完成后把结果回灌给你。'
        }
      }
    }

    case AGENTDECK_MCP_TOOLS.handoffPhase: {
      if (!snap.canHandoff) {
        return { isError: true, payload: { accepted: false, error: '当前任务不支持阶段接力（子任务、办公室会话或无关联 Issue）。' } }
      }
      const start = args.start === 'auto' || args.start === 'parked' ? args.start : null
      const brief = typeof args.brief === 'string' ? args.brief.trim() : ''
      if (!start || !brief) {
        return { isError: true, payload: { accepted: false, error: 'start（"auto" 或 "parked"）与非空 brief 必填。' } }
      }
      const { thinking, invalidThinking } = parseThinkingArg(args.thinking)
      const call: ContinueCall = {
        start,
        brief,
        ...(thinking ? { thinking } : {}),
        ...(invalidThinking ? { invalidThinking } : {})
      }
      const check = entry.binding.validateHandoff(call)
      if (!check.ok) {
        return { isError: true, payload: { accepted: false, error: check.error } }
      }
      entry.turnHandoff = call
      return {
        isError: false,
        payload: {
          accepted: true,
          start,
          note: start === 'auto'
            ? '阶段接力已登记（auto）：本回合结束后将自动创建并启动下一阶段新会话，请直接收尾当前回复。'
            : '阶段接力已登记（parked）：本回合结束后将停放下一阶段等待用户手动启动，请在回复中说明停在当前阶段。'
        }
      }
    }

    default:
      return { isError: true, payload: { ok: false, error: `未知工具：${name}` } }
  }
}

/**
 * 本地环回 Per-Run MCP Server：
 * 由 TaskRunner 惰性持有，支持多任务并发注册独立 Bearer Token，关闭时彻底释放句柄。
 */
export class McpDelegationServer {
  private server: http.Server | null = null
  private listening: Promise<string> | null = null
  private baseUrl: string | null = null
  private readonly runsByToken = new Map<string, ActiveRunEntry>()
  private readonly tokenByTaskId = new Map<string, string>()

  /** 惰性启动 loopback HTTP 监听，返回 MCP 端点 URL（http://127.0.0.1:<port>/mcp） */
  async ensureStarted(): Promise<string> {
    if (this.baseUrl) return this.baseUrl
    if (this.listening) return this.listening
    this.listening = new Promise<string>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        void this.handleHttp(req, res).catch((err) => {
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } }))
          }
        })
      })
      server.once('error', (err) => {
        this.listening = null
        reject(err)
      })
      server.listen(0, '127.0.0.1', () => {
        server.unref()
        const addr = server.address()
        if (!addr || typeof addr === 'string') {
          this.listening = null
          server.close()
          reject(new Error('Failed to bind AgentDeck MCP loopback server'))
          return
        }
        this.server = server
        this.baseUrl = `http://127.0.0.1:${addr.port}/mcp`
        resolve(this.baseUrl)
      })
    })
    return this.listening
  }

  /** 为任务注册新 Run 的专属 MCP 端点（每次调用签发新 Token 并吊销该任务旧 Token） */
  async registerRun(binding: McpRunBinding): Promise<{ serverName: typeof AGENTDECK_MCP_SERVER_NAME; url: string; token: string }> {
    const url = await this.ensureStarted()
    this.unregisterTask(binding.taskId)
    const token = randomBytes(32).toString('hex')
    const entry: ActiveRunEntry = {
      taskId: binding.taskId,
      token,
      tokenDigest: sha256(token),
      sessionHeaderId: `ad_${randomBytes(12).toString('hex')}`,
      binding,
      active: true,
      activeReports: new Map(),
      turnReviews: [],
      turnRoundNotes: [],
      turnConsults: [],
      turnInvestigates: [],
      turnHandoff: null
    }
    this.runsByToken.set(token, entry)
    this.tokenByTaskId.set(binding.taskId, token)
    return { serverName: AGENTDECK_MCP_SERVER_NAME, url, token }
  }

  /**
   * 复用既有常驻会话 Token 并重绑新 Run（如 zcode 常驻连接上的 followUp）：
   * 保持原 Bearer Token 不变，清空上回合残留台账并激活新 Run 归属；若尚无登记则自动新注册。
   */
  async rebindOrRegisterRun(binding: McpRunBinding): Promise<{ serverName: typeof AGENTDECK_MCP_SERVER_NAME; url: string; token: string }> {
    const existingToken = this.tokenByTaskId.get(binding.taskId)
    const existing = existingToken ? this.runsByToken.get(existingToken) : undefined
    if (existing && this.baseUrl) {
      existing.binding = binding
      existing.active = true
      existing.turnReviews = []
      existing.turnRoundNotes = []
      existing.turnConsults = []
      existing.turnInvestigates = []
      existing.turnHandoff = null
      return { serverName: AGENTDECK_MCP_SERVER_NAME, url: this.baseUrl, token: existing.token }
    }
    return this.registerRun(binding)
  }

  /** 标记任务当前无在跑 Run（常驻连接存活期间保留 Token，但闲置期拒绝一切工具调用） */
  deactivateRun(taskId: string, runId?: string): void {
    const token = this.tokenByTaskId.get(taskId)
    if (!token) return
    const entry = this.runsByToken.get(token)
    if (!entry) return
    if (runId !== undefined && entry.binding.runId !== runId) return
    entry.active = false
  }

  /** 吊销指定 Run 的 Token（Run 与连接一并销毁时调用） */
  unregisterRun(taskId: string, runId: string): void {
    const token = this.tokenByTaskId.get(taskId)
    if (!token) return
    const entry = this.runsByToken.get(token)
    if (entry && entry.binding.runId !== runId) return
    this.tokenByTaskId.delete(taskId)
    this.runsByToken.delete(token)
  }

  /** 吊销该任务名下的 Token（关闭会话 / 取消 / 删除任务时调用） */
  unregisterTask(taskId: string): void {
    const token = this.tokenByTaskId.get(taskId)
    if (!token) return
    this.tokenByTaskId.delete(taskId)
    this.runsByToken.delete(token)
  }

  private getEntry(taskId: string, runId?: string): ActiveRunEntry | undefined {
    const token = this.tokenByTaskId.get(taskId)
    if (!token) return undefined
    const entry = this.runsByToken.get(token)
    if (!entry) return undefined
    if (runId !== undefined && entry.binding.runId !== runId) return undefined
    return entry
  }

  /** 设置本轮可供审核与全文翻阅的子单报告表（在回灌领队之前更新） */
  setActiveReports(taskId: string, runId: string | undefined, reports: McpActiveReportEntry[]): void {
    const entry = this.getEntry(taskId, runId)
    if (!entry) return
    entry.activeReports = new Map(reports.map((report) => [report.seq, report]))
  }

  /** 取出并清空本回合经 MCP 收集的动作台账 */
  drainTurnActions(taskId: string, runId?: string): McpTurnActionSnapshot {
    const entry = this.getEntry(taskId, runId)
    if (!entry) return { reviews: [], roundNotes: [], consults: [], investigates: [], handoff: null }
    const snapshot: McpTurnActionSnapshot = {
      reviews: [...entry.turnReviews],
      roundNotes: [...entry.turnRoundNotes],
      consults: [...entry.turnConsults],
      investigates: [...entry.turnInvestigates],
      handoff: entry.turnHandoff
    }
    entry.turnReviews = []
    entry.turnRoundNotes = []
    entry.turnConsults = []
    entry.turnInvestigates = []
    entry.turnHandoff = null
    return snapshot
  }

  /** 只取出并清空本回合审核与评估台账（委派循环每轮使用，不提前清掉 consult/investigate/handoff） */
  drainRoundFeedbackActions(taskId: string, runId?: string): { reviews: Array<ReviewCall & { childId: string; seq: number }>; roundNotes: RoundNote[] } {
    const entry = this.getEntry(taskId, runId)
    if (!entry) return { reviews: [], roundNotes: [] }
    const reviews = [...entry.turnReviews]
    const roundNotes = [...entry.turnRoundNotes]
    entry.turnReviews = []
    entry.turnRoundNotes = []
    return { reviews, roundNotes }
  }

  /** 只取出并清空本回合咨询请求 */
  drainConsults(taskId: string, runId?: string): ConsultCall[] {
    const entry = this.getEntry(taskId, runId)
    if (!entry) return []
    const out = [...entry.turnConsults]
    entry.turnConsults = []
    return out
  }

  /** 只取出并清空本回合只读调查请求 */
  drainInvestigates(taskId: string, runId?: string): InvestigateCall[] {
    const entry = this.getEntry(taskId, runId)
    if (!entry) return []
    const out = [...entry.turnInvestigates]
    entry.turnInvestigates = []
    return out
  }

  /** 只取出并清空本回合阶段接力请求 */
  drainHandoff(taskId: string, runId?: string): ContinueCall | null {
    const entry = this.getEntry(taskId, runId)
    if (!entry) return null
    const out = entry.turnHandoff
    entry.turnHandoff = null
    return out
  }

  hasRun(taskId: string, runId?: string): boolean {
    const entry = this.getEntry(taskId, runId)
    return !!entry && entry.active
  }

  activeRunCount(): number {
    let count = 0
    for (const entry of this.runsByToken.values()) if (entry.active) count++
    return count
  }

  async close(): Promise<void> {
    this.runsByToken.clear()
    this.tokenByTaskId.clear()
    const current = this.server
    this.server = null
    this.baseUrl = null
    this.listening = null
    if (!current) return
    await new Promise<void>((resolve) => {
      try { current.closeAllConnections?.() } catch {}
      current.close(() => resolve())
    })
  }

  private authenticate(req: http.IncomingMessage): ActiveRunEntry | null {
    const header = req.headers.authorization
    if (typeof header !== 'string') return null
    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    if (!match) return null
    const candidateDigest = sha256(match[1].trim())
    for (const entry of this.runsByToken.values()) {
      if (entry.tokenDigest.length === candidateDigest.length && timingSafeEqual(entry.tokenDigest, candidateDigest)) {
        return entry
      }
    }
    return null
  }

  private readBody(req: http.IncomingMessage): Promise<{ ok: true; text: string } | { ok: false; status: number; message: string }> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = []
      let total = 0
      let settled = false
      const done = (result: { ok: true; text: string } | { ok: false; status: number; message: string }) => {
        if (settled) return
        settled = true
        resolve(result)
      }
      req.on('data', (chunk: Buffer) => {
        total += chunk.length
        if (total > MAX_BODY_BYTES) {
          done({ ok: false, status: 413, message: 'Request body too large' })
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => done({ ok: true, text: Buffer.concat(chunks).toString('utf8') }))
      req.on('error', (err) => done({ ok: false, status: 400, message: err.message }))
    })
  }

  private async handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const urlPath = (req.url ?? '/').split('?')[0]
    if (urlPath !== '/mcp' && urlPath !== '/mcp/') {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'Not Found' }))
      return
    }
    const method = (req.method ?? 'GET').toUpperCase()
    if (method === 'GET') {
      res.writeHead(405, { Allow: 'POST, DELETE', 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'Method Not Allowed: server uses stateless POST JSON-RPC' }))
      return
    }
    const entry = this.authenticate(req)
    if (!entry) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized or expired AgentDeck MCP token' } }))
      return
    }
    if (method === 'DELETE') {
      // 一次性 CLI（claude/codex）在单回合结束时会发 DELETE 关闭 HTTP 会话，但同一 Run 的
      // 后续 resume 回合仍需沿用该 runToken——此处友好应答而不提前吊销 runToken。
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Mcp-Session-Id': entry.sessionHeaderId })
      res.end(JSON.stringify({ ok: true }))
      return
    }
    if (method !== 'POST') {
      res.writeHead(405, { Allow: 'POST, DELETE', 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'Method Not Allowed' }))
      return
    }

    const body = await this.readBody(req)
    if (!body.ok) {
      res.writeHead(body.status, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: body.message } }))
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(body.text)
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: invalid JSON' } }))
      return
    }

    const isBatch = Array.isArray(parsed)
    const messages: unknown[] = Array.isArray(parsed) ? parsed : [parsed]
    const responses: Record<string, unknown>[] = []
    for (const raw of messages) {
      const msg = asRecord(raw) as JsonRpcRequest | null
      if (!msg || typeof msg.method !== 'string') {
        responses.push({ jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32600, message: 'Invalid Request' } })
        continue
      }
      const isNotification = msg.id === undefined
      const response = await this.handleRpc(entry, msg)
      if (!isNotification && response) responses.push(response)
    }

    if (responses.length === 0) {
      res.writeHead(202, { 'Mcp-Session-Id': entry.sessionHeaderId })
      res.end()
      return
    }
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Mcp-Session-Id': entry.sessionHeaderId
    })
    res.end(JSON.stringify(isBatch ? responses : responses[0]))
  }

  private async handleRpc(entry: ActiveRunEntry, msg: JsonRpcRequest): Promise<Record<string, unknown> | null> {
    const id = msg.id ?? null
    const params = asRecord(msg.params) ?? {}
    switch (msg.method) {
      case 'notifications/initialized':
      case 'notifications/cancelled':
      case 'notifications/progress':
        return null

      case 'initialize': {
        const protocolVersion = negotiateProtocolVersion(params.protocolVersion)
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: AGENTDECK_MCP_SERVER_NAME, version: '1.0.0' },
            instructions: entry.binding.getInstructions()
          }
        }
      }

      case 'ping':
        return { jsonrpc: '2.0', id, result: {} }

      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: buildToolDefinitions(entry) } }

      case 'resources/list':
        return { jsonrpc: '2.0', id, result: { resources: [] } }

      case 'prompts/list':
        return { jsonrpc: '2.0', id, result: { prompts: [] } }

      case 'tools/call': {
        const name = typeof params.name === 'string' ? params.name : ''
        if (!name) {
          return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Missing tool name' } }
        }
        try {
          const outcome = await executeToolCall(entry, name, params.arguments)
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: JSON.stringify(outcome.payload) }],
              isError: outcome.isError
            }
          }
        } catch (err) {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }) }],
              isError: true
            }
          }
        }
      }

      default:
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${msg.method}` } }
    }
  }
}
