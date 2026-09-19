# 桌宠 / AI 陪伴开源项目调研（Electron 桌宠设计参考）

> **数据快照**：2026-09-19，来源为 GitHub REST API（`/repos/{owner}/{repo}`）与各仓库 raw 文件（README、LICENSE、配置样例）。
> 星数是查询当时的静态值，会持续变化；「活跃度」取 `pushed_at`（最后一次推送）与创建时间、开放 issue 数。
> 引用路径统一写成 **被调研仓库内的相对路径**（如 `conf/behaviors.xml`），本地绝对路径不入文档。
> 本文只覆盖调研结论，不含实现改动。我们自己的仓库相对路径只在末尾建议里出现。

---

## 0. 结论摘要（先看这段）

1. **素材格式**：被调研项目里 **8 个用序列帧/图集**（VPet、Shimeji 全系、clawd-on-desk、OpenPets、DyberPet、webmeji、xiaozhi 的表情集），**3 个用 Live2D Cubism**（live2d-widget、BongoCat、Open-LLM-VTuber 的展示层）。序列帧是桌宠生态的默认契约，且授权链最干净；Live2D 路线的 SDK/Core/模型三层许可都需要额外处理（见 4.1 论据）。
2. **行为配置**：成熟项目都把「行为」做成**外部可编辑数据**而不是代码——Shimeji 是 `conf/behaviors.xml` 的条件 + 加权转移；clawd-on-desk 是 `theme.json` 的 `states` + 权重/冷却/回退；VPet 是「类型 × 状态 × ABC 段」的路径与配置文件约定；DyberPet 是 `act_conf.json` + `random_act` 概率表。这四套都可以直接翻译成 JSON 状态机。
3. **交互 + 自主行为**：所有高星项目的交互集合高度重合（点击/双击/拖拽/悬停/贴边/睡眠/叫醒/右键菜单/托盘），自主行为则统一采用「idle 计时器 + 加权随机池 + 冷却 + 抑制条件」；只做随机不做节流会退化成骚扰（clawd-on-desk 专门做了资格二次校验与 DND 抑制）。
4. **AI 与提示词**：提示词可定制性最强的是 Open-LLM-VTuber（人格提示词 + 工具提示词文件 + 由 emotionMap 自动生成的「表情关键词表」注入 + 主动说话提示词）；AIRI 把「情绪/动作词表」和「工具集说明」做成运行时拼接的独立段；xiaozhi 把提示词放在服务端，设备端只暴露 MCP 能力。**共同点是：可注入的能力清单必须由运行时自动生成，不能手写**。
5. **授权红线**：`rullerzhou-afk/clawd-on-desk` 代码 AGPL-3.0（网络分发触发开源义务），素材不在 AGPL 覆盖内；`ChaozhongLiu/DyberPet`、`Ikaros-521/AI-Vtuber`、`Hanzoe/Pet-GPT` 为 GPL-3.0；VPet 代码 Apache-2.0 但**内置动画素材另有版权声明**；Live2D 系（Cubism Core / SDK / 样例模型）为专有或单独许可。可直接借鉴代码的宽松许可项目：MIT（Open-LLM-VTuber、xiaozhi、BongoCat、OpenPets、airi）与 zlib/BSD 风格（Shimeji 原版与 Shimeji-ee）。

---

## 1. 对比总表

| 仓库全名 | 星数 | 平台 / 语言 | 素材组织格式 | 动画行为的可编辑配置 | 交互集合 | AI 接入 / 提示词可定制性 | License 结论 |
|---|---|---|---|---|---|---|---|
| `LorisYounger/VPet` | 6813 | Windows / C# WPF | mod 目录 + PNG 序列帧，路径即元数据（`pet/<类型>/<状态>/<A\|B\|C>/<前缀>_<帧号>_<帧时长>.png`） | `.lps`(LinePutScript) 配置字段 `mode/graph/animat` 覆盖路径解析；32 种动画类型 × 4 状态 × ABC 三段（开发文档另记 17 种基础类型、其中 7 种核心动画必需） | 摸头、摸身体、拖拽提起、抛落、投喂物品/食物、工作、说话、状态切换、创意工坊 | 核心无 AI；靠代码插件/MOD（社区：ChatVPet、VPetLLM）；文本可 MOD 化（IText 系列） | 代码 Apache-2.0；**内置动画/图片另有《动画版权声明与授权》**，商用需弹窗+页面告知+禁止转售+邮件报备 → 代码与格式可借鉴，素材不可直接复用 |
| Shimeji 原版（Yuki Yamada / Group Finity，非 GitHub 仓库） | N/A（不在 GitHub） | Windows+macOS+Linux / Java | `img/<角色>/*.png` 一帧一图 | `conf/actions.xml`（动作→Pose 帧序列）+ `conf/behaviors.xml`（条件+加权转移） | 鼠标追逐、点击热区、拖拽/抛掷、爬墙/天花板/窗口边缘、躺坐、分裂增殖 | 无 | **zlib 风格**（`originallicence.txt`）：允许商用/修改/再分发，须保留声明、不得伪造来源、修改需明示 → 代码与 XML 格式可自由借鉴 |
| Shimeji-ee 系（现存镜像：`gil/shimeji-ee`、`DalekCraft2/Shimeji-Desktop`） | 60 / 49 | 跨平台 / Java | 同上（`img/<角色>/`，支持 `img/<角色>/conf/` 或 `conf/<角色>/` 覆盖全局 conf） | 同上，另有 `conf/Mascot.xsd` 作为完整 schema | 同上 + 多只同屏互动（Interact/ScanInteract） | 无 | **BSD 2-clause 风格**（Shimeji-ee Group）+ Kilkakon 署名要求 → 可借鉴；角色图包版权归各作者 |
| Shimeji 移植：`lars-rooij/webmeji` | 49 | Web / JavaScript | JS 配置里的 `sprites` + `animations`（帧数组） | `ORIGINAL_ACTIONS` / `EDGE_ACTIONS` 概率表 + Creature 类逐动作参数 | 抚摸、拖拽、翻面、边缘悬挂、跳边缘、绊倒恢复 | 无 | **Unlicense**（公共领域）→ 可自由借鉴 |
| Shimeji 移植：`playerdecuple/Deskot` / `AlleyBo55/doraemon` | 3 / 44 | Electron / TypeScript | 未验证（`Deskot` 无 README） | 未验证 | 未验证 | 未验证 | MIT / 无 SPDX（doraemon 视为保留所有权利）→ 星数低、不作为参考 |
| Shimeji 重实现：`CluelessCatBurger/wl_shimeji`、`pixelomer/Shijima-Qt`、`estenv/linux-shimeji` | 199 / 200 / 166 | Wayland C / Qt C++ / Java | 兼容原版 XML/图片 | 兼容原版 | 兼容原版 | 无 | GPL-2.0 / GPL-3.0 / Zlib；后两者已归档 |
| `stevenjoezhang/live2d-widget` | 10963 | Web / TypeScript | 仓库**不含模型**；模型仓库需 `model_list.json` + `model/<名>/textures.cache` + 各模型 `.model.json` | `waifu-tips.json`：mouseover/click/seasons/time/message/models 六类触发器 | 悬停提示、点击、拖拽、工具按钮（换装/换模/拍照/一言/小游戏/退出）、hit_areas | 无内建 LLM（仅 `demo/chat.html` 示例） | 代码 **GPL-3.0**（不含 Live2D 约束部分）；模型版权归原作者、仅研究学习不得商用；Cubism Core 为 **Live2D Proprietary Software License**，SDK for Web 不能随仓库分发 |
| `Open-LLM-VTuber/Open-LLM-VTuber`（原 `t41372/Open-LLM-VTuber`） | 13819 | 跨平台 / Python | `live2d-models/<模型>/` + `model_dict.json`（name→path + emotionMap）+ `avatars/` + `characters/*.yaml` | `conf.yaml`：`tool_prompts` 挂载提示词文件、`agent_config`/`llm_configs`、ASR/TTS/VAD；角色 YAML 覆盖式配置 | 免手语音（打断）、Live2D 表情/动作、主动说话、群聊、B 站直播 | **强**：`persona_prompt` 完全自定义 + 工具提示词文件化（支持 `<insert_emomap_keys>` 占位符）+ OpenAI 兼容 `base_url` 任意平台 + MCP 工具 | 代码 **MIT**；Live2D 样例模型除外（`LICENSE-Live2D.md`）→ 架构与提示词设计可自由复用，样例模型不可商用 |
| `78/xiaozhi-esp32` | 30055 | ESP32 / C++ | `assets` 分区打包 `assets.bin`（SPIFFS），内含 `index.json` 清单：skin/字体/唤醒词/`emoji_collection[{name,file}]` | 板级 `main/boards/<板>/config.json`；表情/字体/背景/唤醒词由 assets 清单驱动 | 语音唤醒、屏幕表情情绪、按键/触摸、摄像头视觉、MCP 控制设备与云端 | 提示词在**服务端**（控制台/自建 server），设备端以 MCP 暴露能力；端侧无提示词文件 | 仓库 **MIT**；assets 内的唤醒词模型/字体/表情（Twemoji）各自许可 → 包格式与表情名词表可借鉴，素材需按来源核对 |
| **[补·高星]** `rullerzhou-afk/clawd-on-desk` | 6246 | Electron / JavaScript | 主题目录 `theme.json` + SVG/GIF/APNG/WebP/PNG；可导入 Codex Pet zip 图集 | `theme.json`：`states`+`fallbackTo`、`workingTiers`、`sleepSequence`、`reactions`、`idleAnimations`、`idleEasterEggs`、`eyeTracking`、`hitboxes`、`layout` | 点击/双击/四连击、任意状态拖拽、眼动跟随、睡眠-惊醒序列、mini 贴边、点击穿透、多屏、托盘、DND、权限气泡、远程通知、PWA 镜像 | 本身不调 LLM；消费各 coding agent 的 hooks/JSONL 事件驱动状态；无提示词面板 | 代码 **AGPL-3.0**（强 copyleft，网络分发也触发开源义务）；`assets/`、`themes/*/assets/` 美术素材**不在 AGPL 内**（Clawd 角色属 Anthropic）→ 设计可借鉴，代码/素材不可直接复用 |
| **[补·高星]** `moeru-ai/airi` | 49258 | Electron + Web + Capacitor / TypeScript | Live2D(Cubism) 与 VRM 双后端；模型/角色在应用内配置 | 眼动/眨眼/待机视线等基础动画；情绪-动作枚举常量（`EMOTION_VALUES`）驱动 | 语音输入、TTS 说话、多端聊天（Discord/Telegram）、可玩 Minecraft/Factorio、记忆 | **强（多 provider）**：经 xsai 接 30+ 家 LLM API（OpenAI/Azure/Anthropic/DeepSeek/Ollama/vLLM…）；运行时拼接情绪词表 + `## Toolset` 工具提示词段 + 上下文快照消息 | 代码 **MIT**；捆绑/示例模型素材需按各自来源核对 → 提示词分层与 provider 抽象可借鉴 |

