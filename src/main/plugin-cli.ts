// 插件装卸（v1 仅 claude）：借 claude 官方 CLI 的 `plugin install/uninstall <plugin@marketplace>` 子命令
// CLI 解析与 spawn 方式复用 backends 既有基建（.cmd 垫片/.js 入口/ELECTRON_RUN_AS_NODE 的坑见 cli-locator/cli-common）；
// 一次性进程 60s 总超时强杀，输出取 stdout+stderr 尾部 ≤2000 字符（home 由参数注入，仅作 cwd）
import type { PluginCliResult } from '../shared/extensions'
import { runCliJsonl } from './backends/cli-common'
import { resolveCli } from './backends/cli-locator'

/** plugin@marketplace 形式（两段都限 \w . - 字符，杜绝参数注入/路径逃逸） */
const PLUGIN_SPEC_PATTERN = /^[\w.-]+@[\w.-]+$/
const PLUGIN_CLI_TIMEOUT_MS = 60_000
const OUTPUT_TAIL_CHARS = 2000

async function runPluginCli(home: string, action: 'install' | 'uninstall', spec: string): Promise<PluginCliResult> {
  if (typeof spec !== 'string' || !PLUGIN_SPEC_PATTERN.test(spec)) throw new Error(`插件 spec 非法（应为 plugin@marketplace）: ${spec}`)
  const resolved = resolveCli('claude')
  if (!resolved) throw new Error('PATH 上找不到 claude，无法安装/卸载插件')
  const stdoutLines: string[] = []
  const runner = runCliJsonl({
    command: resolved.command,
    prefixArgs: resolved.prefixArgs,
    args: ['plugin', action, spec],
    cwd: home,
    idleTimeoutMs: PLUGIN_CLI_TIMEOUT_MS,
    onLine: () => {},
    onRaw: (line) => stdoutLines.push(line)
  })
  // 总超时强杀（idleTimeout 只防静默卡死；plugin install 输出稀疏，总闸必须独立计时）
  const totalTimer = setTimeout(() => {
    void runner.kill()
  }, PLUGIN_CLI_TIMEOUT_MS)
  const exitInfo = await runner.exited.finally(() => clearTimeout(totalTimer))
  const output = [...stdoutLines, exitInfo.stderrTail].join('\n').trim().slice(-OUTPUT_TAIL_CHARS)
  return { ok: exitInfo.code === 0, output }
}

/** 装插件：claude plugin install <spec>；spec 非法同步抛错（不 spawn） */
export function installClaudePlugin(home: string, spec: string): Promise<PluginCliResult> {
  return runPluginCli(home, 'install', spec)
}

/** 卸插件：claude plugin uninstall <spec> */
export function uninstallClaudePlugin(home: string, spec: string): Promise<PluginCliResult> {
  return runPluginCli(home, 'uninstall', spec)
}
