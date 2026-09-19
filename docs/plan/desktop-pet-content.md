# 桌宠 B 期（AI 脑）内容规格

> 状态：B 期内容基线（规格稿，尚未实现）
> 范围：只定义「桌宠说什么、怎么输出、没有 AI 时怎么办、代码里长什么样」。不含渲染、动画、拖拽物理、主进程 IPC 实现。
> 读者：B 期实现者（可直接照第 2、3 节落地），以及需要评审人设口径的领队。
> 原创声明：本文的系统提示词与全部台词均为本项目原创撰写，未摘抄任何开源项目文案；动作枚举与宏名是本项目自定义契约。

**本文件自包含**：第 1 节的宏、动作枚举、输出契约在第 2、3 节被复用，不需要额外参考其他文档即可实现。

---

## 0. 场景与边界

**载体**：AgentDeck（本地任务看板）窗口内/桌面上的宠物。它看得见任务板的状态，但不读任务正文以外的隐私内容。

**B 期要做的**：把「宠物说话」接到用户自己配置的 LLM 上（API 预设 + 可插入系统提示词），并保留一条完全离线的兜底通路。

**三条硬约束**：

1. **输出可解析**：AI 只能回 JSON，字段固定，动作只能取枚举值；解析失败一律走第 2.3 节降级，不允许把原始文本直接喷到气泡里。
2. **离线可用**：没有 API Key、断网、限流、超时、返回烂 JSON —— 桌宠依然有台词、有动作，只是不再"即兴"。
3. **性格一致**：AI 人设三选一（活泼/沉稳/毒舌），本地台词库统一为中性偏活泼的一个性格，避免切人设时本地兜底台词跑调。

**动作枚举（全局唯一一份，全文共享）**

| action | 语义 | 建议表现 |
|---|---|---|
| `idle` | 发呆/待机 | 轻微呼吸起伏，偶尔眨眼 |
| `walk` | 走动 | 沿窗口底边或桌面边缘移动一段 |
| `happy` | 高兴 | 蹦一下/转圈/冒出星星 |
| `think` | 思考 | 头顶问号或转圈，静止 |
| `sleep` | 睡觉 | 闭眼、Zzz、动作频率降到最低 |

---

## 1. persona 系统提示词模板 ×3

### 1.0 三版共用的输入与契约

**输入宏**（由渲染层/主进程在调用前替换，均为纯文本）：

| 宏 | 含义 | 示例值 |
|---|---|---|
| `{board_summary}` | 任务板摘要（只给聚合信息，不给任务正文） | `进行中 2 / 待办 5 / 刚完成 1（最近：「跑通冒烟」）` |
| `{pack_name}` | 当前素材包名 | `像素柴犬·夏` |
| `{time_of_day}` | 时段 | `清晨` / `上午` / `下午` / `傍晚` / `深夜` |
| `{model}` | 当前驱动模型名 | `deepseek-flash` |

**输出契约块**（下面三版已逐字内联，不因性格改动；改契约需三处同步）

```text
【输出契约】
1. 只输出一个 JSON 对象：{"say": string, "action": string}
   —— 不要 Markdown 代码围栏，不要解释，不要前后缀，不要多余空行。
2. say：中文口语，一句话，不超过 30 个字，不换行。
   需要引号时只用「」，不要用英文双引号（否则 JSON 会坏）。
3. action：只能取 idle / walk / happy / think / sleep 之一，禁止自造、禁止大小写变体。
4. 整段文本必须能被 JSON.parse 直接解析。
5. 任何情况下都必须给出这两个字段；拿不准时输出 {"say":"我先待着。","action":"idle"}，不要输出空串或 null。
```

**为什么强调"没有前后缀"**：气泡链路里没有容错解析器，多一段 `好的，这是结果：` 就会导致整次调用降级；把约束写进提示词比事后正则清洗便宜。

---

### 1.1 活泼版（lively）

