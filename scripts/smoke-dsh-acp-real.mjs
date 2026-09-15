// dsh ACP 真机冒烟：本机 deepseek-harness + 真实 DeepSeek API。
// 验证：组合配置可启动（凭证走 ~/.dsh/.credentials.yaml）、流式 text 事件、
// 续聊、yolo 模式下工具执行、close 收进程。跑一次约 3 个小回合。
// 前置：D:\Program files\deepseek-harness（或 DSH_HOME/dshPath 指向源码仓库）
import { build } from 'esbuild'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const outfile = path.join(root, 'out', 'smoke-dsh-acp-real.cjs')
await build({ entryPoints: [path.join(root, 'src/main/backends/dsh-acp.ts')], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node18' })
const { startDshAcpSession, findDshAcpBin } = await import(pathToFileURL(outfile).href)

const acp = findDshAcpBin(process.env.DSH_PATH || undefined)
if (!acp) {
  console.error('⏭ 未找到 deepseek-harness ACP 组件（packages/examples/acp-demo/lib/bin.js），跳过')
  process.exit(0)
}
console.log('ACP bin:', acp.bin)

const events = []
const heartbeats = { n: 0 }
const turnEnds = []
const assert = (cond, msg) => {
  if (!cond) {
    console.error('❌ ASSERT FAIL:', msg)
    process.exit(1)
  }
  console.log('  ✓', msg)
}

const session = await startDshAcpSession({
  prompt: 'Reply with exactly: OK',
  workdir: root,
  mode: 'yolo',
  events: {
    onEvent: (e) => events.push(e),
    onHeartbeat: () => { heartbeats.n++ },
    onTurnEnd: (r) => turnEnds.push(r),
    onSessionId: () => {},
    onLaunch: () => {}
  },
  acp
})
const sid = session.sessionId
assert(/^[\w-]+$/.test(sid), `真实会话建立 (${sid.slice(0, 8)}…)`)
const last1 = turnEnds.at(-1)
assert(last1?.ok && last1.response.trim().toUpperCase() === 'OK', `首回合回复 OK (got "${last1?.response?.trim().slice(0, 40)}")`)
assert(events.some((e) => e.kind === 'text'), '流式 text 事件可见（agent_message_chunk）')
assert(heartbeats.n >= 1, '协议通知触发心跳')

// 续聊：同会话第二轮（headless 模式做不到）
events.length = 0
await session.send('In one word: what did I just ask you to reply with?')
const last2 = turnEnds.at(-1)
assert(last2?.ok && /ok/i.test(last2.response), `同会话续聊生效 (${last2.response.trim().slice(0, 30)})`)

// 工具执行（yolo → danger-full-access，Windows 上跳过 bash 沙箱行）
events.length = 0
await session.send('Run this shell command and reply with its exact output only: node -e "console.log(42)"')
const last3 = turnEnds.at(-1)
assert(last3?.ok && last3.response.includes('42'), `工具执行贯通 (${last3.response.trim().slice(0, 40)})`)

await session.close()
console.log('\n✅ DSH ACP REAL SMOKE PASSED')
