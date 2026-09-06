import type { AgentBackend } from './backends/types'
import type { RuntimeSnapshot, Task } from '../shared/types'

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Probe timed out')), timeoutMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function probeRuntimes(backends: Iterable<AgentBackend>, tasks: Task[], timeoutMs = 20_000): Promise<RuntimeSnapshot[]> {
  const active = new Map<string, number>()
  for (const task of tasks) if (task.status === 'running') active.set(task.backend, (active.get(task.backend) ?? 0) + 1)
  const checkedAt = Date.now()
  return Promise.all([...backends].map(async (backend): Promise<RuntimeSnapshot> => {
    try {
      const result = await withTimeout(backend.probe(), timeoutMs)
      const version = result.detail.match(/\b(?:v|version\s*)?([0-9]+\.[0-9]+(?:\.[0-9]+)?(?:[-+][\w.-]+)?)\b/i)?.[1]
      return { id: backend.id, label: backend.label, backend: backend.id, kind: 'local', health: result.ok ? 'online' : 'offline', detail: result.detail, ...(version ? { version } : {}), activeTaskCount: active.get(backend.id) ?? 0, checkedAt }
    } catch (error) {
      return { id: backend.id, label: backend.label, backend: backend.id, kind: 'local', health: 'offline', detail: error instanceof Error ? error.message : String(error), activeTaskCount: active.get(backend.id) ?? 0, checkedAt }
    }
  }))
}
