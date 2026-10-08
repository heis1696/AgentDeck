// 应用设置：userData/settings.json
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { DEFAULT_SETTINGS, type AppSettings } from '../shared/types'
import { atomicWriteJson } from './persistence'

const file = () => path.join(app.getPath('userData'), 'settings.json')

export function loadSettings(): AppSettings {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8')) as Partial<AppSettings> & { squadMaxWorkers?: number }
    // 迁移：0.3.x 的 squadMaxWorkers → workerConcurrency
    const legacy = raw.squadMaxWorkers
    delete raw.squadMaxWorkers
    const merged = { ...DEFAULT_SETTINGS, ...raw, ...(legacy != null && raw.workerConcurrency == null ? { workerConcurrency: legacy } : {}) }
    // 设置文件可能被手改或由旧版本写入：界面字号读取时归一化到 [12,16] 整数，非法值回默认
    // （IPC 写入侧已校验，这里兜读取侧——越界值会直接生成 1000px 之类的字号撑爆布局）
    if (!Number.isInteger(merged.uiFontSize) || merged.uiFontSize < 12 || merged.uiFontSize > 16) {
      merged.uiFontSize = DEFAULT_SETTINGS.uiFontSize
    }
    return merged
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(s: AppSettings): AppSettings {
  // 原子写（唯一 tmp + fsync + rename）：写失败不再留下被截断的 settings.json
  atomicWriteJson(file(), s)
  return s
}
