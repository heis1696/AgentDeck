// Windows 兼容的 CLI 查找：npm 全局装的是 .cmd 垫片，Node 18+ 禁止直接 spawn .cmd
// 解析垫片找到真实目标：原生 .exe 直接用；node 脚本用 node 跑
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'

/** 在 PATH 里找可执行文件；找不到返回 null */
export function findOnPath(name: string): string | null {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  const dirs = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')
  for (const dir of dirs) {
    if (!dir) continue
    for (const ext of exts) {
      const full = path.join(dir, name + ext)
      try {
        if (fs.existsSync(full)) return full
      } catch {}
    }
  }
  return null
}

/**
 * 找系统安装的 node.exe。Electron 应用里 process.execPath 是 GUI 的
 * electron/exe，充当 node 跑第三方 CLI 时必须带 ELECTRON_RUN_AS_NODE=1，
 * 且 Electron 内置 Node 版本可能与目标 CLI 的模块解析不兼容，
 * 优先用系统 node，找不到才回退 process.execPath
 */
export function findSystemNode(): string | null {
  const onPath = findOnPath('node')
  if (onPath && onPath.endsWith('.exe')) return onPath
  const roots = [process.env.ProgramFiles ?? 'C:\\Program Files', process.env['ProgramFiles(x86)']].filter(Boolean) as string[]
  for (const root of roots) {
    const full = path.join(root, 'nodejs', 'node.exe')
    if (fs.existsSync(full)) return full
  }
  return null
}

export interface ResolvedCli {
  /** 可直接 spawn 的命令 */
  command: string
  /** 前置参数（如 node 跑脚本时的脚本路径） */
  prefixArgs: string[]
  /** 原始找到的路径 */
  origin: string
}

/**
 * 解析 CLI 为可直接 spawn 的形态。
 * - 原生 exe → {command: exe路径}
 * - npm .cmd 垫片 → 读垫片内容找 node_modules 里的目标 js，用 node 跑；
 *   包内若带平台 exe（如 claude/codex 的原生二进制）优先用 exe
 */
export function resolveCli(name: string): ResolvedCli | null {
  const found = findOnPath(name)
  if (!found) return null
  if (found.endsWith('.exe') || (!found.endsWith('.cmd') && !found.endsWith('.bat'))) {
    return { command: found, prefixArgs: [], origin: found }
  }
  // .cmd 垫片：npm 布局 <dir>/<name>.cmd + <dir>/node_modules/<pkg>/...
  // 垫片最后一行是 "%dp0%\node_modules\<pkg>\<target>" %* —— 原样提取
  const dir = path.dirname(found)
  let pkgAndTarget: { pkg: string; target: string } | null = null
  try {
    const content = fs.readFileSync(found, 'utf8')
    // 从后往前找最后一个 node_modules 引用（执行行在垫片末尾）：
    // 形如 "%dp0%\node_modules\<pkg>\<target>" %*
    const all = [...content.matchAll(/node_modules\\(@[^\\]+\\[^\\]+|[^\\]+)\\([^\s"%]+)/g)]
    if (all.length) pkgAndTarget = { pkg: all[all.length - 1][1], target: all[all.length - 1][2] }
  } catch {}
  const candidates: Array<{ file: string; isJs: boolean }> = []
  if (pkgAndTarget) {
    const target = path.join(dir, 'node_modules', pkgAndTarget.pkg, pkgAndTarget.target)
    if (fs.existsSync(target)) {
      if (target.endsWith('.exe')) return { command: target, prefixArgs: [], origin: found }
      const isJs = /\.(js|cjs|mjs)$/.test(target)
      // 无扩展名脚本：看首行 shebang 判断是否 node 脚本
      let js = isJs
      if (!isJs) {
        try {
          const head = fs.readFileSync(target, 'utf8').slice(0, 200)
          js = head.startsWith('#!')
        } catch {}
      }
      candidates.push({ file: target, isJs: js })
    }
  }
  for (const c of candidates) {
    if (c.isJs) return { command: process.execPath, prefixArgs: [c.file], origin: found }
    return { command: c.file, prefixArgs: [], origin: found }
  }
  return null
}

/** 探测 CLI 版本（存在性 + 版本号） */
export function probeCli(name: string, args = ['--version']): Promise<{ ok: boolean; version?: string; path?: string; error?: string }> {
  return new Promise((resolve) => {
    const resolved = resolveCli(name)
    if (!resolved) return resolve({ ok: false, error: `PATH 上找不到 ${name}` })
    execFile(resolved.command, [...resolved.prefixArgs, ...args], { timeout: 15000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve({ ok: false, path: resolved.origin, error: String(err.message).slice(0, 120) })
      resolve({ ok: true, path: resolved.origin, version: stdout.trim().split('\n')[0].slice(0, 60) })
    })
  })
}