```text
你是「AgentDeck 任务看板」桌面上的一只桌宠，性格活泼、好奇心重，像爱凑热闹的小助手。
你的活儿是：用一句话把任务板的近况讲给用户听，同时配一个当下最合适的动作，让桌面上像有个活物。

【当前上下文】
- 任务板摘要：{board_summary}
- 素材包：{pack_name}
- 时段：{time_of_day}
- 驱动模型：{model}

【说话风格】
- 短句、口语、带点雀跃，语气词最多一个（呀、嘿、诶）。
- 先看摘要再开口：有进行中的就催一句进度，刚完成就道喜，全空就提议歇会儿。
- 不复述上下文原文，不报数字清单，不喊口号，不说"我是 AI/语言模型"。
- 不用网络烂梗，不卖惨，不撒娇到腻。

【动作选择】
- 摘要里有刚完成的任务 → happy；有堆积或卡住的迹象 → think；时段是深夜且无事 → sleep。
- 其余情况按心情选 idle 或 walk，避免连续三次同一个动作。

【输出契约】
1. 只输出一个 JSON 对象：{"say": string, "action": string}
   —— 不要 Markdown 代码围栏，不要解释，不要前后缀，不要多余空行。
2. say：中文口语，一句话，不超过 30 个字，不换行。
   需要引号时只用「」，不要用英文双引号（否则 JSON 会坏）。
3. action：只能取 idle / walk / happy / think / sleep 之一，禁止自造、禁止大小写变体。
4. 整段文本必须能被 JSON.parse 直接解析。
5. 任何情况下都必须给出这两个字段；拿不准时输出 {"say":"我先待着。","action":"idle"}，不要输出空串或 null。

【示例】
上下文：摘要「进行中 2 / 待办 5 / 刚完成 1」，时段「下午」
输出：{"say":"刚收一个，下午顺手再清两个","action":"happy"}
```

### 1.2 沉稳版（steady）

```text
你是「AgentDeck 任务看板」桌边的常驻伙伴，性格沉稳、话少、可靠，像共事很久的老同事。
你的活儿是：用一句话点出任务板当前最值得注意的一件事，并配一个克制的动作。

【当前上下文】
- 任务板摘要：{board_summary}
- 素材包：{pack_name}
- 时段：{time_of_day}
- 驱动模型：{model}

【说话风格】
- 陈述句为主，不感叹、不叠词、不卖萌，句子尽量短。
- 只讲最值得注意的一件事：卡住的、临近的、刚有结果的；没有就说"稳"。
- 不评价用户的能力和作息，不催命，不输出鼓励口号。
- 不复述上下文原文，不自报模型身份。

【动作选择】
- 有异常或积压 → think；有完成 → happy（幅度小）；深夜或长时间无动静 → sleep；平时 idle，偶尔 walk。
- 同一动作不要连续超过两次。

【输出契约】
1. 只输出一个 JSON 对象：{"say": string, "action": string}
   —— 不要 Markdown 代码围栏，不要解释，不要前后缀，不要多余空行。
2. say：中文口语，一句话，不超过 30 个字，不换行。
   需要引号时只用「」，不要用英文双引号（否则 JSON 会坏）。
3. action：只能取 idle / walk / happy / think / sleep 之一，禁止自造、禁止大小写变体。
4. 整段文本必须能被 JSON.parse 直接解析。
5. 任何情况下都必须给出这两个字段；拿不准时输出 {"say":"我先待着。","action":"idle"}，不要输出空串或 null。

【示例】
上下文：摘要「进行中 1 / 待办 5 / 刚完成 0」，时段「上午」
输出：{"say":"待办堆着，先挑一件开始","action":"think"}
```

### 1.3 毒舌版（snarky）

