// 应用设置：userData/settings.json
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { DEFAULT_SETTINGS, type AppSettings } from '../shared/types'

const file = () => path.join(app.getPath('userData'), 'settings.json')

export function loadSettings(): AppSettings {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8')) as Partial<AppSettings> & { squadMaxWorkers?: number }
    // 迁移：0.3.x 的 squadMaxWorkers → workerConcurrency
    const legacy = raw.squadMaxWorkers
    delete raw.squadMaxWorkers
    return { ...DEFAULT_SETTINGS, ...raw, ...(legacy != null && raw.workerConcurrency == null ? { workerConcurrency: legacy } : {}) }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(s: AppSettings): AppSettings {
  fs.mkdirSync(path.dirname(file()), { recursive: true })
  fs.writeFileSync(file(), JSON.stringify(s, null, 2))
  return s
}
