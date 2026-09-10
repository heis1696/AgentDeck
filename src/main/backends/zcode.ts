// ZCode 后端适配器：spawn `zcode app-server --stdio`，讲 "ZCode Protocol"。
// 协议要点（逆向自 zcode.cjs 0.16.3，2026-08 实测）：
//   - 换行分隔 JSON。请求 {id,method,params}，响应 {id,result|error}，通知 {method,params}
//   - session/create 会先收到服务端请求 session/requestRuntimePreferences（必须应答扁平对象）
//   - session/subscribe {sessionId, deliveryKind:"desktop-continuous"} 开启事件推送
//   - session/send {sessionId, content} 派发提示词
//   - 事件流：session/event（含 model.streaming 文本增量、回合终态）、
//             state.updated（会话状态机）、v4/telemetry/event（turn.terminal 等）
import fs from 'node:fs'
import os from 'node:os'
import type { TaskEvent } from '../../shared/types'
import type { AgentBackend, BackendSession, BackendSessionEvents } from './types'
import { isJsonObject, type JsonObject } from './cli-common'
import { ZcodeConnection } from './zcode-transport'
import { compactToolArgs, mergeTurnTexts as mergeTexts, runtimePreferences, sessionEvent, zcodeRecord, zcodeString } from './zcode-protocol'
import {
  buildRuntimeModelFromCliConfig as buildRuntimeModel,
  ensureZcodeCliConfig as ensureCliConfig,
  findZcodeBundle as findBundle,
  listZcodeModels as listModels,
  resolveNodeRuntime as resolveNode,
  zcodeDefaultPaths as defaultPaths
} from './zcode-config'


function asRecord(value: unknown): JsonObject {
  return zcodeRecord(value)
}
const asString = zcodeString

export function zcodeDefaultPaths(): string[] {
  return defaultPaths()
}

/**
 * 解析运行 zcode.cjs 的 Node。
 * zcode.cjs 依赖 node:sqlite（Node ≥22.5），而 Electron 内置 Node 是 20.x，
 * 所以必须优先用系统 Node；找不到时退回 process.execPath（大概率会报
 * "No such built-in module: node:sqlite"，错误信息里会带这句提示）。
 */
export function resolveNodeRuntime(preferred?: string): { path: string; source: string } {
  return resolveNode(preferred)
}

export function findZcodeBundle(custom?: string): string | null {
  return findBundle(custom)
}

/**
 * 确保 `~/.zcode/cli/config.json` 存在且带 model 配置（app-server 启动必需）。
 * 优先从 GUI 的 `~/.zcode/v2/config.json` 迁移登录态；已有有效配置则不动。
 */
export function ensureZcodeCliConfig(): { ok: boolean; detail: string } {
  return ensureCliConfig()
}

/** 工具参数 JSON 压缩成一行短预览 */
function compactArgs(args?: string): string {
  return compactToolArgs(args)
}

/**
 * 从 cli config 构造 runtimeModel（provider registry 快照）。
 * resume 旧会话必须带：服务端用它重新解析会话的历史模型，否则 send 会报
 * ZCODE_RUNTIME_MODEL_UNAVAILABLE（"历史任务使用的模型已不可用"）。
 * modelRef 为 agent 钉死的模型覆盖：'providerId/modelId' 拆两者，裸 modelId 沿用
 * config 默认 provider；目录缺该模型时补录（服务端按目录校验）。
 * connection（API 预设）与模型同时提供时，provider 整体改由预设构造（baseURL/apiKey
 * 内存注入，完全不读 config）；connection 无模型时忽略连接（平台默认路径）。
 */
export function buildRuntimeModelFromCliConfig(
  modelRef?: string,
  connection?: { name: string; baseURL: string; apiKey: string }
): Record<string, unknown> | null {
  return buildRuntimeModel(modelRef, connection)
}

/**
 * 委派解析用的回合文本来源合并。
 * 终态全文（服务端完整回复，带消息分隔、可含未流式展示的思考内容）与流式累计
 * （全部中间消息的裸拼接）都可能独占含有 <delegate> 标记，长度不能当完整性代理。
 * 包含判断空白不敏感；互含时取终态全文（保真消息边界）；互不包含时拼接，重复
 * 解析由 parseDelegatesMerged 按 to+prompt 去重。
 */
