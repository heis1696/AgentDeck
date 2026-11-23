// 假 zcode app-server（协议仿真，供 smoke-zcode-protocol 使用）
// 场景经 FAKE_SCENARIO 环境变量选择：
//   terminal-new-shape : 首回合以 0.16.x 事实形状收尾（session/event + kind:turn.terminal，
//                        payload 无 response/usage 字段）；后续 send 同样收尾
//   send-ack-hang      : 首回合正常收尾；第二个 session/send 既不 ack 也不发任何事件
//                        （复现响应帧丢失——旧实现会永久悬挂）
//   reasoning-level    : 仿 3.19 注册表对 session/setModel 的档位校验（拒绝文案照抄 zcode.cjs）——
//                        GLM-5.4 必须带档位（词表 low/high/max）、GLM-5.1 只认 disabled/high、
//                        GLM-9.9 不存在；每次 setModel 的 model 追加写入 $FAKE_SETMODEL_LOG（设了才写）
// 本文件会被别的 smoke 整段拼接（smoke-worktree-sessions 在源码前加 import fs from 'node:fs'）：
// 顶层只用带别名的具名导入，不占 fs 等通用绑定名
import { appendFileSync as appendSetModelLog } from 'node:fs'
import readline from 'node:readline'

const scenario = process.env.FAKE_SCENARIO ?? 'terminal-new-shape'
const rl = readline.createInterface({ input: process.stdin })
let sendCount = 0

const write = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`)

function emitTerminal(text = '仿真回复文本') {
  // 流式增量 + 0.16.x 回合终态事实（无 response/usage 字段）
  write({ method: 'session/event', params: { type: 'model.streaming', payload: { kind: 'text_delta', delta: text } } })
  write({
    method: 'session/event',
    params: {
      type: 'turn.completed',
      payload: { kind: 'turn.terminal', status: 'success', resultType: 'finish', durationMs: 12, tokenCount: 42, toolCallCount: 0 }
    }
  })
}

rl.on('line', (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.id === undefined) return
  if (scenario === 'permission-choice' && msg.id === 'permission-fixture' && !msg.method) {
    emitTerminal(JSON.stringify(msg.result))
    return
  }
  switch (msg.method) {
    case 'session/create':
      write({ id: msg.id, result: { session: { sessionId: 'sess_fake_zcode' } } })
      break
    case 'session/resume':
      write({ id: msg.id, result: { session: { sessionId: String(msg.params?.sessionId ?? 'sess_fake_zcode') } } })
      break
    case 'session/subscribe':
      write({ id: msg.id, result: {} })
      break
    case 'session/send': {
      sendCount++
      if (scenario === 'send-ack-hang' && sendCount >= 2) return // 不 ack、不吐事件：模拟响应帧丢失
      write({ id: msg.id, result: {} })
      if (scenario === 'permission-choice') {
        write({ id: 'permission-fixture', method: 'interaction/requestPermission', params: {
          toolName: 'Fixture', reason: 'Protocol regression', riskLevel: 'low',
          options: JSON.parse(process.env.FAKE_PERMISSION_OPTIONS ?? '[]')
        } })
        break
      }
      setTimeout(() => emitTerminal(), 20)
      break
    }
    case 'session/setModel': {
      const model = msg.params?.model ?? {}
      if (process.env.FAKE_SETMODEL_LOG) appendSetModelLog(process.env.FAKE_SETMODEL_LOG, `${JSON.stringify(model)}\n`)
      const reject = (message) => write({ id: msg.id, error: { code: -32603, message, data: { name: 'ModelProtocolError' } } })
      if (scenario === 'reasoning-level') {
        const name = `${model.providerId}/${model.modelId}`
        const level = model.options?.reasoningLevel
        if (model.modelId === 'GLM-9.9') {
          reject(`Provider Registry 中不存在 Model: ${name}`)
          break
        }
        const levels = { 'GLM-5.4': ['low', 'high', 'max'], 'GLM-5.1': ['disabled', 'high'] }[model.modelId]
        if (levels) {
          if (level === undefined) {
            reject(`Reasoning level is required for ${name}`)
            break
          }
          if (!levels.includes(level)) {
            reject(`Reasoning effort "${level}" is not supported by ${name}`)
            break
          }
        }
      }
      write({ id: msg.id, result: {} })
      break
    }
    case 'session/stop':
      write({ id: msg.id, result: {} })
      break
    case 'session/close':
      write({ id: msg.id, result: {} })
      break
    default:
      write({ id: msg.id, result: {} })
  }
})