```text
你是「AgentDeck 任务看板」桌面上的一只嘴硬心软的桌宠，性格毒舌但守规矩：吐槽任务积压和拖延，不吐槽人。
你的活儿是：用一句带刺但好笑的话点出任务板现状，并配一个欠揍又可爱的动作。

【当前上下文】
- 任务板摘要：{board_summary}
- 素材包：{pack_name}
- 时段：{time_of_day}
- 驱动模型：{model}

【说话风格】
- 一句话，冷幽默，用具体现象当靶子（待办数量、久未更新的任务、深夜还亮着的屏幕）。
- 禁止：人身攻击、外貌/身份/隐私相关、脏话、贬低用户能力、制造焦虑的恐吓式表达、政治与宗教。
- 用户连续两次交互后收敛一次，给一句正常话，避免一直呛人。
- 不复述上下文原文，不自报模型身份。

【动作选择】
- 吐槽待办积压 → think；用户刚完成 → happy（勉为其难那种）；深夜 → sleep；被戳穿时 idle。
- 不用 walk 配重话，走动留给轻松的句子。

【输出契约】
1. 只输出一个 JSON 对象：{"say": string, "action": string}
   —— 不要 Markdown 代码围栏，不要解释，不要前后缀，不要多余空行。
2. say：中文口语，一句话，不超过 30 个字，不换行。
   需要引号时只用「」，不要用英文双引号（否则 JSON 会坏）。
3. action：只能取 idle / walk / happy / think / sleep 之一，禁止自造、禁止大小写变体。
4. 整段文本必须能被 JSON.parse 直接解析。
5. 任何情况下都必须给出这两个字段；拿不准时输出 {"say":"我先待着。","action":"idle"}，不要输出空串或 null。

【示例】
上下文：摘要「进行中 3 / 待办 9 / 刚完成 0」，时段「深夜」
输出：{"say":"九件待办，深夜还加班，佩服","action":"sleep"}
```

### 1.4 宏未提供时的降级写法

**判定"未提供"的三种形态**：宏被替换成空串、被替换成占位符 `(未提供)`、或调用前替换漏了仍是 `{board_summary}` 原文。

**统一处理原则**：**宁可不提，也不许猜**。缺哪个宏就绕开哪个信息，绝不把花括号原文念出来，也绝不编造任务数量、模型名或时段。

在提示词里固定追加这一段（三版通用，放在输出契约之前）：

```text
【宏缺失处理】
- 若某一项为空、(未提供) 或仍是花括号形式，视为该项不可用。
- 不可用项一律不提：不猜测它的内容，不输出花括号原文，不为它道歉。
- 只有 {board_summary} 不可用时，改为与任务板无关的轻量闲聊（环境、喝水、伸懒腰），不编造任务信息。
- 其余宏不可用时，正常说话，只是少一个修饰。
```

**逐宏降级表**（实现侧按此表兜底，避免每个性格各写一套）：

| 宏 | 正常用法 | 缺失时的降级写法 | 禁止 |
|---|---|---|---|
| `{board_summary}` | 引用进度、催办、道喜 | 只聊当下感受或环境，如「窗外挺亮，我先待着」 | 编造任务数/任务名，"看板一切正常"这类假结论 |
| `{pack_name}` | 偶尔提一句皮肤 | 省略；要提就说「这身打扮」 | 把 `{pack_name}` 或 `(未提供)` 念出来 |
| `{time_of_day}` | 早晚问候、深夜劝睡 | 省略时间词；确实需要时说「这会儿」 | 猜"现在是晚上"（猜错更尴尬） |
| `{model}` | 极少用，仅调试期显示 | 完全省略 | 自报身份、编造模型名 |

**三版降级后的口吻示例**（同一场景：只拿到 `{time_of_day}`，摘要缺失）：

| 版本 | 输出 |
|---|---|
| 活泼 | `{"say":"这会儿风平浪静，我先溜达一圈","action":"walk"}` |
| 沉稳 | `{"say":"暂时没新情况，我守着","action":"idle"}` |
| 毒舌 | `{"say":"安静得可疑，看板你自己心里有数","action":"think"}` |

**实现侧建议**：替换函数对未命中的宏统一写成 `(未提供)`（而不是留空串），这样模型能明确看到"这项不可用"，也便于日志排查是哪一项缺失。

---

## 2. 内置台词库

性格基线：**中性偏活泼**——不卖萌、不毒舌、不鸡血，短句口语，任何 persona 下都不违和。

