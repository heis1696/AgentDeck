/**
 * 渲染层路径等价键：与主进程 git.ts 的 worktreePathKey（path.resolve + win32 大小写
 * 折叠）同一套判定语义，供最近工作区去重与当前项判定使用。
 *
 * 渲染层 bundle 不含 node:path（无 node 集成），这里按同一套规则做纯字符串规范化：
 * 分隔符混用归一、`.`/`..` 段消解、尾部分隔符剥离、win32 大小写折叠。输入契约是
 * 主进程/文件选择器给出的绝对路径（最近工作区与当前工作区目录），相对路径不在契约内。
 * win32 盘符根（`C:\`）与 POSIX 根（`/`）自带分隔符，规范化后保留——键始终不带尾随
 * 分隔符（除根本身），与主进程键可直接对照。
 *
 * `..` 段弹出有根下界，与主进程 path.resolve 的根语义逐一对齐：
 *   - win32 UNC（`\\server\share`）：前两段 server/share 属于根前缀，`..` 不得弹出——
 *     `\\server\share\..` resolve 后停在 `\\server\share\`（共享根自带尾分隔符），
 *     键必须同为共享根；share 缺位时（`\\server\..`，超出工作区目录契约的病态输入）
 *     resolve 把 `..` 字面保留在 server 段之后，这里同样保留字面段对齐。
 *   - 盘符根 / POSIX 根：`..` 弹到空前缀即止，多余的 `..` 丢弃（`c:\..` → `c:\`）。
 */
export function sharedPathKey(candidate: string): string {
  const raw = typeof candidate === 'string' ? candidate : ''
  if (!raw) return ''
  const win32 = typeof process !== 'undefined' && process.platform === 'win32'
  const sep = win32 ? '\\' : '/'
  // win32 双分隔符开头（UNC）优先于单根判定：//server/share 与 \\server\share 同根
  const unc = win32 && /^[\\/]{2}/.test(raw)
  const segments: string[] = []
  for (const segment of raw.split(win32 ? /[\\/]+/ : /\/+/)) {
    if (!segment || segment === '.') continue
    // 盘符段由前缀承载，不再作为路径段参与拼接
    if (win32 && /^[A-Za-z]:$/.test(segment)) continue
    if (segment === '..') {
      // UNC 根前缀占两段：server/share 段不可弹出（弹出即越过共享根，与主进程键脱钩）；
      // server 段之后还没锚定 share 时，`..` 按主进程语义字面保留而非消解
      if (unc && segments.length < 2) {
        segments.push('..')
      } else if (segments.length > (unc ? 2 : 0)) {
        segments.pop()
      }
      continue
    }
    segments.push(segment)
  }
  const drive = win32 ? /^[A-Za-z]:/.exec(raw)?.[0] : undefined
  const prefix = drive
    ? `${drive}${sep}`
    : unc
      ? sep.repeat(2)
      : raw.startsWith('/')
        ? '/'
        : ''
  // UNC 恰好停在共享根（server/share 两段或其 `..` 字面变体）时补尾分隔符，
  // 与主进程 resolve 的共享根形态（`\\server\share\`）逐字节同键
  const key = prefix + segments.join(sep) + (unc && segments.length === 2 ? sep : '')
  return win32 ? key.toLowerCase() : key
}

/** 最近工作区上浮：按路径键去重（别名写法不再重复展示/持久化），最新写法置顶，超限截断。 */
export function pushRecentWorkspace(current: ReadonlyArray<string>, dir: string, cap: number): string[] {
  if (!dir) return [...current]
  const key = sharedPathKey(dir)
  return [dir, ...current.filter((item) => sharedPathKey(item) !== key)].slice(0, Math.max(0, cap))
}

/** 最近工作区并入（任务里出现过的目录）：按路径键判重，已有条目及其别名写法都不重复
 *  加入，保持原顺序，超限截断。 */
export function extendRecentWorkspaces(current: ReadonlyArray<string>, dirs: ReadonlyArray<string>, cap: number): string[] {
  const next = [...current]
  for (const dir of dirs) {
    if (!dir) continue
    const key = sharedPathKey(dir)
    if (next.some((item) => sharedPathKey(item) === key)) continue
    next.push(dir)
  }
  return next.slice(0, Math.max(0, cap))
}
