// 桌宠台词库与模型输出解析：零依赖纯函数（smoke 直连即公共 API）。
// 职责三件：①本地兜底台词（无预设/超时/解析失败时驱动宠物）；
// ②parsePetSayPayload 从模型文本稳健提取 {"say","action"}；
// ③三版 persona 预设模板（内联输出契约与宏缺失降级写法）。
import type { PetSayAction } from './pet'
import { weightedPick } from './pet'
import { fallbackActionWeights } from './pet-life'

/** 台词对应的动作五值（与 pet.json 状态子集对齐：无 fall/dragged 台词态） */
export type PetAction = PetSayAction

export type PetLineGroup = 'idle' | 'click' | 'drag' | 'land' | 'sleep' | 'think' | 'event_start' | 'event_done' | 'event_failed'

/** 本地台词分组：idle12 / click10 / drag6 / land4 / sleep4 / think6 / 事件×3 各6（每句 ≤20 字） */
export const PET_LINES: Record<PetLineGroup, string[]> = {
  idle: [
    '薄荷团子待命中～',
    '看板今天也很安静呢',
    '要不要派点任务给我？',
    '呼——晒会儿太阳',
    '任务完成记得夸我哦',
    '我在看着你的代码呢',
    '今天想先做哪件事？',
    '待机中，别忘了我呀',
    '伸个懒腰……唔！',
    '电脑前记得多喝水',
    '队列空空的，有点闲',
    '陪我聊两句嘛'
  ],
  click: [
    '嘿嘿，好痒呀！',
    '被摸头会开心的！',
    '呀！被抓到了～',
    '再戳我就要化了',
    '开心到冒泡！',
    '手感是不是很好？',
    '你也在偷懒吗？',
    '打卡！团子在线',
    '今天就拜托你啦',
    '精神满满！'
  ],
  drag: [
    '哇——飞起来啦！',
    '放……放我下来！',
    '抓稳我呀！',
    '我在空中游泳～',
    '头晕眼花中……',
    '这是特技表演！'
  ],
  land: [
    '稳稳落地！',
    '安全着地～',
    '差点摔个跟头',
    '拍拍灰，没事！'
  ],
  sleep: [
    '呼噜……呼噜……',
    '做个关于代码的梦',
    '困了，先眯一会儿',
    '叫我起来要大声哦'
  ],
  think: [
    '让我想想……',
    '唔，这题有点难',
    '灵感在路上……',
    '要不问问 AI 脑？',
    '嗯……有道理',
    '答案快出来了！'
  ],
  event_start: [
    '开工啦？我盯着哦',
    '任务跑起来了～',
    '这单我看着，放心',
    '新任务！加油加油',
    '我搬好小板凳了',
    '开工大吉～'
  ],
  event_done: [
    '任务完成！好耶！',
    '又打下一城！',
    '顺利收工，鼓掌！',
    '完成得真漂亮！',
    '要不要休息一下？',
    '这么快就搞定啦'
  ],
  event_failed: [
    '失败了也没关系',
    '抱抱，下次一定行',
    '别灰心，我陪你',
    '翻车了？摸摸头',
    '错误而已，不怕',
    '休息一下再战吧'
  ]
}

/** 兜底动作权重：idle70 / walk20 / sleep10（自主发言不能太闹） */
export const GROUP_ACTION_WEIGHTS: Array<{ action: PetAction; weight: number }> = [
  { action: 'idle', weight: 70 },
  { action: 'walk', weight: 20 },
  { action: 'sleep', weight: 10 }
]

const ACTION_GROUP: Record<PetAction, PetLineGroup> = {
  idle: 'idle',
  walk: 'idle',
  happy: 'click',
  think: 'think',
  sleep: 'sleep'
}

/** 按组随机取一句台词（rand 注入便于 smoke 断言） */
export function pickPetLine(group: PetLineGroup, rand: () => number = Math.random): string {
  const lines = PET_LINES[group]
  if (!lines.length) return ''
  return lines[Math.floor(rand() * lines.length) % lines.length]
}

/** 兜底动作权重（基线 idle70/walk20/sleep10）；带好感/心情时按 pet-life 偏置 */
export function pickFallbackSay(rand: () => number = Math.random, vars?: { affection?: number; mood?: number }): { say: string; action: PetAction } {
  const action = weightedPick(fallbackActionWeights(vars), rand).action
  return { say: pickPetLine(ACTION_GROUP[action], rand), action }
}

// —— 投喂台词（本地即时反馈，不走模型；food id → 两句） ——
export interface PetFood {
  id: string
  name: string
}

/** 投喂菜单（固定三样，id 稳定可持久化） */
export const PET_FOODS: PetFood[] = [
  { id: 'fish', name: '小鱼干' },
  { id: 'cookie', name: '薄荷饼干' },
  { id: 'daifuku', name: '草莓大福' }
]

export const PET_FOOD_LINES: Record<string, string[]> = {
  fish: ['呜哇！小鱼干！', '咔嚓咔嚓……香！'],
  cookie: ['薄荷味！是同类的味道', '嘎嘣脆，好吃！'],
  daifuku: ['软软的，幸福……', '草莓芯！最爱了！']
}