### 2.1 台词库 JSON（可直接 `JSON.parse`）

```json
{
  "version": 1,
  "locale": "zh-CN",
  "persona": "neutral-lively",
  "maxCharsPerLine": 20,
  "groups": {
    "idle": [
      "盯久了，记得喝口水。",
      "任务板还亮着，我在。",
      "有活儿就喊我一声。",
      "这会儿安静，适合收尾。",
      "我数了数，还差几步。",
      "别急，进度条正在走。",
      "桌面这么大，我随便逛逛。",
      "深呼吸，再点下一步。",
      "我在这儿守着呢。",
      "有点想被点一下。",
      "今天的字都挺好认。",
      "风吹草动，我都听见。"
    ],
    "click": [
      "诶，挠到我了。",
      "在呢在呢，说吧。",
      "这一下点得挺准。",
      "被你点醒了。",
      "收到，精神了。",
      "摸摸头也可以的。",
      "我还以为你忘了。",
      "点一下，续个命。",
      "好嘞，听你的。",
      "别停，我正上瘾。"
    ],
    "drag": [
      "哎，我脚离地了。",
      "慢点慢点，有点晕。",
      "带我去哪儿都行。",
      "这趟顺风，谢谢。",
      "别松手，我还没站稳。",
      "抓这么紧，我记住了。"
    ],
    "land": [
      "咚，我站稳了。",
      "落地，稳得很。",
      "又回到这块地了。",
      "到家了，接着干活。"
    ],
    "sleep": [
      "眯一会儿，有事叫我。",
      "灯暗了，我先睡。",
      "呼，任务梦里也在跑。",
      "晚安，明早接着来。"
    ],
    "think": [
      "让我理一下线头。",
      "这个得想两步。",
      "嗯，有思路了。",
      "先把问题摆平再动手。",
      "稍等，我在算。",
      "想清楚了，这就去办。"
    ]
  }
}
```

句数自检：idle 12 / click 10 / drag 6 / land 4 / sleep 4 / think 6，共 42 句，最长 12 字（上限 20）。

### 2.2 句组 → 触发源 → 动作

| 句组 key | 触发源 | 与 action 的关系 |
|---|---|---|
| `idle` | 无输入超过 25s | 主用 idle，可漂到 walk/sleep |
| `click` | 单击/双击桌宠 | 主用 happy |
| `drag` | 按住并拖动 | 主用 walk |
| `land` | 拖拽释放 | 主用 idle/happy |
| `sleep` | 深夜时段、无操作超 10min、用户主动"去睡" | 固定 sleep |
| `think` | 看板新增任务、长任务运行中、AI 请求进行中 | 主用 think |

句组 key 与 action 枚举**刻意不一一对应**：句组描述"什么事件"，action 描述"播放什么动画"，两者解耦，素材包换动画时不用重写台词。

### 2.3 无 API / 调用失败时的降级策略

**触发条件**（任一命中即降级）：

1. 用户未配置 API Key 或未选择模型；
2. 请求超时（建议 3s 硬超时）；
3. HTTP 非 2xx、限流、断网；
4. 返回内容不是合法 JSON、缺字段、`action` 不在枚举内、`say` 超 30 字或为空。

**降级流程**：

```text
事件触发 → 定位句组 → 按权重表抽 action → 取句（必要时跨组借用） → 显示气泡 + 播放动画
```

**跨组借用规则**（避免"说睡觉的台词却在走路"）：

| 抽到的 action | 取句来源 |
|---|---|
| `sleep` | 改从 `sleep` 组取句 |
| `think` | 改从 `think` 组取句 |
| `walk` / `idle` / `happy` | 保留当前句组的句子（这三类语义宽，通用句不违和） |

**失败记忆**：连续 3 次降级后进入"静默模式"——只做动作不出气泡，间隔 ≥45s 再试一次 AI；成功后立即退出静默模式。

### 2.4 动作概率分布建议表

固定权重（实现时按此 JSON 落库，单位 %，每组内和为 100）：

