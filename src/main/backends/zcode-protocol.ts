import { isJsonObject, type JsonObject } from './cli-common'
import type { ZcodeWireMessage } from './zcode-transport'

export function zcodeRecord(value: unknown): JsonObject {
  return isJsonObject(value) ? value : {}
}

export function zcodeString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

export function compactToolArgs(args?: string): string {
  if (!args) return ''
  try {
    const serialized = JSON.stringify(JSON.parse(args) as unknown)
    return serialized.length > 200 ? `${serialized.slice(0, 200)}…` : serialized
  } catch {
    return args.slice(0, 200)
  }
}

export function sessionEvent(message: ZcodeWireMessage): { type: string; payload: JsonObject } | null {
  if (message.method !== 'session/event' && message.method !== 'session/event/v2') return null
  const params = zcodeRecord(message.params)
  return { type: zcodeString(params.type), payload: zcodeRecord(params.payload) }
}

export function runtimePreferences() {
  return {
    askUserQuestionAutoResolutionEnabled: true,
    nativeSearchEnhancementsEnabled: true,
    memoryEnabled: false,
    modelContextBudgetStrategy: 'preflight-v1'
  }
}

/** Preserve both terminal and streamed sources when either carries delegation markup. */
export function mergeTurnTexts(full: string, streamed: string): string {
  if (!streamed) return full
  if (!full) return streamed
  const compact = (value: string) => value.replace(/\s+/g, '')
  if (compact(full).includes(compact(streamed))) return full
  if (compact(streamed).includes(compact(full))) return streamed
  return `${streamed}\n${full}`
}