---

## 2. 逐项目详述

### 2.1 LorisYounger/VPet（WPF 桌宠）

- **仓库全名 / 星数**：`LorisYounger/VPet`，6813★（fork 678）。
- **活跃度**：创建 2022-12-13，最后推送 2026-09-16，开放 issue 27，未归档；Steam 免费发行 + 创意工坊在运营。
- **平台 / 语言**：Windows 桌面，C# / WPF（核心库 `VPet-Simulator.Core` 可嵌入任意 WPF 应用，另有 NuGet 包）。
- **素材组织格式**：
  - MOD 根目录 `mod/<MOD名>/`，可含 `pet/`（角色动画）、`image/`（物品图）、`food/`、`file/`、`icon.png` 等；核心 MOD 为 `mod/0000_core/`。
  - 动画是 **PNG 序列帧**，一帧一文件，例如 `VPet-Simulator.Windows/mod/0000_core/pet/vup/BDay/A/A_000_125.png`、`.../Raise/Raised_Dynamic/Happy/H<动作>_011_125.png`。
  - **路径即元数据**：命名规范 `{状态}_{动画类型}_{动画名称}_{动作}_{帧时间}.png`（下划线与目录分隔可互换，顺序不敏感），如 `happy/touch_head/pet_a_125.png`、`nomal/default/breath_b_200.png`。参见 `Secondary Development Support Documentation.md`。
- **动画行为的可编辑配置格式**：
  - 解析优先级 **配置文件 > 路径关键词 > 默认值**（源码 `VPet-Simulator.Core/Graph/GraphInfo.cs`）：配置用 `.lps`（LinePutScript 键值脚本，见 `mod/0000_core/food/food.lps` 的 `字段:|key#value:|...` 形态）里的 `mode` / `graph` / `animat` / `startuppath` 字段；路径关键词为 `happy|nomal|poorcondition|ill`、类型名数组、`a|start / b|loop / c|end / single`。
  - **ABC 三段式**：A_Start → B_Loop（可循环 N 次）→ C_End，或 Single；必需动画 7 种（`Raised_Dynamic`、`Raised_Static`、`Default`、`Sleep`、`Say`、`StartUP`、`Work`），完整类型表 32 种 × 4 状态。
  - 数值/物品/文本同样是数据：食物条目的 `Exp/Strength/StrengthFood/Likability/Health/Feeling/price/graph/desc` 都在 `.lps` 中（`mod/0000_core/food/food.lps`）；会话文本通过 `VPet-Simulator.Windows.Interface/Mod/` 下的 `IText`、`LowText`、`SelectText`、`ClickText` 接口 MOD 化。
- **交互集合**：鼠标悬停/点击/拖拽提起（`Raised_*`）/抛落、摸头、摸身体、投喂食物与物品、工作计时、说话（Say + 气泡）、4 种状态切换动画、多语言、主题、Steam 创意工坊订阅。
- **AI 接入与提示词可定制性**：**核心不含 AI 对话**（README 的软件结构里提到过的 `winCGPTSetting` 在当前 main 的 `VPet-Simulator.Windows/WinDesign/` 已不存在，是文档滞后）。AI 能力通过**代码插件 MOD** 提供（`LorisYounger/VPet.Plugin.Demo`，109★），社区侧有本地语言模型 `LorisYounger/ChatVPet`（36★，GPL-3.0）与聚合 LLM 接口 `VPetLLMbyYCXOM`。插件还能新增显示方案（官方 README 明示可扩展 l2d/spine 等动画逻辑）。
- **License 结论**：
  - 代码 `LICENSE` = **Apache-2.0** → 可借鉴结构、可复用代码（保留 NOTICE/版权）。
  - **内置动画与图片另有声明**（README「动画版权声明与授权」）：非商用需告知来源并给出仓库链接；商用需首次弹窗醒目告知 + 用户可快捷访问的页面告知 + **禁止出售动画文件** + 邮件报备；分发动画文件禁止收费。`mod/0000_core/pet/vup` 的动画版权归「虚拟主播模拟器制作组」。
  - **可直接借鉴**：MOD 目录结构、路径命名规范、ABC 三段式、`.lps` 式键值配置、插件边界；**不可直接复用**：自带角色动画/图库。