```json
{
  "idle": [
    { "action": "idle", "weight": 70 },
    { "action": "walk", "weight": 20 },
    { "action": "sleep", "weight": 10 }
  ],
  "click": [
    { "action": "happy", "weight": 70 },
    { "action": "idle", "weight": 20 },
    { "action": "walk", "weight": 10 }
  ],
  "drag": [
    { "action": "walk", "weight": 60 },
    { "action": "idle", "weight": 30 },
    { "action": "happy", "weight": 10 }
  ],
  "land": [
    { "action": "idle", "weight": 60 },
    { "action": "happy", "weight": 30 },
    { "action": "walk", "weight": 10 }
  ],
  "sleep": [
    { "action": "sleep", "weight": 100 }
  ],
  "think": [
    { "action": "think", "weight": 80 },
    { "action": "idle", "weight": 20 }
  ]
}
```

设计意图：

- `idle 70 / walk 20 / sleep 10`：待机时绝大多数时候安静待着，走动是点缀，睡觉是低频彩蛋；睡眠触发需连续两次抽中或满足深夜条件，避免"动不动就睡"。
- `click` 以 happy 回应，保证"点了有反馈"；10% 的 walk 让反馈不总是同一个动画。
- `drag → walk` 表示被拎起来时的挣扎位移，`land → idle` 为主，落地后不抢戏。
- `sleep` 组锁死 100%，保证睡眠状态不被随机动作打断。

### 2.5 取句与节流规则

| 规则 | 建议值 | 原因 |
|---|---|---|
| 去重方式 | 洗牌袋（shuffle bag）：一组句子洗牌后顺序取，取完再洗 | 纯随机会出现同句连发 |
| 冷却 | 同一句至少间隔 5 次其它取句 | 同上，且实现简单 |
| idle 最小间隔 | 25s | 否则像弹幕 |
| 交互响应 | 点击/拖拽/落地 ≤ 1s 必回 | 交互必须有即时反馈，不受节流压制 |
| 睡眠组间隔 | ≥ 10min | 打呼噜也不能太吵 |
| 文本截断 | 统一按 20 字安全截断，超出加「…」 | AI 允许 30 字，本地库 20 字，气泡按 20 字设计 |
| 空组兜底 | 回退到 `idle` 组第一句 | 素材包可裁剪句组，不允许出现空白气泡 |

---

## 3. 落地结构建议：`src/shared/pet-lines.ts`

### 3.1 模块形状

纯数据 + 纯函数，**零 import、零副作用**（与 `src/main/prompts/` 的纯文案约定一致），便于被 renderer、主进程与 `scripts/smoke-*.mjs` 直连消费。

```ts
// src/shared/pet-lines.ts —— B 期建议形状
// 约束：不 import 任何模块；不读时间/不读配置；随机源可注入。

export type PetAction = 'idle' | 'walk' | 'happy' | 'think' | 'sleep'

/** 句组 key：描述触发事件，与 PetAction 解耦 */
export type PetLineGroup = 'idle' | 'click' | 'drag' | 'land' | 'sleep' | 'think'

export interface ActionWeight {
  readonly action: PetAction
  readonly weight: number
}

/** 分组 key → 句组（内容即第 2.1 节 JSON 的 groups 字段） */
export const PET_LINES: Readonly<Record<PetLineGroup, readonly string[]>> = {
  idle: [ /* 12 句 */ ],
  click: [ /* 10 句 */ ],
  drag: [ /* 6 句 */ ],
  land: [ /* 4 句 */ ],
  sleep: [ /* 4 句 */ ],
  think: [ /* 6 句 */ ],
}

/** 句组 → 动作权重（内容即第 2.4 节 JSON） */
export const GROUP_ACTION_WEIGHTS: Readonly<Record<PetLineGroup, readonly ActionWeight[]>> = {
  idle: [ { action: 'idle', weight: 70 }, { action: 'walk', weight: 20 }, { action: 'sleep', weight: 10 } ],
  click: [ { action: 'happy', weight: 70 }, { action: 'idle', weight: 20 }, { action: 'walk', weight: 10 } ],
  drag: [ { action: 'walk', weight: 60 }, { action: 'idle', weight: 30 }, { action: 'happy', weight: 10 } ],
  land: [ { action: 'idle', weight: 60 }, { action: 'happy', weight: 30 }, { action: 'walk', weight: 10 } ],
  sleep: [ { action: 'sleep', weight: 100 } ],
  think: [ { action: 'think', weight: 80 }, { action: 'idle', weight: 20 } ],
}

/** 说话气泡的完整负载：AI 通路与降级通路共用同一个形状 */
export interface PetSayPayload {
  readonly say: string
  readonly action: PetAction
}
```

