// 应用设置：userData/settings.json
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { DEFAULT_SETTINGS, type AppSettings } from '../shared/types'

const file = () => path.join(app.getPath('userData'), 'settings.json')

export function loadSettings(): AppSettings {
  try {
    const raw = fs.readFileSync(file(), 'utf8')
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(s: AppSettings): AppSettings {
  fs.mkdirSync(path.dirname(file()), { recursive: true })
  fs.writeFileSync(file(), JSON.stringify(s, null, 2))
  return s
}
