// dsh 凭证代差桥接。
// ~/.dsh 是本机所有 dsh 安装共用的家目录。桌面版的 dsh-credentials-local（0.2.x）启动时把
// .credentials.yaml 原地迁成 version-1 结构（version / refs / records），而 AgentDeck 调用的
// 源码版 CLI（0.1.x）只认发布前的扁平「键 → 非空字符串」布局——新写旧读，插件在启动期就抛
// `the value for "version" … must be a string`，ACP 与 headless 两条路一起起不来。
// 桥接不碰 ~/.dsh：AgentDeck 在应用数据目录下同步一份老格式投影（镜像凭证引用），把
// dsh-credentials-local 的 path 指过去——path / watch 两个配置项新老插件同义，源码版升级后
// 仍安全。key 照旧走托管文档而非进程环境：dsh 刻意不让凭证进 process.env，否则 agent 跑的
// shell 工具一条 env 就把 key 打进对话记录。凭证文档是老格式或不存在时整段不生效。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface DshCredentialsBridge {
  /** 老格式凭证投影：每次启动 dsh 前从 ~/.dsh 同步 */
  documentPath: string
  /** headless 的 --patch 覆盖层：把 profile 里 credentials 行的 path 指到投影 */
  patchPath: string
}

export interface DshCredentialsDocument {
  /** 含 0.1.x 插件读不了的条目（version-1 结构的数字 version、refs / records 嵌套节）：必须桥接 */
  versioned: boolean
  /** 凭证引用 → 值：有 refs 节取其直属条目，否则取顶层全部条目 */
  refs: Record<string, string>
}

/** 顶层/嵌套的 `key: value` 行；value 缺省即空（嵌套节或空值） */
const ENTRY = /^([A-Za-z_][\w.-]*)\s*:(?:\s+(.*?))?\s*$/
/** 带引号的标量（可跟行尾注释）：双引号按 YAML 双引号转义还原，单引号以 '' 转义单引号 */
const QUOTED = /^(("(?:[^"\\]|\\.)*")|'(?:[^']|'')*')(?:\s+#.*)?$/
/** YAML 1.2 core schema 下不是字符串的字面量：数字 / 布尔 / 空 */
const NON_STRING_LITERAL = /^(?:[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|true|false|null|~)$/i

function scalar(raw: string): string {
  const quoted = QUOTED.exec(raw)
  if (!quoted) return raw.startsWith('#') ? '' : raw.replace(/\s+#.*$/, '')
  const text = quoted[1]
  if (text[0] !== '"') return text.slice(1, -1).replace(/''/g, "'")
  // JSON 转义是 YAML 双引号转义的子集；还原不出字符串的原样去引号（留 dsh 侧报鉴权失败）
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'string' ? parsed : text.slice(1, -1)
  } catch {
    return text.slice(1, -1)
  }
}

/**
 * 认文档结构，不依赖 YAML 库：只取标量条目，其余行（列表项、records 下的嵌套、多行文本）
 * 一律跳过。判据照搬 0.1.x 插件的验收口径——文档里出现它读不了的条目（空值嵌套节、数字 /
 * 布尔字面量）即 versioned。version-1 结构的 `version: 1` 与 refs / records 节正好落在这里；
 * 正常的扁平文档不会。凭证引用：有 refs 节取其直属条目，否则取顶层全部条目。
 */
export function parseDshCredentialsDocument(text: string): DshCredentialsDocument {
  const doc: DshCredentialsDocument = { versioned: false, refs: {} }
  const top: Record<string, string> = {}
  const section: Record<string, string> = {}
  let inRefs = false
  let sawRefs = false
  // refs 节首个子行的缩进：只认同一缩进的直属条目
  let refsIndent = -1
  for (const raw of text.split(/\r?\n/)) {
    const body = raw.replace(/\s+$/, '')
    if (!body.trim() || body.trimStart().startsWith('#')) continue
    const indent = body.length - body.trimStart().length
    const entry = ENTRY.exec(body.trimStart())
    if (!entry) continue
    const key: string = entry[1]
    const value: string | undefined = entry[2] || undefined
    if (indent === 0) {
      inRefs = false
      refsIndent = -1
      if (value === undefined || NON_STRING_LITERAL.test(value)) {
        doc.versioned = true
        if (key === 'refs') {
          inRefs = true
          sawRefs = true
        }
        continue
      }
    } else if (!inRefs || (refsIndent >= 0 && indent !== refsIndent)) {
      // 嵌套行只在 refs 节内认直属条目：records 下的 payload.version 等不得混进凭证引用
      continue
    } else {
      refsIndent = indent
    }
    const parsed = scalar(value ?? '')
    if (parsed) (indent === 0 ? top : section)[key] = parsed
  }
  doc.refs = sawRefs ? section : top
  return doc
}

/** dsh 凭证文档位置（与 dsh-credentials-local 的缺省解析同源：$DSH_HOME，否则 ~/.dsh） */
export function dshCredentialsFile(dshHome?: string): string {
  return path.join(dshHome ?? process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), '.credentials.yaml')
}

