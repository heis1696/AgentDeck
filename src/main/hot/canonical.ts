// 签名规范化序列化（设计 §2.3）：发布脚本与 verifier 共用同一实现，保证"同输入 → 同字节"。
// 规则：递归剔除 undefined 的对象键；键名按 UTF-8 字节序排序；以 JSON.stringify 序列化。

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    // 数组元素保持 JSON.stringify 语义：undefined 位序列化为 null
    return value.map((item) => (item === undefined ? null : canonicalize(item)))
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const keys = Object.keys(source).filter((key) => source[key] !== undefined)
    keys.sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')))
    const out: Record<string, unknown> = {}
    for (const key of keys) out[key] = canonicalize(source[key])
    return out
  }
  return value
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value)) as string
}
