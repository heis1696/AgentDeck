// 失败分类：把后端原始错误归成稳定 code + 人话标题 + 处置提示。
// 规则按序短路匹配；code 是稳定契约（UI/重试策略依赖），文案可以随时改。
import type { FailureInfo } from '../shared/types'

interface Rule {
  code: FailureInfo['code']
  re: RegExp
  title: string
  hint: string
  retryable: boolean
}

const RULES: Rule[] = [
  {
    code: 'cli_missing',
    re: /spawn|ENOENT|EINVAL|PATH 上找不到|找不到 zcode|未知后端|可执行文件/i,
    title: 'CLI 未安装或无法启动',
    hint: '在「设置」页点"检测可用性"；确认 CLI 已装好且在 PATH 上（zcode / dsh 需在设置里指定路径）。',
    retryable: false
  },
  {
    code: 'protocol_config',
    re: /ZCODE_RUNTIME_MODEL_UNAVAILABLE|app-server|协议|config/i,
    title: '运行时配置或协议异常',
    hint: 'zcode 的 CLI 配置可能缺失或版本不兼容；重启应用会重新生成 ~/.zcode/cli/config.json，仍失败请检查 zcode 版本。',
    retryable: false
  },
  {
    code: 'provider_auth',
    re: /\b401\b|\b403\b|unauthorized|forbidden|authentication|登录已过期|凭证|api[ _-]?key/i,
    title: '模型凭证无效',
    hint: '对应平台的登录态或 API key 失效；到该 CLI 里重新登录后再重试。',
    retryable: false
  },
  {
    code: 'provider_quota',
    re: /\b402\b|quota|余额不足|insufficient|欠费/i,
    title: '配额或余额不足',
    hint: '检查对应模型平台的配额与余额，充值或换账号后重试。',
    retryable: false
  },
  {
    code: 'rate_limit',
    re: /\b429\b|\b529\b|rate.?limit|too many requests|限流/i,
    title: '被限流',
    hint: '请求过于频繁；稍等片刻再重试即可。',
    retryable: true
  },
  {
    code: 'output_limit',
    re: /输出超过|疑似模型生成循环|输出上限|maxBytes|5MB/i,
    title: '输出超限（疑似生成循环）',
    hint: '回合输出被强制截断；请缩小任务范围或拆分后重试。',
    retryable: false
  },
  {
    code: 'context_overflow',
    re: /context length|上下文|token limit|maximum context|context window/i,
    title: '上下文超限',
    hint: '会话历史过长；用"重新运行"开新会话，或缩小任务范围。',
    retryable: false
  },
  {
    code: 'timeout',
    re: /超时|timed?\s?out|等待回合|30 分钟|120s|无输出/i,
    title: '执行超时',
    hint: '模型长时间无进展；可直接重试；频繁出现请缩小任务范围。',
    retryable: true
  },
  {
    code: 'sandbox',
    re: /sandbox|沙箱|code -1|exit code -1/i,
    title: '沙箱/环境异常',
    hint: 'Windows 下 codex 必须绕过沙箱（适配器已内置该参数）；反复出现请检查杀毒软件拦截。',
    retryable: true
  },
  {
    code: 'process_crash',
    re: /进程退出|exit code|非零退出|crash|killed/i,
    title: 'CLI 进程异常退出',
    hint: '通常是一过性问题，可直接重试；复现请查看错误原文末尾的 stderr。',
    retryable: true
  }
]

/** 兜底分类 */
const UNKNOWN: FailureInfo = {
  code: 'unknown',
  title: '未知错误',
  hint: '查看错误原文定位；可手动重试一次。',
  retryable: false
}

export function classifyFailure(input: { error: string; backend?: string }): FailureInfo {
  const text = input.error || ''
  for (const r of RULES) {
    if (r.re.test(text)) return { code: r.code, title: r.title, hint: r.hint, retryable: r.retryable }
  }
  return UNKNOWN
}