- **对我们最有用的三点**：① 帧时长写进文件名/配置，解析器容错（每字段有默认值）；② 动画类型枚举固定 + 可扩展 `Common`；③ 大图合成 + 缓存 + 延迟加载的内存策略。

### 2.2 Shimeji 系列（原版 + web/Electron 移植）

- **原版 Shimeji**：作者 Yuki Yamada（Group Finity，官网 `group-finity.com/Shimeji/`），2009 年发布，**不在 GitHub 上**，因此没有星数可比。
  - **License**：原始许可见镜像仓库的 `originallicence.txt`——**zlib/libpng 风格**（日文原文，注释说明托管时选了 New BSD）：允许包括商用在内的任何目的使用、修改、再分发，条件为不得伪造来源/不得声称原创（致谢非必须）、修改版必须明示、不得移除或改动声明。→ **可自由借鉴代码与配置格式**，但各角色图包（同人图）版权属各自作者。
- **Shimeji-ee（English Enhanced）**：由 Kilkakon 维护（`kilkakon.com/shimeji`）。`Kilkakon/Shimeji-ee` 仓库现已不在 GitHub（API 404，账号下无公开仓库），现存可用镜像：
  - `gil/shimeji-ee`：60★，Java，最后推送 2019-09-05（Kilkakon v1.0.13 源码分支）。
  - `DalekCraft2/Shimeji-Desktop`：49★，Java，创建 2023-11-13，最后推送 **2026-09-10**，开放 issue 11；JRE 6 → JDK 25 移植 + Maven 构建，**是目前最活跃、可直接跑通 conf 的参考实现**。
  - **License**：两者均为 BSD 2-clause 风格（`licence.txt`/`LICENSE.txt`：Shimeji-ee Group，保留版权声明与免责声明即可再分发）+ Kilkakon 的署名请求（"credit Kilkakon and the original people"）。
- **素材组织格式**：
  - 角色 = 一个图片集目录 `img/<角色名>/`，**一帧一个 PNG**（如 `img/KuroShimeji/shime1.png … shime39.png`；默认角色约 46 张）。
  - **覆盖链**（README「Advanced Configuration」）：动作/行为配置优先取 `img/<角色>/conf/actions.xml` 或 `conf/<角色>/actions.xml`，否则回退全局 `conf/actions.xml`、`conf/behaviors.xml`；`img/unused/` 下的图集被忽略；托盘图标为 `img/icon.png`。
  - 启动时为 `img/` 下每个图集生成一只（数量可在 `conf/settings.properties` 限制）。
- **动画行为的可编辑配置格式**（核心参考）：
  - `conf/actions.xml`：动作名 → 类型 → 帧序列。
    ```xml
    <Action Name="Walk" Type="Move" BorderType="Floor">
      <Animation>
        <Pose Image="/shime1.png" ImageAnchor="64,128" Velocity="-2,0" Duration="6"/>
        <Pose Image="/shime2.png" ImageAnchor="64,128" Velocity="-2,0" Duration="6"/>
      </Animation>
    </Action>
    ```
    要点：`Type`（`Stay`/`Move`/`Animate`/`Embedded`/`Sequence`/`Select`…）决定行为语义，`BorderType`（Floor/Wall/Ceiling）决定贴边规则，**位移速度内嵌在每一帧**（所以「走」= 帧序列 + 每帧位移），`Duration` 单位是 tick；`Animation` 可带 `Condition` 做分支。
  - `conf/behaviors.xml`：**条件 + 加权转移的状态机**。
    ```xml
    <Condition Condition="#{mascot.environment.floor.isOn(mascot.anchor)}">
      <Behavior Name="SitDown" Frequency="200">
        <NextBehaviorList Add="true">
          <BehaviorReference Name="SitWhileDanglingLegs" Frequency="100"/>
          <BehaviorReference Name="LieDown" Frequency="100"/>
        </NextBehaviorList>
      </Behavior>
    </Condition>
    ```
    要点：`Condition` 是脚本表达式（环境=地板/墙/天花板/IE 窗口/光标/多只数量），`Frequency` 是权重（设 0 = 关闭该行为），`Hidden` 隐藏不出现在菜单，`NextBehaviorList Add="false"` 表示**替换**而非追加候选；`ChaseMouse`/`Fall`/`Dragged`/`Thrown` 为必需行为。
  - `conf/Mascot.xsd`：完整 schema，额外定义 `Hotspot`（点击热区 → 触发某个 Behavior）、`BornBehavior`、`TransformBehavior`、`Interact`/`ScanInteract`/`ScanJump`/`ScanMove`（多只互动/可交互物扫描）、Pose 的 `Sound`、`ImageRight`（朝向翻转图）等。
- **交互集合**：鼠标追逐（ChaseMouse）、点击热区触发行为、拖拽（Dragged）/抛掷（Thrown）、落地/下落物理、沿地板/墙/天花板/IE 窗口边缘行走攀爬、坐/躺/蹲、分裂成两只（数量上限内）、多只同屏互动、右键菜单（换角色/加一只等）。
- **Web / Electron 移植现状（实测星数）**：
  - `lars-rooij/webmeji`：49★，JavaScript，**Unlicense**，2026-09-16 仍活跃。把 shimeji 嵌进网页：配置里给 `sprites` 与 `animations`（每动作的 `frames`/`interval`/`loops`），行为靠 `ORIGINAL_ACTIONS`、`EDGE_ACTIONS` 概率表，`Creature` 类负责翻面（CSS transform）、拖拽、抚摸、边缘悬挂、跳边缘、下落与绊倒恢复；实现了图片预加载避免闪帧。**许可最宽松、结构最贴近我们要做的事**（浏览器/渲染进程内的精灵帧宠物）。
  - `playerdecuple/Deskot`：3★，TypeScript，MIT，2023-11-07 停更（自称 Shimeji-ee clone based on Electron），无 README → 仅作为「存在 Electron 移植」的佐证。
  - `AlleyBo55/doraemon`：44★，TypeScript，2026-08-03，**无 LICENSE 文件（API 返回 NOASSERTION）→ 视为保留所有权利，不可复用**。
  - 重实现（兼容原版素材与 XML）：`CluelessCatBurger/wl_shimeji` 199★（Wayland/C、GPL-2.0、活跃）、`pixelomer/Shijima-Qt` 200★（C++/GPL-3.0、**已归档**）、`estenv/linux-shimeji` 166★（Java/Zlib、**已归档**）。
  - 结论：**Shimeji 系列没有高星 Electron 移植**；可借鉴的资产是「XML 状态机 + 一帧一图 + 图集覆盖链」这套数据设计，以及在 `webmeji` 里已经验证过的轻量 JS 精灵实现思路。

### 2.3 stevenjoezhang/live2d-widget（网页看板娘）