export function pickFoodLine(foodId: string, rand: () => number = Math.random): string {
  const lines = PET_FOOD_LINES[foodId] ?? PET_FOOD_LINES.cookie
  return lines[Math.floor(rand() * lines.length) % lines.length]
}

// —— 时间感知问候兜底台词：按时段各两句（LLM 不可用时的早安/晚安） ——
export type GreetBucket = '凌晨' | '早上' | '中午' | '下午' | '晚上'

export const GREET_LINES: Record<GreetBucket, string[]> = {
  凌晨: ['这么晚还没睡？注意身体呀', '凌晨的看板很安静呢……早'],
  早上: ['早安！今天也一起加油～', '早上好！我等你好久了'],
  中午: ['中午好！记得吃午饭哦', '午安～要不要歇一会儿？'],
  下午: ['下午好！继续努力呀', '下午茶时间，陪我玩会儿？'],
  晚上: ['晚上好，今天辛苦啦', '晚上好～看板今天怎么样？']
}

export function pickGreetLine(bucket: string, rand: () => number = Math.random): string {
  const lines = GREET_LINES[(bucket as GreetBucket) in GREET_LINES ? (bucket as GreetBucket) : '早上']
  return lines[Math.floor(rand() * lines.length) % lines.length]
}

const SAY_MAX = 30
const ACTIONS: readonly PetAction[] = ['idle', 'walk', 'happy', 'think', 'sleep']

/** 从候选片段解析 {"say","action"}：两字段齐且合法才收 */
function parseCandidate(candidate: string): { say: string; action: PetAction } | null {
  try {
    const obj = JSON.parse(candidate.trim()) as unknown
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
    const { say, action } = obj as { say?: unknown; action?: unknown }
    if (typeof say !== 'string') return null
    const trimmed = say.trim()
    if (!trimmed) return null
    if (typeof action !== 'string' || !ACTIONS.includes(action as PetAction)) return null
    // 按码点截断（emoji 不劈半）
    const clamped = [...trimmed].slice(0, SAY_MAX).join('')
    return { say: clamped, action: action as PetAction }
  } catch {
    return null
  }
}

/**
 * 从模型文本稳健提取 {"say","action"}：容忍 markdown 围栏与前后杂文。
 * 尝试顺序：```json 围栏 → 首个 { 到末个 } 的跨度 → 全文；全部失败返回 null。
 */
export function parsePetSayPayload(text: unknown): { say: string; action: PetAction } | null {
  if (typeof text !== 'string') return null
  const candidates: string[] = []
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) candidates.push(fenced[1])
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1))
  candidates.push(text)
  for (const candidate of candidates) {
    const parsed = parseCandidate(candidate)
    if (parsed) return parsed
  }
  return null
}

// —— persona 预设模板（宏缺失的降级写法内联在模板里：占位是「暂无」就自然跳过） ——
// 支持宏：{board_summary} 看板摘要 / {pack_name} 素材包 / {time_of_day} 时段 / {model} 模型名 / {recent_event} 最近看板事件
export interface PetPersonaPreset {
  id: 'lively' | 'calm' | 'sharp'
  label: string
  template: string
}

const OUTPUT_CONTRACT = [
  '输出契约（必须遵守）：只输出一个 JSON 对象，格式 {"say":"台词","action":"动作"}；',
  `say 为不超过 ${SAY_MAX} 字的中文台词；action 只能是 idle/walk/happy/think/sleep 之一；`,
  '除该 JSON 外不要输出任何解释、寒暄或代码块围栏。'
].join('\n')

const MACRO_LINE = [
  '当前信息：现在是{time_of_day}；看板概况——{board_summary}；最近看板事件——{recent_event}；素材包：{pack_name}；驱动模型：{model}。',
  '（上面某项是「暂无」或留空时，自然跳过它，不要在台词里提及或解释。）'
].join('\n')

export const PET_PERSONA_PRESETS: PetPersonaPreset[] = [
  {
    id: 'lively',
    label: '活泼',
    template: [
      '你是 AgentDeck 看板上的桌宠「薄荷团子」，性格活泼元气，说话短促可爱，爱用「～」和轻快语气，偶尔用一点拟声词。',
      MACRO_LINE,
      OUTPUT_CONTRACT
    ].join('\n')
  },
  {
    id: 'calm',
    label: '沉稳',
    template: [
      '你是 AgentDeck 看板上的桌宠「薄荷团子」，性格沉稳可靠，像一位安静的值班助手，说话简洁克制，不卖萌不堆感叹号。',
      MACRO_LINE,
      OUTPUT_CONTRACT
    ].join('\n')
  },
  {
    id: 'sharp',
    label: '毒舌',
    template: [
      '你是 AgentDeck 看板上的桌宠「薄荷团子」，嘴上毒舌心里关心主人：吐槽犀利、一句到位，但不带脏话、不讽刺人身、不施压。',
      MACRO_LINE,
      OUTPUT_CONTRACT
    ].join('\n')
  }
]

export const DEFAULT_PERSONA_TEMPLATE = PET_PERSONA_PRESETS[0].template
