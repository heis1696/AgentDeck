import fs from 'node:fs'
import path from 'node:path'
import type { Automation } from '../shared/types'

export class AutomationStore {
  private readonly file: string
  private items: Automation[] = []
  constructor(userDataDir: string) {
    const dir = path.join(userDataDir, 'automations')
    fs.mkdirSync(dir, { recursive: true })
    this.file = path.join(dir, 'index.json')
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as unknown
      if (Array.isArray(parsed)) this.items = parsed.filter(isAutomation)
    } catch { /* first launch */ }
  }
  private save() { const tmp = `${this.file}.tmp`; fs.writeFileSync(tmp, JSON.stringify(this.items, null, 2)); fs.renameSync(tmp, this.file) }
  list() { return [...this.items].sort((a, b) => b.createdAt - a.createdAt) }
  get(id: string) { return this.items.find((item) => item.id === id) }
  create(input: Pick<Automation, 'name' | 'prompt' | 'workdir' | 'scheduleMinutes' | 'output'> & Partial<Pick<Automation, 'agentId' | 'enabled'>>): Automation {
    const now = Date.now()
    const minutes = Math.max(1, Math.round(input.scheduleMinutes || 60))
    const item: Automation = { id: `auto_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`, name: input.name.trim() || 'Untitled automation', prompt: input.prompt.trim(), workdir: input.workdir || '', agentId: input.agentId, scheduleMinutes: minutes, output: input.output, enabled: input.enabled ?? true, createdAt: now, nextRunAt: now + minutes * 60_000 }
    this.items.push(item); this.save(); return item
  }
  update(id: string, patch: Partial<Automation>) { const item = this.get(id); if (!item) return null; Object.assign(item, patch); if (patch.scheduleMinutes) item.scheduleMinutes = Math.max(1, Math.round(patch.scheduleMinutes)); this.save(); return item }
  remove(id: string) { const before = this.items.length; this.items = this.items.filter((item) => item.id !== id); if (this.items.length !== before) this.save(); return this.items.length !== before }
  markRun(id: string, now = Date.now()) { const item = this.get(id); if (!item) return null; item.lastRunAt = now; item.nextRunAt = now + item.scheduleMinutes * 60_000; this.save(); return item }
}

function isAutomation(value: unknown): value is Automation {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<Automation>
  return typeof item.id === 'string' && typeof item.name === 'string' && typeof item.prompt === 'string' && typeof item.scheduleMinutes === 'number'
}