- **仓库全名 / 星数**：`stevenjoezhang/live2d-widget`，10963★（fork 2604）。
- **活跃度**：创建 2018-07-11，最后推送 2026-09-19，开放 issue 14，未归档；npm 包 `live2d-widgets` 仍在发版。
- **平台 / 语言**：Web 平台，TypeScript（Rollup 打包，产出 `dist/autoload.js`、`dist/waifu-tips.js`）。
- **素材组织格式**：**仓库不含任何模型**（README 明确说明）。模型侧约定：
  - 模型仓库根放 `model_list.json`（分组：`name`、`paths[]`、`message`），模型目录 `model/<名>/` 内放 `textures.cache`（贴图切换列表，用于换装）与模型自身的 `.model.json`/`index.json`（textures、motions、expressions、hit_areas、physics、pose 等）。
  - 运行时 `src/model.ts` 定义 `ModelList`/`Config`，动态加载 **Cubism 2 或 Cubism 5** Core（`cubism2Path` / `cubism5Path`）以兼容两代模型；`localStorage` 记忆 `modelId`/`modelTexturesId`。
- **动画行为的可编辑配置格式**：`dist/waifu-tips.json`（可由 `waifuPath` 指向自定义文件）：
  - `mouseover[]`：`{selector, text[]}`——**CSS 选择器命中即触发台词**（默认 57 条，面向 Hexo NexT 主题，可自行改写）；`click[]` 同理；
  - `seasons[]`：`{date, text[]}`（按日期）；`time[]`：`{hour, text[]}`（按时段）；
  - `message{}`：`default`/`console`/`copy`/`visibilitychange` 等场景台词池；
  - `models[]`：`{name, paths, message}` 模型说明。
  - 加载器 `initWidget({waifuPath, cdnPath, cubism2Path, cubism5Path, modelId, tools[], drag, showToggleAfterQuit, logLevel})`。
- **交互集合**：悬停提示（选择器级）、点击/触摸、拖拽（`drag: true`）、工具按钮条（换装、换模型、截图、一言、小游戏彩蛋、信息、退出）、模型 `hit_areas` 命中反馈、退出后可召回。
- **AI 接入与提示词可定制性**：**无内建 LLM**；`demo/chat.html` 只是接第三方对话接口的展示页，没有提示词/人格管理。它的「台词引擎」是规则匹配，不是生成式。
- **License 结论**：
  - 代码 **GPL-3.0**（README「许可证」：不含受 Live2D 两套许可约束的部分）→ 传染性强，**不能用进闭源 Electron 应用**，但可读其数据结构设计。
  - 模型：仓库不包含；展示用模型版权属原作者，**仅供研究学习、不得商用**。
  - Live2D 相关：**Cubism Core 由 Live2D Proprietary Software License 提供**；Cubism Components 为 Live2D Open Software License；**Cubism SDK for Web 源码不能随仓库分发**，README 要求使用者自行下载并解压到 `src/`；Cubism 2.1 另有 SDK License Agreement。
  - **这条 README 原文是我们「避开 Cubism SDK 授权门槛」最直接的证据**：连最大众的看板娘库都得让用户自己装 SDK。

### 2.4 Open-LLM-VTuber/Open-LLM-VTuber（AI 陪伴 + Live2D 前端）

- **仓库全名 / 星数**：`Open-LLM-VTuber/Open-LLM-VTuber`，**13819★**（fork 1651）。任务里给的 `t41372/Open-LLM-VTuber` 现已重定向为 `t41372/Open-LLM-VTuber-Lab`（46★，最后推送 2026-02-14），其说明写明主仓库已迁至前者——评估时应以组织仓库为准。
- **活跃度**：创建 2023-11-24，最后推送 2026-05-15，开放 issue 156，未归档；仍是功能覆盖最全的 AI VTuber 开源框架之一。
- **平台 / 语言**：跨平台（桌面/服务器跑 Python 后端 + Web 前端），Python 3（FastAPI + WebSocket），前端在浏览器中渲染 Live2D。
- **素材组织格式**：
  - `live2d-models/<模型名>/`（内含 `ReadMe.txt` 记录模型来源与授权，如 `live2d-models/mao_pro/ReadMe.txt`）；
  - `model_dict.json`：`[{name, path, emotionMap}]`——`emotionMap` 把**关键词映射到表情/动作索引**；
  - `avatars/` 头像、`backgrounds/` 背景、`characters/*.yaml` 角色配置（覆盖式，只写要改的字段）。
- **动画行为的可编辑配置格式**：
  - `config_templates/conf.default.yaml` 是主配置：`system_config.tool_prompts` 挂载提示词文件（`live2d_expression_prompt`、`mcp_prompt`、`proactive_speak_prompt`、`group_conversation_prompt`、`tool_guidance_prompt`）；`character_config` 下 `persona_prompt`、`live2d_model_name`、`agent_config.conversation_agent_choice`、`llm_configs`、`asr_config`、`tts_config`、`vad_config`、`tts_preprocessor_config`。
  - LLM 侧支持 `openai_compatible_llm`（`base_url` 指 Ollama/LM Studio/vLLM 皆可）、`llama_cpp_llm`、`claude_llm`、`ollama_llm`；MCP 由 `use_mcpp` + `mcp_enabled_servers` 控制。
  - **表情/动作驱动的闭环**（`src/open_llm_vtuber/live2d_model.py`）：由 `emotionMap` 的键生成 `emo_str`（形如 `[key1], [key2], ...`）注入提示词模板 `prompts/utils/live2d_expression_prompt.txt` 的 `<insert_emomap_keys>` 占位符；LLM 在回复里输出 `[key]`，`extract_emotion()` 扫描并返回表情索引驱动演出。
- **交互集合**：免手语音对话（ASR + VAD + 语音打断）、Live2D 表情/动作、**主动说话**（无输入时按 `proactive_speak_prompt` 主动开口）、群聊模式（多角色）、字幕/历史、Web 控制台切换角色与模型、B 站直播接入（`live_config.bilibili_live`）。
- **AI 接入与提示词可定制性**：**本次调研中最强**。人格提示词（`persona_prompt`）完全自由；工具/能力提示词是**独立文本文件**（`prompts/utils/*.txt`，`prompts/README.md` 明确「人格提示词在 conf.yaml 或 characters/，工具提示词在这里」）；多角色 YAML 热切换；任何 OpenAI 兼容端点可通过 `base_url` 接入 → 正对「不依赖平台、用 API 预设」的诉求。
- **License 结论**：`LICENSE` 是 **MIT**（Copyright (c) 2025 Yi-Ting Chiu），末尾额外声明「Live2D 样例模型除外，见 `LICENSE-Live2D.md`」（这也是 GitHub API 显示 NOASSERTION 的原因）。→ **代码与提示词架构可自由复用（保留版权声明）**；`live2d-models/` 下的样例模型按 Live2D 样例模型条款，**不可商用/不可当作自有素材**。

### 2.5 78/xiaozhi-esp32（语音 AI 硬件，但素材包设计极有参考价值）

