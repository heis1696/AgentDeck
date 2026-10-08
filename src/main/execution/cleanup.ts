// 清扫原语：带超时的清理等待与「失败只收集、不中断」的严格退出确认。
// 自 runner.ts 原样搬迁（批次 1，零行为变化）——四个函数体均不引用 this，方法改自由函数。

/** Cleanup must be awaited, but a broken provider must not block cancellation
 * or application shutdown indefinitely. */
function awaitCleanup(action: () => Promise<unknown> | void, timeoutMs = 2_000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    let timer: NodeJS.Timeout
    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(ok)
    }
    timer = setTimeout(() => finish(false), timeoutMs)
    Promise.resolve().then(action).then(() => finish(true), () => finish(false))
  })
}

function strictCleanup(action: () => Promise<unknown> | unknown, label: string, problems: string[], timeoutMs = 4_000): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      problems.push(`${label}: 超时（${Math.round(timeoutMs / 1000)}s）`)
      resolve()
    }, timeoutMs)
    Promise.resolve().then(action).then((value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (value === false || value && typeof value === 'object' && (value as { ok?: unknown }).ok === false) {
        problems.push(`${label}: ${String((value as { error?: unknown }).error ?? '操作未成功')}`)
      }
      resolve()
    }, (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      problems.push(`${label}: ${error instanceof Error ? error.message : String(error)}`)
      resolve()
    })
  })
}

async function awaitExit(promise: Promise<unknown> | undefined, label: string, problems: string[], timeoutMs: number): Promise<void> {
  if (!promise) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => { problems.push(`${label}: 超时`); resolve() }, timeoutMs)
    void promise.then(() => { clearTimeout(timer); resolve() }, (error) => {
      clearTimeout(timer)
      problems.push(`${label}: ${String(error)}`)
      resolve()
    })
  })
}

async function checkedCleanup(action: () => Promise<unknown> | unknown): Promise<void> {
  const value = await action()
  if (value === false || value && typeof value === 'object' && (value as { ok?: unknown }).ok === false) {
    throw new Error(value && typeof value === 'object' ? String((value as { error?: unknown }).error ?? '退出未确认') : '退出未确认')
  }
}

export { awaitCleanup, strictCleanup, awaitExit, checkedCleanup }