export function mergeTurnTexts(full: string, streamed: string): string {
  return mergeTexts(full, streamed)
}

/** zcode 模型目录（Agent 管理的模型下拉用）：cli config 各 provider 的模型键并集 + 默认模型 */
export function listZcodeModels(): { models: string[]; defaultModel?: string } {
  return listModels()
}

export function createZcodeBackend(getPaths: () => { nodePath: string; zcodePath: string }): AgentBackend {
  return {
    id: 'zcode',
    label: 'ZCode (GLM)',
    async probe() {
      const { zcodePath, nodePath } = getPaths()
      const bundle = findBundle(zcodePath || undefined)
      if (!bundle) return { ok: false, detail: '找不到 zcode.cjs（可在设置里手动指定路径）' }
      const node = resolveNode(nodePath || undefined)
      const nodeNote =
        node.source === 'fallback-electron'
          ? '⚠ 未找到系统 Node（zcode 需要 Node ≥ 22.5），将退回内置运行时，可能失败'
          : `node: ${node.path}`
      const cfg = ensureCliConfig()
      if (!cfg.ok) return { ok: false, detail: `${cfg.detail} · ${nodeNote}` }
      return { ok: node.source !== 'fallback-electron', detail: `${bundle} · ${cfg.detail} · ${nodeNote}` }
    },
    async start({ prompt, workdir, mode, model, connection, events, resumeSessionId }) {
      const { nodePath, zcodePath } = getPaths()
      const bundle = findBundle(zcodePath || undefined)
      if (!bundle) throw new Error('找不到 zcode.cjs')
      const cfgCheck = ensureCliConfig()
      if (!cfgCheck.ok) throw new Error(cfgCheck.detail)

      const cwd = workdir && fs.existsSync(workdir) ? workdir : os.tmpdir()
      const node = resolveNode(nodePath || undefined)
      const conn = new ZcodeConnection(node.path, bundle, cwd)
      // 启动即注册硬停句柄：session/create 等握手请求挂死时（进程半死/连接无响应），
      // 调用方在 start 返回前也有手段杀掉进程，不会永久占住任务与并发槽
      events.onLaunch?.({ stop: () => conn.kill() })
      const emit = (e: Omit<TaskEvent, 'seq' | 'ts'>) => events.onEvent({ ...e, ts: Date.now() })

      let turnResolver: ((v: { response: string; ok: boolean; error?: string }) => void) | null = null
      let currentText = ''
      /** 最后一条 assistant 消息：自上一次工具活动以来累计的文本增量 */
      let lastSegment = ''
      let lastTurnEnd: { response: string; ok: boolean; error?: string } | null = null
      /** 本回合是否仍在进行（send 串行化判断用） */
      let turnActive = false
      /**
       * send 串行化期间：正在停掉被放弃的旧回合。它的收尾终态不再外发
       * （final/onTurnEnd 都不发），否则会立刻 resolve 新回合在 runner 侧的
       * 等待、并把旧回合的终段混进新回合的事件流。
       */
      let swallowingStaleTurnEnd = false
      /** 等待旧回合终态的回调（send 串行化时挂起，终态到达即放行） */
      const turnEndWaiters = new Set<() => void>()
      const flushTurnEndWaiters = () => {
        if (!turnEndWaiters.size) return
        const waiters = [...turnEndWaiters]
        turnEndWaiters.clear()
        for (const w of waiters) w()
      }
      /** 流式看门狗：模型偶发无限生成循环（实测 10 分钟吐 1.5MB），超限强制停止 */
      let textOverflowed = false
      const TEXT_LIMIT = 300_000
      /** 工具参数流聚合：toolCallId → {name, args} */
      const toolInputs = new Map<string, { name: string; args: string }>()
      /** 会话 id 容器（事件处理器在赋值前注册，经此读取） */
      const sessionIdHolder = { value: '' }

      /** 压平空白后比较，容忍服务端拼接消息时的换行差异 */
      const squash = (s: string) => s.replace(/\s+/g, ' ').trim()
      const handleTurnEnd = (r: { response: string; ok: boolean; error?: string }) => {
        // 协议每回合会发两种终态（完整回合回复 + 最后一条消息），只取首个完整版
        if (lastTurnEnd) return
        // 首个终态的 response 是完整回合回复：包含本回合所有中间回复（已随 text 事件
        // 流式展示过）。只保留最后一条 assistant 消息，避免 UI 终段全量回显、
        // result 与委派回灌把中间回复再吃一遍上下文
        const full = r.response
        const lastMsg = squash(lastSegment)
        const response = lastMsg && (full === currentText || squash(full).endsWith(lastMsg)) ? lastSegment : full
        // 委派标记可能只出现在终态全文或流式累计的其中一个里：合并两源（mergeTurnTexts）
        const scan = mergeTurnTexts(full, currentText)
        const ended = { ...r, response, delegationText: scan || undefined }
        lastTurnEnd = ended
        turnActive = false
        if (turnResolver) {
          const res = turnResolver
          turnResolver = null
          res(ended)
        }
        flushTurnEndWaiters()
        if (swallowingStaleTurnEnd) return
        emit({ kind: 'final', text: response || r.error || '' })
        events.onTurnEnd(ended)
      }

      conn.onMessage((m) => {
        // 任何线级消息都是进展信号（含被静默的思考增量/遥测/资源采样）：
        // 模型长时间思考、子代理在后台跑等静默阶段靠它给上层看门狗续命，避免误判超时
        events.onHeartbeat?.()
        // 连接层合成的进程退出通知：回合仍在途时以错误收尾（lastTurnEnd 已置则本就无人在等）
        if (m.method === 'zcode.exit') {
          if (!lastTurnEnd) {
            handleTurnEnd({
              response: '',
              ok: false,
              error: `zcode app-server 进程退出${asRecord(m.params).code != null ? ` (code ${asRecord(m.params).code})` : ''}${asRecord(m.params).stderr ? `：${String(asRecord(m.params).stderr).slice(0, 300)}` : ''}`
            })
          }
          return
        }
        // 服务端 → 客户端 请求
        if (m.method === 'session/requestRuntimePreferences' && m.id !== undefined) {
          conn.respond(m.id, runtimePreferences())
          return
        }
        if (m.method && m.id !== undefined && String(m.id).startsWith('server-')) {
          conn.respond(m.id, {})
          return
        }
        const event = sessionEvent(m)
        if (event) {
          const { type, payload } = event
          if (type === 'model.streaming') {
            const k = asString(payload.kind)
            if (k === 'text_delta') {
              const delta = asString(payload.delta)
              currentText += delta
              lastSegment += delta
              emit({ kind: 'text', text: delta })
              if (!textOverflowed && currentText.length > TEXT_LIMIT) {
                textOverflowed = true
                emit({ kind: 'status', text: `⚠ 输出超过 ${TEXT_LIMIT / 1000}KB，疑似模型生成循环，强制停止本回合` })
                conn.request("session/stop", { sessionId: sessionIdHolder.value }).catch(() => {})
                handleTurnEnd({
                  response: currentText.slice(0, TEXT_LIMIT),
                  ok: true,
                  error: undefined
                })
              }
            } else if (k === 'tool_input_start') {
              // 工具活动开始：此后的文本属于新的一条 assistant 消息
              lastSegment = ''
              const toolCallId = asString(payload.toolCallId)
              toolInputs.set(toolCallId, { name: asString(payload.toolName), args: '' })
            } else if (k === 'tool_input_delta') {
              const ti = toolInputs.get(asString(payload.toolCallId))
              if (ti) ti.args += asString(payload.delta)
            }
            // tool_input_end / 其余 streaming 子类静默
          } else if (type === 'tool.updated') {
            const k = asString(payload.kind)
            if (k === 'started') {
              lastSegment = ''
              const ti = toolInputs.get(asString(payload.toolCallId))
              emit({
                kind: 'tool',
                text: asString(payload.toolName, ti?.name ?? ''),
                data: {
                  phase: 'started',
                  toolCallId: asString(payload.toolCallId),
                  args: compactArgs(ti?.args)
                }
              })
            } else if (k === 'result') {
              lastSegment = ''
              const res = asRecord(payload.result)
              const preview =
                typeof res.content === 'string'
                  ? res.content.slice(0, 400)
                  : typeof res.content === 'object' && res.content !== null
                    ? JSON.stringify(res.content).slice(0, 400)
                    : ''
              emit({
                kind: 'tool',
                text: asString(payload.toolName, toolInputs.get(asString(payload.toolCallId))?.name ?? ''),
                data: {
                  phase: 'result',
                  toolCallId: asString(payload.toolCallId),
                  ok: res.success !== false,
                  durationMs: payload.duration ?? asRecord(res.perf).totalMs,
                  preview
                }
              })
            }
            // scheduled 阶段静默
          } else if (payload.response !== undefined && payload.usage !== undefined) {
            // 回合终态：payload 带 response + usage。
            // telemetry 的 turn.terminal 可能先到并已发过 usage/final，此时跳过，避免每回合双份用量
            const alreadyEnded = lastTurnEnd !== null
            handleTurnEnd({
              response: String(payload.response ?? ''),
              ok: payload.resultType !== 'error',
              error: payload.resultType === 'error' ? String(payload.response ?? '') : undefined
            })
            if (payload.usage && !alreadyEnded) {
              emit({ kind: 'usage', data: payload.usage })
            }
          } else if (type === 'checkpoint.created') {
            emit({ kind: 'status', text: 'checkpoint' })
          } else if (type === 'model.request.status') {
            emit({ kind: 'status', text: asString(payload.status) })
          }
          // session.titleUpdated / session.updated / turn.started / streamRecovery.updated 等噪音静默
          return
        }
        if (m.method === 'state.updated') {
          const status = asRecord(asRecord(m.params).patch).status
          if (status) emit({ kind: 'status', text: `session:${status}` })
          return
        }
        if (m.method === 'v4/telemetry/event') {
          const telemetry = asRecord(m.params)
          const kind: string = String(telemetry.kind ?? '')
          if (kind === 'turn.terminal') {
            // 备用终态信号：若尚未触发 handleTurnEnd
            if (!lastTurnEnd) {
              handleTurnEnd({
                response: currentText,
                ok: telemetry.status === 'success',
                error: telemetry.status === 'success' ? undefined : `turn ended: ${telemetry.status}`
              })
              // 只有在走备用路径时才补 usage（正常路径已由 session/event 发过）
              const u = telemetry
              if (u && (u.tokenCount || u.durationMs)) {
                emit({ kind: 'usage', data: { tokenCount: u.tokenCount, durationMs: u.durationMs, toolCallCount: u.toolCallCount } })
              }
            }
          }
          // telemetry 的 model.request.status 与 session/event 重复，静默
          return
        }
        if (m.method === 'interaction/requestPermission' && m.id !== undefined) {
          const p = asRecord(m.params)
          const options: Array<{ optionId: string; name: string; description?: string; response: { decision: string } }> =
            (isJsonObject(p) && Array.isArray(p.options) ? p.options : []).filter(isJsonObject).map((o) => ({
              optionId: String(o.optionId ?? ''),
              name: String(o.name ?? o.kind ?? ''),
              description: typeof o.description === 'string' ? o.description : undefined,
              response: asRecord(o.response) as { decision: string }
            }))
          const req = {
            requestId: m.id,
            toolName: String(p.toolName ?? ''),
            reason: String(p.reason ?? ''),
            riskLevel: String(p.riskLevel ?? ''),
            input: p.input,
            options
          }
          const reqId = m.id
          if (events.onPermission) {
            emit({
              kind: 'status',
              text: `权限请求: ${req.toolName} (${req.riskLevel})`
            })
            events
              .onPermission(req)
              .then((choice) => {
                const chosen =
                  options.find((o) => o.optionId === choice.optionId) ??
                  options.find((o) => o.response.decision === choice.decision) ??
                  options[0]
                conn.respond(reqId, chosen?.response ?? { decision: 'deny' })
                emit({ kind: 'status', text: `权限已${chosen?.response.decision === 'deny' ? '拒绝' : '放行'}: ${req.toolName}` })
              })
              .catch(() => {
                conn.respond(reqId, { decision: 'deny' })
              })
          } else {
            // 无处理器（yolo 语义）自动放行
            conn.respond(m.id, options.find((o) => o.response.decision === 'allow')?.response ?? { decision: 'allow' })
            emit({ kind: 'status', text: `permission:auto-allowed: ${req.toolName}` })
          }
          return
        }
        // 其余通知忽略（process/resourceSample 等）
      })

      emit({ kind: 'status', text: 'starting app-server' })
      let sessionId: string
      if (resumeSessionId) {
        const runtimeModel = buildRuntimeModel(model, connection)
        const resumed = await conn.request<JsonObject>('session/resume', {
          sessionId: resumeSessionId,
          workspace: { workspaceKey: cwd, workspacePath: cwd },
          ...(runtimeModel ? { runtimeModel } : {})
        })
        sessionId = String(asRecord(resumed.session).sessionId ?? resumeSessionId)
        emit({ kind: 'status', text: runtimeModel ? '会话已恢复' : '会话已恢复（未带模型注册表）' })
      } else {
        // agent 指定模型（或预设+模型）时 create 也带 runtimeModel；默认路径不带，保持历史行为
        const runtimeModel = model?.trim() ? buildRuntimeModel(model, connection) : null
        const created = await conn.request<JsonObject>('session/create', {
          workspace: { workspaceKey: cwd, workspacePath: cwd },
          mode: mode || 'yolo',
          ...(runtimeModel ? { runtimeModel } : {})
        })
        sessionId = String(asRecord(created.session).sessionId ?? '')
      }
      if (!sessionId) throw new Error('会话创建/resume 未返回 sessionId')
      sessionIdHolder.value = sessionId
      events.onSessionId?.(sessionId)
      await conn.request('session/subscribe', { sessionId, deliveryKind: 'desktop-continuous' })
      currentText = ''
      lastSegment = ''
      lastTurnEnd = null
      textOverflowed = false
      turnActive = true
      await conn.request('session/send', { sessionId, content: prompt })

      const session: BackendSession = {
        sessionId,
        async send(content: string) {
          // 串行化：上一回合仍在跑（调用方已放弃等待/被中断）时，先停掉它并等终态，
          // 否则两个回合的流式事件与终态会互相错配——旧终态误 resolve 新等待、
          // 新终态又被 lastTurnEnd 去重守卫吞掉
          if (turnActive) {
            swallowingStaleTurnEnd = true
            try {
              try {
                await conn.request('session/stop', { sessionId })
              } catch {}
              await new Promise<void>((resolve) => {
                const giveUp = setTimeout(resolve, 15000)
                turnEndWaiters.add(() => {
                  clearTimeout(giveUp)
                  resolve()
                })
              })
              turnActive = false
            } finally {
              swallowingStaleTurnEnd = false
            }
          }
          currentText = ''
          lastSegment = ''
          lastTurnEnd = null
          textOverflowed = false
          turnActive = true
          let timer: NodeJS.Timeout | undefined
          const p = new Promise<void>((resolve, reject) => {
            timer = setTimeout(() => {
              turnResolver = null
              turnActive = false
              flushTurnEndWaiters()
              reject(new Error('等待回合结束超时（30 分钟）'))
            }, 30 * 60 * 1000)
            turnResolver = (r) => {
              clearTimeout(timer)
              turnActive = false
              flushTurnEndWaiters()
              r.ok ? resolve() : reject(new Error(r.error || '回合失败'))
            }
          })
          // 调用方可能已放弃等待（runner 超时/连接死亡时 send 提前失败或被中断），
          // 这时 p 的 rejection 无人接——不挂兜底会以 unhandled rejection 打崩主进程
          p.catch(() => {})
          try {
            await conn.request('session/send', { sessionId, content })
          } catch (e) {
            // send 请求本身失败：撤掉本回合的等待句柄——悬挂的 30 分钟定时器
            // 之后触发时会误杀新回合的 turnResolver
            if (timer) clearTimeout(timer)
            turnResolver = null
            turnActive = false
            flushTurnEndWaiters()
            throw e
          }
          await p
        },
        async stop() {
          try {
            await conn.request('session/stop', { sessionId })
          } catch {}
        },
        async close() {
          try {
            await Promise.race([
              conn.request('session/close', { sessionId }),
              new Promise((r) => setTimeout(r, 1500))
            ])
          } catch {}
          await conn.kill()
        }
      }
      return session
    }
  }
}

// 首条消息的回合等待由 start 的调用方（runner）通过 onTurnEnd 接收
export type { BackendSessionEvents }