- **仓库全名 / 星数**：`78/xiaozhi-esp32`，30055★（fork 6995），本次调研星数最高。
- **活跃度**：创建 2024-08-31，最后推送 2026-09-15，开放 issue 666，未归档；138 个板卡目录、171 个固件变体。
- **平台 / 语言**：ESP32 系列芯片固件，C++（ESP-IDF）+ LVGL；**不是桌宠，但它的 assets 打包与表情名表是本次最好的「素材包 manifest」样本**。
- **素材组织格式**：
  - 固件 `assets` 分区（见 `main/assets.h` 的 `esp_partition` + mmap 设计），打包产物 `assets.bin`（SPIFFS 格式），运行时按名取资源 `Assets::GetAssetData(name, ptr, size)`，并按 `LvglStrategy` / `EmoteStrategy` 两种策略应用（`main/assets.cc`）。
  - `assets.bin` 内含 **`index.json` 清单**（格式见官方生成器 `78/xiaozhi-assets-generator` 的 README）：
    ```json
    {
      "version": 1, "chip_model": "esp32s3",
      "display_config": { "width": 320, "height": 240, "monochrome": false, "color": "RGB565" },
      "srmodels": "srmodels.bin",
      "text_font": "font_puhui_common_30_4.bin",
      "skin": { "light": { "text_color": "#000000", "background_color": "#FFFFFF", "background_image": "background_light.raw" },
                "dark":  { "text_color": "#FFFFFF", "background_color": "#121212" } },
      "emoji_collection": [ { "name": "sleepy", "file": "sleepy.png" } ],
      "multinet": { "model": "mn6_cn", "command": "ni hao xiao zhi", "threshold": 20, "duration": 3000 }
    }
    ```
  - **标准表情名表（21 个）**：`neutral, happy, laughing, funny, sad, angry, crying, loving, embarrassed, surprised, shocked, thinking, winking, cool, relaxed, delicious, kissy, confident, sleepy, silly, confused`；`neutral` 必须有，其余缺失回退到 `neutral`；支持 GIF 或透明 PNG、统一尺寸。运行时 `main/display/lvgl_display/emoji_collection.cc` 用 `EmojiCollection::AddEmoji(name, image)` + `GetEmojiImage(name)` 做「名字 → 图」映射。
  - 官方在线生成器 `78/xiaozhi-assets-generator`（浏览器本地打包，无需后端）：分步选芯片/分辨率 → 唤醒词（WakeNet 预设或 MultiNet 自定义，阈值/时长）→ 字体（预设普惠体或上传 TTF/WOFF 转 cbin）→ 表情集合 → 聊天背景（浅/深色，RGB565 位图），最后生成 `assets.bin`。
- **动画行为的可编辑配置格式**：设备端没有行为状态机；可配置项是板级 `main/boards/<板名>/config.json`（`type`/`target`/`builds[]`，含 `sdkconfig_append` 覆盖显示驱动等）+ assets 清单。**表情由服务端/对话流程驱动**，设备端只按名字取图。
- **交互集合**：语音唤醒（WakeNet 预设 / MultiNet 自定义命令词）、OLED/LCD 表情与情绪呈现、按键/触摸、摄像头视觉输入、38 种界面语言语音提示（缺失回退英文）、**MCP 设备控制**（音量/灯光/电机/GPIO）与**云端 MCP 扩展**（智能家居、PC 桌面操作、知识搜索等）。
- **AI 接入与提示词可定制性**：大模型在**服务端**（官方控制台或自建 server，Qwen/DeepSeek 等），设备端通过协议连接；提示词不落在固件里，端侧能力以 MCP 工具描述暴露。→ 对我们是「提示词放服务端/配置层，端侧只声明能力」的架构参考。
- **License 结论**：仓库 `LICENSE` = **MIT**，只覆盖本仓库代码。**assets 内的资源各有来源**：WakeNet/MultiNet 唤醒词模型与字体来自 Espressif 生态，表情预设为 **Twemoji 32/64（图形为 CC-BY 4.0，需署名）**，音频为项目自带 —— 复用时必须逐项核对来源许可，不能因为仓库是 MIT 就整包搬。
- **对我们最有用的三点**：① 「一个 manifest + 一个资源容器」的素材包形态（版本号 + 分辨率 + 资源名表）；② **固定情绪名词表 + 缺失回退 neutral**，这正好可以直接变成我们精灵帧的 `emotion` 枚举；③ 生成器式的「导出素材包」体验（用户自己打包，不碰代码）。

### 2.6 [补充·高星] rullerzhou-afk/clawd-on-desk（Electron 桌宠 + 编码 agent 联动）

> 检索来源：GitHub 搜索 `desktop pet electron`（按星排序）第一名桌宠项目。

- **仓库全名 / 星数**：`rullerzhou-afk/clawd-on-desk`，6246★（fork 649）。
- **活跃度**：创建 2026-03-18，最后推送 2026-09-19，开放 issue 86，未归档——**本次调研中最活跃的 Electron 桌宠**。
- **平台 / 语言**：Electron（JavaScript，跨平台桌面），另有 PWA 手机镜像。
- **素材组织格式**：
  - 主题 = 一个目录：`theme.json` + 资源文件；支持 **SVG、GIF、APNG、WebP、PNG、JPG/JPEG**（动画既可以是逐帧 GIF/APNG，也可以是 SVG + CSS `@keyframes`）。
  - **最小可用主题**：1 个 idle SVG（要支持眼动时）+ 7 个动画文件（thinking、working、error、happy、notification、sleeping、waking）——「必需状态集」被明确写进校验器。
  - 支持**导入 Codex Pet zip 图集**（atlas）自动转换为托管主题；提供脚手架 `scripts/create-theme.js` 与校验 `scripts/validate-theme.js`；主题卡会显示能力徽章（Tracked idle / Static theme / Mini / Direct sleep / No reactions）。
  - 主题字段、状态清单、`viewBox` 逻辑画布、`layout.marginBox/contentBox`、`hitboxes`、`mirroredFiles`（镜像后文字反向的预处理图）、`roamFlipAssets` 等见 `docs/guides/guide-theme-creation.md`。
- **动画行为的可编辑配置格式**（JSON 状态机，字段级参考）：
  - `states`: 状态名 → 文件数组，或 `{files, fallbackTo}`（缺资源时借用其它状态的文件，且**不跳过逻辑状态**，计时/热区/转移照常）。
  - 必需状态：`idle`、`thinking`、`working`、`sleeping`（可 fallback）+ `waking`（`sleepSequence.mode: "full"` 时必需）；可选：`yawning`、`dozing`、`collapsing`、`error`、`attention`、`notification`、`sweeping`、`carrying`、`juggling`、`roam`。
  - 多会话分层：`workingTiers: [{minSessions: 3, file}, {minSessions: 2, file}, {minSessions: 1, file}]`、`jugglingTiers`（按子代理数）。
  - 睡眠序列：`sleepSequence.mode` = `full`（哈欠→打盹→倒下→睡）或 `direct`（直接睡）。
  - 点击/拖拽反应：`reactions: { drag{file,fileLeft,fileRight}, clickLeft{file,duration}, clickRight, annoyed, double{files[]} }`。
  - 空闲池与彩蛋：`idleAnimations: [{file, duration}]`；`idleEasterEggs: [{file, duration, chance, cooldownMs, requiresAccessories{head,mouth}}]`（按声明顺序对一次随机 roll 判定，累计概率 ≤ 1）。
  - 眼动：`eyeTracking: {enabled, states:["idle"], ids:{eyes:"eyes-js", body:"body-js", shadow:"shadow-js"}}`（对 SVG 节点做 translate，最大约 3px，body 轻微前倾、shadow 拉伸）。
