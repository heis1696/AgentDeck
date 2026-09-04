// DeepSeek Harness (dsh) 适配器（一次性、纯文本输出）
// 无头：dsh --profile headless "<task>" → 打印最终回复并退出（无 JSON 流、无 resume）
// 源码安装常见于任意目录（本机 D:\Program files\deepseek-harness），自动扫描 + 设置页可指定
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { AgentBackend, BackendSession, BackendSessionEvents } from './types'
import { runCliJsonl } from './cli-common'
import { resolveCli, findOnPath, findSystemNode } from './cli-locator'

const DSH_BIN = path.join('apps', 'cli', 'lib', 'bin.js')

/** 候选安装根目录 */
function dshRootCandidates(): string[] {
  const roots = [
    process.env.DSH_HOME,
    'D:\\Program Files',
    process.env.ProgramFiles ?? 'C:\\Program Files',
    process.env['ProgramFiles(x86)'],
    path.join(os.homedir(), 'Projects'),
    os.homedir(),
    'D:\\'
  ].filter(Boolean) as string[]
  return roots.map((r) => path.join(r, 'deepseek-harness'))
}

export function findDshBin(custom?: string): { node: string; bin: string } | null {
  // node 优先用系统安装的：process.execPath（electron）充当 node 需要
  // ELECTRON_RUN_AS_NODE 标记，且其内置 Node 版本可能解析不了 dsh 的依赖
  const node = findSystemNode() ?? process.execPath
  // 1. 设置页指定
  if (custom && fs.existsSync(custom)) return { node, bin: custom }
  // 2. PATH 上的 dsh（解析 npm 垫片到 bin.js）
  const onPath = findOnPath('dsh')
  if (onPath) {
    const resolved = resolveCli('dsh')
    if (resolved) {
      const target = resolved.prefixArgs[0]
      if (target && fs.existsSync(target)) {
        return { node: resolved.command === process.execPath ? node : resolved.command, bin: target }
      }
    }
  }
  // 3. 常见目录扫描
  for (const root of dshRootCandidates()) {
    const bin = path.join(root, DSH_BIN)
    if (fs.existsSync(bin)) return { node, bin }
  }
  return null
}

export function createDshBackend(getPaths: () => { dshPath: string }): AgentBackend {
  let live: { kill: () => void } | null = null

  const runOnce = (
    prompt: string,
    workdir: string,
    events: BackendSessionEvents
  ): Promise<{ response: string; ok: boolean; error?: string }> => {
    // 每次调用现取设置，设置页改路径后无需重启即可生效
    const dsh = findDshBin(getPaths().dshPath || undefined)
    if (!dsh) return Promise.reject(new Error('找不到 dsh（DeepSeek Harness）。请在设置页指定 bin.js 路径'))
    let out = ''
    let settled = false
    let settle!: (v: { response: string; ok: boolean; error?: string }) => void
    const done = new Promise<{ response: string; ok: boolean; error?: string }>((r) => (settle = r))
    const finish = (ok: boolean, response: string, error?: string) => {
      if (settled) return
      settled = true
      events.onTurnEnd({ response, ok, error })
      settle({ response, ok, error })
    }

    const runner = runCliJsonl({
      command: dsh.node,
      prefixArgs: [dsh.bin],
      args: ['--profile', 'headless', prompt],
      cwd: workdir || process.cwd(),
      // node 可能是 electron 充当（findSystemNode 找不到时的回退）：
      // 不加此标记会按 GUI 应用启动、不退出，子任务只能等看门狗超时
      env: { ELECTRON_RUN_AS_NODE: '1' },
      onLine: () => {}, // 输出是纯文本非 JSON
      onRaw: (line) => {
        out += line + '\n'
      }
    })
    live = runner
    events.onLaunch?.({ stop: () => runner.kill() })

    void runner.exited.then((exitInfo) => {
      live = null
      const text = out.trim()
      if (exitInfo.code === 0 && text) {
        events.onEvent({ kind: 'final', text, ts: Date.now() })
        finish(true, text)
      } else {
        finish(
          false,
          text,
          `dsh 退出 code=${exitInfo.code}${exitInfo.stderrTail ? ': ' + exitInfo.stderrTail.slice(0, 200) : ''}`
        )
      }
    })
    return done
  }

  return {
    id: 'dsh',
    label: 'DeepSeek Harness',
    async probe() {
      const dsh = findDshBin(getPaths().dshPath || undefined)
      if (!dsh) return { ok: false, detail: '找不到 deepseek-harness 安装（可指定 apps/cli/lib/bin.js 路径）' }
      const { execFile } = await import('node:child_process')
      return new Promise((resolve) => {
        // dsh.node 可能是 electron.exe 充当 node（findDshBin 的回退），
        // 不加此标记会按 GUI 应用启动、不退出，探测只能靠超时收场
        execFile(
          dsh.node,
          [dsh.bin, '--version'],
          { timeout: 15000, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } },
          (err, stdout) => {
            if (err) resolve({ ok: false, detail: 'dsh 执行失败: ' + String(err.message).slice(0, 80) })
            else resolve({ ok: true, detail: `dsh ${stdout.trim().slice(0, 40)} · headless 模式` })
          }
        )
      })
    },
    async start({ prompt, workdir, events }) {
      const r = await runOnce(prompt, workdir, events)
      if (!r.ok) throw new Error(r.error || 'dsh 回合失败')
      return {
        sessionId: `dsh_${Date.now().toString(36)}`,
        async send() {
          throw new Error('dsh 无头模式不支持续聊（请新建任务）')
        },
        async stop() {
          live?.kill()
        },
        async close() {
          live?.kill()
        }
      }
    }
  }
}