function readDocument(file: string): DshCredentialsDocument | null {
  try {
    return parseDshCredentialsDocument(fs.readFileSync(file, 'utf8'))
  } catch {
    // 不存在或读不了：当作没有文档，交给 dsh 自己报
    return null
  }
}

/** 只读探测（设置页用）：文档不存在/读不了返回 null */
export function readDshCredentialsDocument(dshHome?: string): DshCredentialsDocument | null {
  return readDocument(dshCredentialsFile(dshHome))
}

/** dsh-credentials-local 的 config 行（indent 为 config 键自身的缩进）：path → 投影，关 watch */
export function dshCredentialsRedirectYaml(indent: string, documentPath: string): string {
  const yamlPath = JSON.stringify(documentPath.replace(/\\/g, '/'))
  return `${indent}config:\n${indent}  path: ${yamlPath}\n${indent}  watch: false\n`
}

const PROJECTION_NAME = 'dsh-credentials.yaml'
const PATCH_NAME = 'dsh-credentials.patch.yml'

const PROJECTION_HEADER = [
  '# AgentDeck 的 dsh 凭证投影——请勿手改，启动 dsh 前自动同步。',
  '# ~/.dsh/.credentials.yaml 已是 0.2.x 的 version-1 结构，AgentDeck 调用的 0.1.x dsh 读不了；',
  '# 这里只镜像其中的凭证引用（refs），供 dsh-credentials-local 经 path 读取。',
  ''
].join('\n')

function renderProjection(refs: Record<string, string>): string {
  return PROJECTION_HEADER + Object.entries(refs).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n') + '\n'
}

function renderPatch(documentPath: string): string {
  return [
    '# AgentDeck 的 dsh 凭证桥接（headless 覆盖层）——请勿手改，启动 dsh 前自动同步。',
    '# ~/.dsh/.credentials.yaml 已是 0.2.x 的 version-1 结构，0.1.x 的 dsh 读不了：',
    '# 把 profile 里 credentials 行的 path 指到 AgentDeck 同步的老格式投影。',
    '- id: credentials',
    "  name: '@deepseek-ai/dsh-credentials-local'",
    dshCredentialsRedirectYaml('  ', documentPath).trimEnd(),
    ''
  ].join('\n')
}

function sameRefs(left: Record<string, string> | undefined, right: Record<string, string>): boolean {
  const keys = Object.keys(right)
  if (!left || Object.keys(left).length !== keys.length) return false
  return keys.every((key) => left[key] === right[key])
}

/** 先写同目录临时文件再改名：并发启动的 dsh 读到的一定是完整内容 */
function writeAtomic(file: string, content: string): void {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    // 0600：凭证文档不对属主以外开放（Windows 无 mode 可言，按 ACL 走）
    fs.writeFileSync(tmp, content, { mode: 0o600 })
    fs.renameSync(tmp, file)
  } catch (error) {
    fs.rmSync(tmp, { force: true })
    throw error
  }
}

/**
 * 把凭证引用同步成老格式投影与 headless 覆盖层。幂等：内容没变不重写（0.2.x 插件若把投影
 * 原地迁成 version-1 结构，值不变也算已同步）；引用清空时删掉投影，不残留已移除的 key。
 */
export function syncDshCredentialsBridge(refs: Record<string, string>, dir: string): DshCredentialsBridge {
  const documentPath = path.join(dir, PROJECTION_NAME)
  const patchPath = path.join(dir, PATCH_NAME)
  const patch = renderPatch(documentPath)
  const write = (file: string, content: string) => {
    fs.mkdirSync(dir, { recursive: true })
    writeAtomic(file, content)
  }
  if (Object.keys(refs).length === 0) {
    fs.rmSync(documentPath, { force: true })
  } else {
    const onDisk = readDocument(documentPath)
    if (!sameRefs(onDisk?.refs, refs)) write(documentPath, renderProjection(refs))
  }
  let patchOnDisk = ''
  try {
    patchOnDisk = fs.readFileSync(patchPath, 'utf8')
  } catch {}
  if (patchOnDisk !== patch) write(patchPath, patch)
  return { documentPath, patchPath }
}

/** 判定并同步：文档不存在或是老格式返回 null（不干预，dsh 自己读 ~/.dsh） */
export function resolveDshCredentialsBridge(opts: { dshHome?: string; dir?: string } = {}): DshCredentialsBridge | null {
  const doc = readDshCredentialsDocument(opts.dshHome)
  if (!doc?.versioned) return null
  // 投影含密钥，只落应用数据目录；没给目录时退到系统临时目录（本用户私有）
  return syncDshCredentialsBridge(doc.refs, opts.dir ?? path.join(os.tmpdir(), 'agentdeck-dsh-credentials'))
}