- **交互集合**：点击/双击（方向感知）/四连击、任意状态拖拽、**眼动跟随**、睡眠-惊醒序列（60s 空闲触发）、mini 贴边模式（悬停探出、抛物线跳转）、透明区域点击穿透、位置记忆、单实例锁、多显示器适配、托盘、DND 勿扰、音效、权限气泡（Allow/Deny）、Telegram/飞书/Slack 远程通知、PWA 只读镜像、12 种动画状态。
- **AI 接入与提示词可定制性**：**它本身不是 AI 客户端**——通过各 coding agent（Claude Code、Codex、Copilot、Gemini、Cursor…几十种）的 hooks / JSONL 会话日志把「事件」映射成桌宠状态（另见 `docs/guides/state-mapping.md`）。没有 LLM 调用、没有提示词面板；提示词注入发生在被集成的 agent 侧（如 `~/.claude/CLAUDE.md` 之类的 instructions 文件）。
- **License 结论**：代码 **AGPL-3.0**——网络分发也会触发开源义务，**代码不可抄进闭源 Electron 应用**；README 明确 `assets/` 与 `themes/*/assets/` 美术素材**不在 AGPL 覆盖范围**，版权归各自作者（Clawd 角色属 Anthropic，另两个角色「保留所有权利」）。→ **可借鉴的是 `theme.json` 这套字段设计与状态/反应/空闲池的工程化拆分，落地时自行实现**。

### 2.7 [补充·高星] moeru-ai/airi（Electron AI 陪伴体）

> 检索来源：GitHub 搜索 `AI 桌宠` / `ai desktop pet`（按星排序）的高星项目。

- **仓库全名 / 星数**：`moeru-ai/airi`，**49258★**（fork 4894），本次调研全部候选中星数第一。
- **活跃度**：创建 2024-12-01，最后推送 2026-09-19，开放 issue 234，未归档。
- **平台 / 语言**：TypeScript 单仓多端——Stage Web（浏览器 PWA）、**Stage Tamagotchi（桌面，Electron：`apps/stage-tamagotchi/electron.vite.config.ts` + `electron-builder.config.ts`）**、Stage Pocket（Capacitor 移动端）；共享 `packages/stage-ui`。
- **素材组织格式**：**Live2D(Cubism) 与 VRM 双后端**，模型与角色卡在应用内选择/导入（`packages/stage-ui` 下的模型与设置 store）；仓库内是示例模型/资源。没有像 clawd 那样的主题包 manifest。
- **动画行为的可编辑配置格式**：以「基础动画能力」为主而非状态机——VRM/Live2D 的**自动眨眼、自动看向、待机视线漂移**；情绪 → 动作由常量枚举驱动（`packages/stage-ui/src/constants/emotions` 的 `EMOTION_VALUES` / `EMOTION_EmotionMotionName_value`）。没有面向用户的行为脚本文件。
- **交互集合**：语音输入（浏览器/Discord，含 VAD 与客户端 ASR）、多 provider TTS 说话、聊天（Web/Discord/Telegram）、记忆（DuckDB WASM / pglite，Memory Alaya 开发中）、可参与 Minecraft/Factorio/KSP、桌面宠物窗口。
- **AI 接入与提示词可定制性**：**强**。经 `xsai` 统一接入 30+ 家（OpenAI/Azure/Anthropic/DeepSeek/Qwen/Gemini/Ollama/vLLM/SGLang/OpenRouter…，`README` 有完整勾选表）；TTS 亦多 provider。**提示词是分层拼接的**：
  - `packages/stage-ui/src/composables/use-airi-runtime-prompt.ts`：按 i18n key（`base.prompt.emotion` / `base.prompt.emoji` / `base.prompt.suffix`）取模板，并把 `EMOTION_VALUES` 自动渲染成 `- <emotion> (Emotion for feeling <MotionName>)` 的**能力清单**追加进提示词——即「可用情绪/动作词表由代码常量生成，随语言切换」。
  - `packages/stage-ui/src/stores/ai/chat-llm/toolset-prompts.ts`：各 provider 注册的工具说明被渲染成 `## Toolset` 段落注入（可选标题、按 provider 隔离与清理）。
  - `packages/stage-ui/src/stores/chat/context-prompt.ts`：从 `@proj-airi/core-agent` 引入 `buildContextPromptMessage`，把上下文快照转成一条提示消息。
- **License 结论**：`LICENSE` = **MIT**（Copyright (c) 2024-PRESENT Neko Ayaka）→ 代码、提示词分层与 provider 抽象都可借鉴（保留版权声明）；仓库内/示例的 Live2D、VRM 模型素材须按各自来源核对（模型版权不随代码许可走）。

---

## 3. 其他已核数候选（未展开，供后续取用）

| 仓库全名 | 星数 | 平台 / 语言 | 素材 / 行为配置要点 | License 结论 |
|---|---|---|---|---|
| `ayangweb/BongoCat` | 23324 | 跨平台（Tauri 2 + Vue，非 Electron） | Live2D Cubism 资产：`src-tauri/assets/models/<standard\|keyboard\|gamepad>/cat.model3.json` + `.moc3`/`.exp3.json`/`.motion3.json`；`src/stores/model.ts` 管理模型导入与 `currentMotions/currentExpressions/shortcuts` | 代码 MIT；**模型与 Cubism Core 受 Live2D 条款约束**，更多模型见其 `Awesome-BongoCat` 仓库（各自授权）→ 交互设计可借鉴，渲染路线不建议跟 |
| `OpenPetsHQ/openpets` | 1213 | Electron / TypeScript | 宠物包 = 元数据 + `spritesheet.webp` 网格帧 + **reaction → animation 可配置映射表** + 语音文本池；插件 SDK v3（沙箱 BrowserWindow、权限清单、`ctx.pets/ui/schedule/ai/...`），MCP 层让 agent 触发动画 | 代码 **MIT** → 可直接借鉴包格式、反应映射与插件权限模型 |
| `ChaozhongLiu/DyberPet` | 977 | 跨平台 / Python（PySide6） | 角色包 `res/role/<角色>/`：`act_conf.json`（`images` 前缀、`act_num`、`need_move`、`direction`、`frame_move`、`frame_refresh`、`anchor`）+ `pet_conf.json`（必需动作映射、`random_act[{name,act_list,act_prob,act_type}]`、`accessory_act`）+ `msg_conf.json` + `action/<前缀>_<n>.png`；另有昼夜作息系统 | **GPL-3.0** → 设计与字段可读、代码不可抄 |
| `Ikaros-521/AI-Vtuber` | 4453 | Windows / Python | 直播弹幕 + 多 LLM（ChatGPT/Claude/Ollama 等）驱动，偏「直播中控台」而非桌宠 | **GPL-3.0**，最后推送 2025-07-29（趋缓） |
| `Hanzoe/Pet-GPT` | 431 | Windows / Python（PyQt） | PyQt 桌宠 + OpenAI 上下文对话 + 主动找你聊天（自主说话的最小实现） | **GPL-3.0**，最后推送 2025-03-21 |

---

## 4. 可借鉴要点

### 4.1 素材包格式设计

**证据（五个成熟方案）**

1. **Shimeji**：素材 = `img/<角色>/*.png`（一帧一图）+ 角色可选的 `conf/` 覆盖全局配置；「一个角色 = 一个图片集目录」，换角色 = 换目录。
2. **VPet**：素材 = `mod/<MOD>/{pet,image,food,file}/`，路径本身携带元数据（状态/类型/名称/段/帧时长），配置文件可覆盖路径解析；帧时长写进文件名，解析失败逐字段回退默认值。
3. **clawd-on-desk**：素材 = 主题目录 + `theme.json`（`schemaVersion`、`viewBox` 逻辑画布、必需状态清单、`layout`、`hitboxes`），配脚手架与校验脚本；还支持导入 **Codex Pet zip 图集**——说明「图集 + 清单」是当前社区的实际交换格式。
4. **xiaozhi**：素材 = 单一容器 `assets.bin` + `index.json` 清单（版本、分辨率、资源名表、表情名表），并提供浏览器端打包器让用户自己生成素材包。
5. **OpenPets**：`spritesheet.webp` 网格帧 + 元数据 + reaction 映射表，包从 catalog ZIP 安装、有校验与哈希。