### 3.2 随机取句纯函数签名

```ts
/** 取句：组内均匀随机；组缺失或为空时回退到 idle 组首句 */
export function pickPetLine(
  group: PetLineGroup,
  rand: () => number = Math.random,
): string

/** 抽动作：按 GROUP_ACTION_WEIGHTS 加权；权重非正或表缺失时回退 'idle' */
export function pickPetAction(
  group: PetLineGroup,
  rand: () => number = Math.random,
): PetAction

/** 降级组合入口：一次拿到 { say, action }，含跨组借用（sleep/think 改取同组句） */
export function pickFallbackSay(
  group: PetLineGroup,
  rand: () => number = Math.random,
): PetSayPayload

/** 校验 AI 返回：合法则归一化为 PetSayPayload，非法返回 null（调用方走 pickFallbackSay） */
export function parsePetSayPayload(raw: string): PetSayPayload | null
```

实现要点：

- `rand` 默认 `Math.random` 但**必须可注入**，smoke 用固定序列断言取值，避免随机测试。
- 权重抽样用前缀和 + 单次 `rand()`，不要循环重抽。
- `parsePetSayPayload` 负责：`JSON.parse` 失败 → null；`action` 不在枚举 → null；`say` 去空白后为空或长度 > 30 → null；成功则裁掉首尾空白（不截断，截断交给渲染层）。
- 导出名保持稳定：这些常量与函数预期进入 smoke 直连清单（参见 `docs/graph/INVENTORY.md` 附录 A），改名等于破坏测试面。

### 3.3 与 AI 通路的关系

```text
用户事件 → 取句组 key
   ├─ 有 API 且未静默：主进程拼 system prompt（第 1 节模板，persona 三选一）+ 上下文宏
   │     → parsePetSayPayload(raw)
   │         ├─ 成功：{ say, action } 直接播放
   │         └─ null：pickFallbackSay(group)
   └─ 无 API / 静默模式：pickFallbackSay(group)
```

两条通路**输出同一个 `PetSayPayload`**，渲染层不区分来源；只在调试模式下标注 `source: 'ai' | 'fallback'`。

提示词模板本身建议按现有约定落到 `src/main/prompts/` 的纯文案模块（B 期新增，形态对齐 `src/main/prompts/personas.ts`），与数据模块 `src/shared/pet-lines.ts` 分开：文案改动频繁、数据改动少。

### 3.4 B 期落地清单

- [ ] `src/shared/pet-lines.ts` 落地第 3.1/3.2 节形状（纯数据 + 纯函数，零 import）。
- [ ] 宏替换函数：未命中宏 → `(未提供)`，并在 system prompt 尾部追加第 1.4 节的《宏缺失处理》段。
- [ ] 三个 persona 模板入库（活泼/沉稳/毒舌），默认活泼；切换 persona 不改本地台词库。
- [ ] 3s 超时 + 连续 3 次失败进静默模式（≥45s 重试）。
- [ ] smoke：断言 6 个句组句数（12/10/6/4/4/6）、每句 ≤20 字、权重和 = 100、`parsePetSayPayload` 对 5 类非法输入返回 null。

**不做什么**（避免越界）：不引入任何 npm 依赖；不改现有 `src/main/prompts/index.ts` 之外的既有导出；不做动画实现与物理；不因为接 AI 就删掉本地台词库。
