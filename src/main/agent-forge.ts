// 锻造师：agents:draft / agents:improve / agents:evaluate 的主进程实现——生成队员草稿、按反馈改进既有队员、对草稿做触发评测
// 结构仿 skills.ts：纯函数（内置技能正文/落盘/解析/拼 prompt）不 import electron、路径由参数注入，便于 smoke；
// runForgeTurn 是唯一的主进程编排入口（ctx 注入 backends/presets/settings/sharedDir），三种模式共用；
// 技能正文（元提示词）与 prompt 组装已集中到 src/main/prompts/forge.ts
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { FORGE_SKILL_NAME, FORGE_SKILL_VERSION, isForgeAgent, type AgentDraft, type DraftResult, type EvaluateResult, type ImproveResult } from '../shared/forge'
// 技能正文与三模式 prompt 组装集中在 src/main/prompts/forge.ts
import { FORGE_SKILL_MD, FORGE_SKILL_BODIES_PREVIOUS, FORGE_SKILL_BODY, buildDraftPrompt, buildImprovePrompt, buildEvaluatePrompt } from './prompts/forge'
import { parseFrontmatter, skillsDir } from './skills'
import { defaultAgents, type Agent } from './agents'
import type { BackendSession, BackendTurnResult } from './backends/types'
import type { IpcContext } from './ipc/context'

/** 生成/改进回合硬预算：锻造师只做一次文本生成，超时即中止（防平台挂死拖住 UI） */
const DRAFT_TIMEOUT_MS = 90_000

/** 草稿色非法时的兜底色（与领队主色一致） */
const FALLBACK_COLOR = '#4f8cff'


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