**建议的素材包契约（可直接落地的草案）**

```
petpack/
├── pet.json            # 清单：schemaVersion / id / name / version / author / license
│                       # frameSize{w,h} / anchor{x,y}(脚底中心) / scale / defaultState
│                       # spritesheet(可选) 或 frames 目录约定 / states 文件名映射
├── anim/               # <state>_<index>.png 或 <state>.png（图集）
├── states.json         # 状态机（见 4.2）
├── prompts/            # 默认人格与工具提示词（见 4.4，可被用户级覆盖）
└── README.md / LICENSE # 素材来源与授权声明（学 Shimeji/OLV 把授权随包放）
```

- **帧引用要能两种形态共存**：单帧多文件（Shimeji/VPet/DyberPet 传统，编辑友好）与图集网格（OpenPets/clawd 导入格式，分发友好）。`pet.json` 里用 `frames: [{file, duration}]` 或 `atlas: {file, columns, rows, order}` 二选一。
- **锚点与画布必须显式**：Shimeji 的 `ImageAnchor`、DyberPet 的 `anchor`（「底部中心」约定，可解决睡觉时悬浮在任务栏上的问题）、clawd 的 `viewBox`/`hitboxes` 都在解决同一个问题——**所有帧共用同一逻辑画布与脚底锚点**，否则切动作会「闪一下」。这是要写进规范第一条的硬约束。
- **缺资源必须回退而不是报错**：clawd 的 `fallbackTo`、xiaozhi 的「缺表情回退 neutral」、VPet 的「每个字段有默认值」、Shimeji 的「必需行为缺失时的兜底」——统一为 `state → fallback 链`。
- **素材包要携带授权信息**：Open-LLM-VTuber 在 `live2d-models/<模型>/ReadMe.txt` 放来源与许可，Shimeji 把 `originallicence.txt` 随包发。我们的 `pet.json` 里放 `license` 字段 + 包内 `LICENSE`，并在 UI 里展示。

**论据：为什么倾向精灵帧序列、避开 Live2D Cubism SDK**

1. **授权链最短**。序列帧素材只有「美术著作权」一层；Live2D 路线是三层：Cubism Core（**Live2D Proprietary Software License**，专有）、Cubism SDK/Components（Open Software License 且**源码不能随包分发**）、模型本身（版权属原作者，`live2d-widget` 明确「仅供研究学习，不得商用」；`Open-LLM-VTuber` 的 MIT 明确把 Live2D 样例模型排除在外，另附 `LICENSE-Live2D.md`）。BongoCat 的 `.moc3` + `live2dcubismcore.min.js` 也是同一约束链。
2. **发布门槛**。Live2D Cubism SDK 除上述许可外还需满足其**发布许可**（按营收档位，条款以官网为准），而序列帧方案不存在这一层；对「不依赖平台、可自由替换素材」的产品定位，多一层授权就是多一个阻塞点。
3. **工程成本**。序列帧只需「定时切图」：`webmeji` 的 Creature 类（`playAnimation(frames, interval, loops, onComplete)`）、DyberPet 的 `frame_refresh`/`act_num`、Shimeji 的 `Pose Duration`、VPet 的帧时长命名，本质是同一个极简模型；Live2D 需要 Core 运行时（wasm/js）+ `moc3`/`model3.json`/`physics3.json`/`exp3.json`/`motion3.json` 一整套资产管线 **以及建模师**。
4. **素材可替换性**。Live2D 换皮要重做绑定/变形器，用户「自由替换素材」几乎不可能自助完成；序列帧只要尺寸/锚点对齐即可换（clawd 甚至能直接把图集转成主题，VPet 的 MOD 制作器能自动生成帧）。
5. **生态与体积**。序列帧已有大量现成素材与交换格式（Codex Pet zip 图集、Shimeji 角色图包、DyberPet 角色包、OpenPets catalog ZIP），且可按需加载 + 缓存（VPet 的做法）；Live2D 额外背一个专有运行时。
6. **保留升级路径**：把渲染后端做成可插拔（VPet 的插件机制已证明可行——README 明示插件可新增「l2d/spine 等显示方案」），先用精灵帧把「素材包 + 状态机 + 提示词 + 交互」四件事做对，未来需要 Live2D 时作为可选后端接入，而不是一开始就绑死。

### 4.2 行为状态机配置

**证据（四种成熟表达）**

| 项目 | 表达方式 | 可学之处 |
|---|---|---|
| Shimeji `conf/behaviors.xml` | `<Condition>`（脚本表达式：地板/墙/天花板/窗口/光标/同类数量）分组；`<Behavior Name Frequency Hidden>` + `<NextBehaviorList Add>` + `<BehaviorReference Name Frequency Condition>` | 条件 + **加权转移** + 候选「替换/追加」语义；`Frequency=0` 即禁用；必需行为与可选行为分离 |
| VPet `GraphInfo` | 枚举维度：动画类型 × 状态（4）× 动作段（A/B/C/Single），配置字段覆盖路径解析 | **类型枚举固定 + 自定义扩展**；三段式保证「入场-循环-退场」不撕裂 |
| clawd `theme.json` | `states` + `fallbackTo` + `workingTiers` + `sleepSequence.mode` + `reactions` + `idleAnimations` | 状态→资源是**映射表**；能力由字段推导（`Tracked idle` 等徽章）；有 `validate` 脚本与必需状态清单 |
| DyberPet `act_conf.json` | 动作 = 帧序列 + 移动参数（`need_move/direction/frame_move/frame_refresh/anchor`）；`random_act` 把动作组合成「动画」 | **动作与动画分离**：动作是原子帧序列，动画是动作的组合 + 概率 + 解锁条件 |

**建议的状态机契约**

```jsonc
// states.json（素材包内）
{
  "schemaVersion": 1,
  "initial": "idle",
  "states": {
    "idle":      { "anim": "idle",      "loop": true,  "interrupt": "low" },
    "thinking":  { "anim": "thinking",  "loop": true,  "interrupt": "normal" },
    "happy":     { "anim": "happy",     "loop": false, "interrupt": "high", "onEnd": "idle" },
    "dragged":   { "anim": "dragged",   "loop": true,  "interrupt": "locked" },  // 不可被自主行为打断
    "sleeping":  { "anim": "sleeping",  "loop": true,  "interrupt": "low" }
  },
  "transitions": {
    "idle": [
      { "to": "sleeping", "weight": 10, "afterMs": 60000, "when": { "field": "userIdleMs", "op": ">=", "value": 60000 } },
      { "to": "happy",    "weight": 5,  "when": { "field": "affinity",   "op": ">=", "value": 80 } }
    ]
  },
  "fallback": { "happy": "idle" }   // 缺资源时借用的动画，逻辑状态不变
}
```

要点（全部有先例）：
- **加权随机 + 冷却 + 概率预算**：Shimeji `Frequency`、DyberPet `act_prob`、clawd `chance/cooldownMs` 三处一致。
- **中断等级**：拖拽/交互等用户操作不可被自主行为抢占；VPet 把「交互反馈」排在「状态切换」之前，clawd 用「多会话取最高优先级状态」。
- **条件用结构化对象，而不是脚本字符串**：Shimeji 的 `#{...}` 表达式需要内嵌 JS 引擎，灵活但带来安全与可编辑性成本；我们的条件应是 `{field, op, value}` 白名单求值（字段来自运行时快照：空闲时长、鼠标距离、屏幕边缘、饥饿/心情、前台应用等）。这样条件能被 UI 直接渲染成下拉框，也能被校验器静态检查。
- **可校验**：抄 clawd 的做法——提供 `validate` 命令 + 必需状态清单 + 缺资源回退；抄 xiaozhi 的做法——导出前先列出「资源清单」让用户确认。
- **XML 还是 JSON**：Shimeji 用 XML（2009 年 + XSD 校验），Electron/TS 侧用 JSON 零依赖、可直接 `JSON.parse` + JSON Schema 校验，并与 `theme.json`/`pet.json` 统一。

### 4.3 自主行为循环设计

**证据**

| 项目 | 自主行为机制 |
|---|---|
| clawd-on-desk | `idleAnimations[{file,duration}]` 随机池；`idleEasterEggs[{chance,cooldownMs,requiresAccessories}]` 按声明顺序对**一次随机 roll** 判定，累计概率 ≤ 1；**资格二次校验**（隐藏/低功耗/mini/漫游/拖拽/菜单打开/非 idle 不参与、也不消耗概率与冷却）；60s 空闲进睡眠序列，鼠标移动触发惊醒；`roam` 自由漫游有独立视觉 |
| DyberPet | `random_act[{name, act_list, act_prob, act_type}]`：概率 + 饱食度等级/好感度门槛；**昼夜作息系统**让白天/夜晚使用不同动画池；`hide_night` 夜间隐藏 |
| VPet | `Idel`/`StateONE`/`StateTWO` 空闲池 + 饥饿/口渴/心情等数值驱动状态切换（`Switch_Up`、`Switch_Down`、`Switch_Hunger`、`Switch_Thirsty` 动画） |
| Open-LLM-VTuber | **主动说话**：无用户输入时按 `proactive_speak_prompt` 触发一轮 LLM 输出 |
| Shimeji | `Frequency` 加权 + 环境条件（地板/墙/天花板/IE 窗口）+ 多只同类互动与分裂上限 |

**建议的循环（每个 tick 做四件事）**

```text
1) 更新世界状态：空闲时长、鼠标距离/方向、屏幕与边缘、数值衰减(饱食/心情/好感)、前台应用/是否全屏
2) 抑制判定（不过则整轮跳过，且不消耗冷却/概率）：
   拖拽中 / 菜单打开 / 用户正在输入 / DND / 全屏应用 / 已被高优先级状态占用 / 距上次自主行为 < 冷却
3) 抽样：候选 = 满足 when 条件且已解锁的行为；按 weight 归一化随机；受 chance 与每日/每小时预算约束
4) 执行：播放动画（记录不可打断段）→ onEnd 回到 idle；失败/缺资源走 fallback
```

- **节流是必须的**（论据：clawd 专门写了「资格二次校验 + 冷却 + 不消耗概率」的规则，说明无节流的随机行为在真实使用中会变成骚扰）；建议默认给「最小间隔 + 每小时上限 + 免打扰时段」三项。
- **数值衰减驱动状态**（VPet/DyberPet）：让「饿/困/心情差」自然改变权重，而不是纯定时器。
- **昼夜与场景**（DyberPet 昼夜系统、clawd 的 mini/roam）：同一套 `states.json` 换权重表即可，不要写死。
- **自主说话要单列通道**：Open-LLM-VTuber 把主动说话做成独立提示词 + 独立触发，便于单独开关与限流；我们应把「自主行为（动画）」与「自主说话（LLM）」分成两个调度器，后者有更严格的频率上限与内容边界。

### 4.4 系统提示词注入点

**证据（四种注入方式）**

| 项目 | 注入点 |
|---|---|
| Open-LLM-VTuber | `character_config.persona_prompt`（人格）+ `system_config.tool_prompts` 挂载的独立提示词文件（表情词表 `live2d_expression_prompt.txt` 带 `<insert_emomap_keys>` 占位符、`mcp_prompt.txt`、`proactive_speak_prompt.txt`、`group_conversation_prompt.txt`）；`characters/*.yaml` 覆盖式角色配置；运行时把 `emotionMap` 的键生成 `[k1], [k2]...` 注入模板，LLM 输出 `[k]` 再被解析回表情 |
| xiaozhi-esp32 | 提示词在服务端（控制台/自建），设备端只通过 MCP 工具描述声明能力 |
| moeru-ai/airi | `use-airi-runtime-prompt.ts` 把 `EMOTION_VALUES` 常量渲染成情绪-动作清单（随 i18n 语言切换）；`toolset-prompts.ts` 把各 provider 注册的工具说明渲染成 `## Toolset` 段；`context-prompt.ts` 用 `buildContextPromptMessage` 注入上下文快照 |
| OpenPets | 插件通过 `ctx.ai` 复用宿主配置的 provider（**插件拿不到 API key**）；`pet:speak:dynamic` 这类敏感能力必须声明权限并由用户同意 |

**建议的注入点分层（顺序即拼接顺序）**

```text
[L0 基座人格]  persona.md（用户可编辑；支持 {petName} {userName} {affinity} 等变量）
[L1 能力清单]  由运行时自动生成：可用情绪/动作标签表（来自素材包 states/emotions）
               + 可用工具/MCP 列表（来自工具注册表）——禁止手写，避免与实现漂移
[L2 上下文]    当前状态、最近 N 轮交互摘要、桌宠数值（饱食/心情/好感）、
               可选的前台应用/时间/全屏状态（隐私相关项默认关闭、可开关）
[L3 自主行为]  proactive.md（主动说话专用短提示词，独立文件、独立开关与限流）
[L4 输出协议]  要求结构化输出：文本 + [emotion]/[action] 标签（或 JSON tool_call），
               解析失败回退纯文本；只允许使用 L1 声明的标签
[L5 安全边界]  不执行未注册动作、不主动读取隐私数据、DND/全屏时不得主动打扰
```

- **文件化 + 可覆盖**：默认提示词随素材包走（`petpack/prompts/`），用户级 `prompts/overrides/` 优先（先例：Open-LLM-VTuber 的 `characters/*.yaml` 覆盖、clawd 的用户主题目录覆盖内置主题）。
- **能力清单自动生成是共识**：OLV 的 `emo_str` 由 `emotionMap` 生成、AIRI 的情绪词表由 `EMOTION_VALUES` 生成——手写清单一定会和素材包脱节，导致 LLM 输出不存在的表情标签。
- **表情/动作标签是提示词与状态机的接缝**：LLM 只负责产出 `[emotion]`/`[action]` 标签，状态机负责校验（标签必须在册）并映射到动画；未知标签静默忽略并回退到 idle（对应 4.2 的 fallback 链）。
- **AI 内容进入桌宠需要权限与边界**（OpenPets 的权限模型）：动态说话、读剪贴板、监听语音等要显式声明并由用户授权，API key 只留在主进程/宿主侧，不进渲染层与插件。
- **多平台 = 只换 `base_url` + 模型名**：OLV 的 `openai_compatible_llm.base_url` 与 AIRI 的 xsai provider 表都证明——提示词层不要绑定任何厂商 SDK，配置里只留 provider + base_url + model + key 引用。
