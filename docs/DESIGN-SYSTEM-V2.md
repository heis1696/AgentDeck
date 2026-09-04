# AgentDeck 设计体系 v2

> 规格版本：v2.0.0 · 生效时间：2026-09-05  
> 替代：styles.css 四代覆盖层（0.7 基础 → 0.8 Linear 式 → 0.10 浅色补丁 → 0.11 令牌 v2 → 0.12 骨架）

---

## 一、设计立场

**视觉主张**：工作台的克制——深夜驾驶舱的深邃平静 + 一处电弧光的唤醒力。

**签名元素**：**状态光环（Status Pulse）** —— 任务执行时，相关 UI 元素边缘有微弱的动态光晕（运行中=蓝色电弧脉冲，排队=琥珀呼吸，完成=翠绿熄灭）；所有静态状态仅用色块+文字，只有运行中的状态带光。这是多 agent 并行调度的视觉隐喻：甲板指挥台上每个活跃 agent 都是一个发光的信号点，一眼看到谁在工作、谁在等待。

### 为什么不是"模板化 AI 脸"？

- ✗ **奶油底+衬线+赤陶** → 适合内容平台，不适合密集操作的生产力工具。
- ✗ **深底+酸性绿单一强调** → 极客感过重，缺乏信息层级。
- ✗ **报纸式栏目+发丝线** → 过于编辑化，不适合即时状态感知。

**AgentDeck 的选择**：深色为主（长时操作护眼）+ 层次分明的表面系统 + 状态用色彩编码（运行/排队/成功/失败四态清晰）+ **唯一的动态光效用于运行中状态**，其他一切保持安静。信息密度优先，大胆花在动态光晕上，其余克制到底。

---

## 二、令牌系统

### 2.1 色彩令牌

#### 暗色模式（主模式）

```css
/* 表面四层：壳 → 画布 → 表面 → 浮起 */
--app-shell: #080a0d;           /* 最外框，包裹整个应用 */
--bg: #0e1218;                  /* 页面画布（内容生活的地方）*/
--bg-raised: #161b23;           /* 表面（卡片/输入框）*/
--bg-hover: #1d242e;            /* 表面悬停 */
--bg-inset: #0b0f14;            /* 凹陷输入（文本框内部）*/
--bg-selected: #1a2535;         /* 选中态背景 */

/* 边框 */
--border: #1f2730;              /* 默认边框 */
--border-strong: #2a3240;       /* 强调边框（浮层/对话框）*/

/* 文字 */
--text: #e8ebf0;                /* 主文字 */
--text-dim: #8f97a8;            /* 次要文字 */
--text-faint: #5a6372;          /* 辅助文字（提示/标签）*/

/* 品牌色 */
--accent: #4d88ff;              /* 主强调色（链接/按钮/焦点）*/
--accent-soft: rgba(77, 136, 255, 0.12);  /* 柔和背景 */
--accent-glow: rgba(77, 136, 255, 0.24);  /* 光晕效果 */

/* 状态色：运行态光环的核心 */
--status-running: #4d88ff;      /* 运行中=蓝色电弧 */
--status-running-bg: rgba(77, 136, 255, 0.10);
--status-running-glow: rgba(77, 136, 255, 0.28);  /* 脉冲光晕 */

--status-queued: #d9a23c;       /* 排队=琥珀 */
--status-queued-bg: rgba(217, 162, 60, 0.12);
--status-queued-glow: rgba(217, 162, 60, 0.22);   /* 呼吸光晕 */

--status-done: #38b86f;         /* 成功=翠绿（不发光）*/
--status-done-bg: rgba(56, 184, 111, 0.12);

--status-failed: #e55c52;       /* 失败=红（不发光）*/
--status-failed-bg: rgba(229, 92, 82, 0.12);

--status-cancelled: #6b7280;    /* 已取消=灰（不发光）*/
--status-cancelled-bg: rgba(107, 114, 128, 0.10);

/* 功能色 */
--ok: #38b86f;
--warn: #d9a23c;
--err: #e55c52;

/* 阴影：双阴影系统（menu 轻 / pop 重）*/
--menu-shadow: 0 10px 30px rgba(0, 0, 0, 0.35), 0 2px 10px rgba(0, 0, 0, 0.22);
--shadow-pop: 0 22px 52px rgba(0, 0, 0, 0.50), 0 4px 14px rgba(0, 0, 0, 0.30);

/* 字体 */
--font-ui: -apple-system, 'Segoe UI', 'Microsoft YaHei UI', 'PingFang SC', sans-serif;
--font-mono: 'Cascadia Code', 'Cascadia Mono', Consolas, 'Courier New', monospace;
```

#### 浅色模式（完整映射，不依赖组件级补丁）

```css
--app-shell: #eceef2;
--bg: #f6f8fb;
--bg-raised: #ffffff;
--bg-hover: #eef1f6;
--bg-inset: #fafbfd;
--bg-selected: #e5ebf5;

--border: #e0e4eb;
--border-strong: #cfd5e0;

--text: #18191d;
--text-dim: #5a6474;
--text-faint: #97a0b3;

--accent: #3862d8;
--accent-soft: rgba(56, 98, 216, 0.09);
--accent-glow: rgba(56, 98, 216, 0.18);

--status-running: #3862d8;
--status-running-bg: rgba(56, 98, 216, 0.08);
--status-running-glow: rgba(56, 98, 216, 0.20);

--status-queued: #b8811c;
--status-queued-bg: rgba(184, 129, 28, 0.10);
--status-queued-glow: rgba(184, 129, 28, 0.18);

--status-done: #1a7d47;
--status-done-bg: rgba(26, 125, 71, 0.10);

--status-failed: #c73c34;
--status-failed-bg: rgba(199, 60, 52, 0.10);

--status-cancelled: #6b7280;
--status-cancelled-bg: rgba(107, 114, 128, 0.08);

--ok: #1a7d47;
--warn: #b8811c;
--err: #c73c34;

--menu-shadow: 0 10px 30px rgba(30, 42, 76, 0.11), 0 2px 10px rgba(30, 42, 76, 0.07);
--shadow-pop: 0 22px 52px rgba(30, 42, 76, 0.15), 0 4px 14px rgba(30, 42, 76, 0.09);
```

### 2.2 排印令牌

**字阶（全站仅此六步，不可擅自添加中间值）**：

```css
--text-micro: 11px;       /* 角色：时间戳、辅助标签、键盘提示 */
--text-caption: 12px;     /* 角色：描述、次要信息、表格正文 */
--text-label: 13px;       /* 角色：列表项标题、按钮、输入框 */
--text-body: 14px;        /* 角色：正文、输入文本 */
--text-title-sm: 16px;    /* 角色：卡片标题、对话框标题 */
--text-title: 18px;       /* 角色：页面标题 */
```

**字重**：
- 常规：400（西文）/ 450（中文，系统字体自动映射）
- 中粗：550（西文 medium）/ 600（中文）
- 粗体：650（标题）/ 700（品牌/强调）

**行高**：
- 密集信息（列表/表格）：1.4
- 正文/输入框：1.55
- 对话气泡/markdown：1.65

**中文字体栈**（已写入 `--font-ui`）：
```
-apple-system, 'Segoe UI', 'Microsoft YaHei UI', 'PingFang SC', sans-serif
```

**等宽字体栈**（代码/令牌/时间戳）：
```
'Cascadia Code', 'Cascadia Mono', Consolas, 'Courier New', monospace
```

### 2.3 间距刻度

基准 `4px` 倍率制（4 / 6 / 8 / 10 / 12 / 16 / 20 / 24），常用场景：

| 值    | 场景 |
|-------|------|
| 4px   | 图标与文字间距、徽标内边距 |
| 6px   | 按钮组间距、tab 间距 |
| 8px   | 卡片内边距（紧凑）、列表项间距 |
| 10px  | 输入框内边距、小卡片边距 |
| 12px  | 标准卡片内边距、区块间距 |
| 16px  | 页面边距（PAGE_GUTTER）、面板内边距 |
| 20px  | 详情页主列水平内边距 |
| 24px  | 页面顶部内边距、大区块间距 |

### 2.4 圆角令牌

```css
--radius-sm: 6px;    /* 小按钮、菜单项、徽标 */
--radius-md: 8px;    /* 输入框、卡片、对话框 */
--radius-lg: 12px;   /* 大卡片、浮层面板 */
--radius-pill: 999px; /* 胶囊按钮、状态芯片 */
```

### 2.5 动效令牌

**基准时长**：
```css
--duration-quick: 0.10s;   /* 菜单展开、toast 入场 */
--duration-base: 0.12s;    /* 按钮悬停、边框变色、背景变色 */
--duration-slow: 0.16s;    /* 对话框入场、面板滑入 */
--duration-pulse: 1.4s;    /* 状态光环脉冲周期 */
```

**缓动函数**：
```css
--ease-out: cubic-bezier(0.2, 0, 0.3, 1);      /* 入场、展开 */
--ease-in-out: cubic-bezier(0.4, 0, 0.2, 1);   /* 悬停、状态切换 */
```

**何时用哪个**：
- `0.12s ease-in-out`：默认交互反馈（按钮悬停、边框高亮）
- `0.10s ease-out`：快速响应（菜单展开、tooltip）
- `0.16s ease-out`：有重量感的入场（对话框、toast）
- **签名动画**：运行中状态的光晕用 `1.4s ease-in-out infinite`

### 2.6 焦点 ring 规范

```css
box-shadow: 0 0 0 3px var(--accent-soft);
outline: none; /* 禁用浏览器默认轮廓 */
```

- 所有可聚焦元素（按钮/输入框/菜单项）必须有 `:focus-visible` 态 ring。
- ring 用 `box-shadow` 实现（外发光 3px），不用 `outline`（不可控圆角）。
- `prefers-reduced-motion: reduce` 时，所有动画时长减半，光晕脉冲禁用（改为静态高亮）。

---

## 三、组件规格

### 3.1 按钮（Button）

#### 变体

| 类型         | 类名         | 暗色外观 | 浅色外观 | 用途 |
|--------------|--------------|----------|----------|------|
| **Primary**  | `.btn-primary` | 蓝色渐变 `linear-gradient(135deg, #4d88ff, #5e78ff)` + 光晕 | 同渐变深化 | 主要操作：创建任务、执行 |
| **Secondary**| `.btn` | `--bg-raised` + 边框 `--border-strong` | 白底 + 边框 | 次要操作：取消、关闭 |
| **Ghost**    | `.btn-ghost` | 透明背景 + 文字色 | 同暗色 | 三级操作：更多、辅助功能 |
| **Danger**   | `.btn-danger` | 透明 + 红边框 + 红文字 | 同暗色 | 破坏性：删除、停止 |
| **Pill**     | `.btn-pill` | 胶囊形（圆角 999px），小字 11.5px | 同暗色 | 工具栏开关、过滤标签 |

#### 五态规范

| 状态      | Primary                          | Secondary/Ghost/Danger           |
|-----------|----------------------------------|----------------------------------|
| **默认**  | 渐变 + `--shadow-pop` 轻量版     | 边框 + 背景 |
| **Hover** | `filter: brightness(1.08)` + `translateY(-1px)` + 光晕加强 | 背景变 `--bg-hover`、边框变 `--text-faint` |
| **Active**| `translateY(0)` + 光晕减弱       | 背景变 `--bg-selected` |
| **Disabled** | `opacity: 0.45` + `cursor: not-allowed` | 同 |
| **Focus** | ring `0 0 0 3px var(--accent-soft)` | 同 |

#### 尺寸

```css
.btn          { padding: 6px 14px; font-size: 13px; }
.btn-sm       { padding: 4px 10px; font-size: 12px; }
.btn-pill     { padding: 3px 14px; font-size: 11.5px; border-radius: 999px; }
```

### 3.2 输入框（Input / Textarea）

**默认态**：
```css
background: var(--bg-inset);
border: 1px solid var(--border);
border-radius: var(--radius-md);
color: var(--text);
padding: 8px 10px;
font-size: var(--text-label);
```

**五态**：
- **Hover**：边框变 `--border-strong`
- **Focus**：边框变 `--accent` + ring `0 0 0 3px var(--accent-soft)`
- **Disabled**：`opacity: 0.45` + 背景变 `--bg-raised`
- **Error**：边框变 `--err` + ring 变红色
- **Placeholder**：`color: var(--text-faint); opacity: 0.7;`

### 3.3 状态胶囊（Status Chip）

**基础样式**（所有状态共享）：
```css
.status-chip {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 10px;
  border-radius: var(--radius-pill);
  letter-spacing: 0.3px;
}
```

**五态颜色**：

| 状态          | 类名                | 暗色                          | 浅色                          | 光晕 |
|---------------|---------------------|-------------------------------|-------------------------------|------|
| **运行中**    | `.status-running`   | bg `var(--status-running-bg)` + 文字 `var(--status-running)` | 同 | **有光晕**（1.4s 脉冲）|
| **排队**      | `.status-queued`    | bg `var(--status-queued-bg)` + 文字 `var(--status-queued)` | 同 | **有光晕**（2.0s 呼吸）|
| **完成**      | `.status-done`      | bg `var(--status-done-bg)` + 文字 `var(--status-done)` | 同 | 无 |
| **失败**      | `.status-failed`    | bg `var(--status-failed-bg)` + 文字 `var(--status-failed)` | 同 | 无 |
| **已取消**    | `.status-cancelled` | bg `var(--status-cancelled-bg)` + 文字 `var(--status-cancelled)` | 同 | 无 |

**签名动画**（仅运行中/排队有）：
```css
@keyframes status-pulse {
  0%, 100% { box-shadow: 0 0 0 0 var(--status-running-glow); }
  50% { box-shadow: 0 0 8px 2px var(--status-running-glow); }
}
.status-running { animation: status-pulse 1.4s ease-in-out infinite; }

@keyframes status-breathe {
  0%, 100% { box-shadow: 0 0 0 0 var(--status-queued-glow); }
  50% { box-shadow: 0 0 6px 1px var(--status-queued-glow); }
}
.status-queued { animation: status-breathe 2.0s ease-in-out infinite; }
```

### 3.4 任务卡（Task Card）

**列表视图**：
```css
.task-item {
  padding: 8px 10px;
  border-radius: var(--radius-md);
  background: transparent;
  border: 1px solid transparent;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s;
}
.task-item:hover { background: var(--bg-hover); }
.task-item.selected {
  background: var(--accent-soft);
  border-color: var(--accent);
  box-shadow: inset 0 0 0 1px var(--accent);
}
```

**看板卡片**：
```css
.board-card {
  background: var(--bg-raised);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 9px 11px;
  cursor: pointer;
  transition: all 0.12s;
}
.board-card:hover {
  border-color: var(--accent);
  transform: translateY(-1px);
  box-shadow: var(--shadow-pop);
}
```

### 3.5 看板列（Board Column）

```css
.board-col {
  min-width: 220px;
  max-width: 280px;
  background: var(--bg-inset);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  display: flex;
  flex-direction: column;
  max-height: 100%;
}
.board-col-head {
  padding: 10px 12px 8px;
  border-bottom: 1px solid var(--border);
}
.board-col-body {
  padding: 8px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
```

### 3.6 标签页（Tabs）

**胶囊式标签**（详情页/设置页）：
```css
.tabs {
  display: flex;
  gap: 4px;
  padding: 0 20px;
  border-bottom: 1px solid var(--border);
}
.tabs button {
  padding: 4px 14px;
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: 12px;
  font-weight: 550;
  border-radius: var(--radius-pill);
  border-bottom: 2px solid transparent;
  cursor: pointer;
  transition: all 0.12s;
}
.tabs button:hover { color: var(--text); }
.tabs button.active {
  color: var(--accent);
  background: var(--accent-soft);
  border-bottom-color: var(--accent);
}
```

**任务标签条**（顶部打开的任务列表）：
```css
.tab {
  padding: 6px 8px 6px 12px;
  border: 1px solid var(--border);
  border-bottom: none;
  border-radius: var(--radius-md) var(--radius-md) 0 0;
  background: var(--bg-inset);
  cursor: pointer;
}
.tab.active {
  background: var(--bg-raised);
  border-color: var(--accent);
  box-shadow: inset 0 2px 0 var(--accent);
}
```

### 3.7 气泡（Bubble）

**用户气泡**：
```css
.bubble.user {
  align-self: flex-end;
  max-width: 86%;
  background: var(--accent-soft);
  border: 1px solid var(--accent);
  border-radius: var(--radius-md);
  padding: 10px 14px;
}
```

**Agent 气泡**：
```css
.bubble.agent {
  align-self: flex-start;
  max-width: 86%;
  background: var(--bg-raised);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 10px 14px;
  box-shadow: 0 1px 8px rgba(0, 0, 0, 0.25);
}
```

### 3.8 菜单（Menu）

```css
.menu-panel {
  position: absolute;
  z-index: 60;
  min-width: 150px;
  max-width: 280px;
  padding: 4px;
  background: var(--bg-raised);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-md);
  box-shadow: var(--menu-shadow);
  animation: menu-in 0.10s ease-out;
}
@keyframes menu-in {
  from { opacity: 0; transform: translateY(-3px); }
  to { opacity: 1; transform: none; }
}
.menu-item {
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  font-size: var(--text-label);
  cursor: pointer;
  transition: background 0.12s;
}
.menu-item:hover { background: var(--bg-hover); }
.menu-item.active { background: var(--bg-selected); }
.menu-item:disabled { opacity: 0.4; cursor: not-allowed; }
```

### 3.9 Toast

```css
.toast {
  display: flex;
  align-items: center;
  gap: 9px;
  max-width: 380px;
  padding: 10px 14px;
  background: var(--bg-raised);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-pop);
  font-size: var(--text-label);
  cursor: pointer;
  animation: toast-in 0.16s ease-out;
}
@keyframes toast-in {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: none; }
}
.toast-icon { font-size: 12px; }
.toast-success .toast-icon { color: var(--ok); }
.toast-error .toast-icon { color: var(--err); }
.toast-error { border-color: var(--err); }
```

### 3.10 对话框（Dialog）

```css
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.60);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.dialog {
  width: 560px;
  max-width: 92vw;
  background: var(--bg-raised);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-pop);
  padding: 20px;
  animation: dialog-in 0.16s ease-out;
}
@keyframes dialog-in {
  from { opacity: 0; transform: scale(0.96); }
  to { opacity: 1; transform: scale(1); }
}
.dialog h2 {
  font-size: var(--text-title-sm);
  font-weight: 650;
  margin-bottom: 14px;
}
```

### 3.11 命令面板（Palette，Ctrl+K）

```css
.palette {
  width: 560px;
  max-width: 90vw;
  background: var(--bg-raised);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-pop);
  overflow: hidden;
  animation: palette-in 0.12s ease-out;
}
@keyframes palette-in {
  from { opacity: 0; transform: translateY(-6px); }
  to { opacity: 1; transform: none; }
}
.palette-input {
  width: 100%;
  padding: 14px 16px;
  background: transparent;
  border: none;
  border-bottom: 1px solid var(--border);
  color: var(--text);
  font-size: var(--text-body);
}
.palette-item {
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  font-size: var(--text-label);
  cursor: pointer;
  transition: background 0.12s;
}
.palette-item.active { background: var(--bg-selected); }
```

### 3.12 空状态（Empty State）

```css
.empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: var(--text-dim);
  gap: 6px;
}
.empty-icon {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background: var(--bg-inset);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
  opacity: 0.6;
}
.empty-title {
  font-size: var(--text-body);
  font-weight: 550;
  color: var(--text);
}
.empty-desc {
  max-width: 400px;
  font-size: var(--text-caption);
  text-align: center;
  color: var(--text-dim);
}
```

### 3.13 骨架屏（Skeleton）

```css
.skeleton {
  background: linear-gradient(
    90deg,
    var(--bg-raised) 0%,
    var(--bg-hover) 50%,
    var(--bg-raised) 100%
  );
  background-size: 200% 100%;
  animation: skeleton-wave 1.6s ease-in-out infinite;
  border-radius: var(--radius-md);
}
@keyframes skeleton-wave {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
/* 具体形态 */
.skeleton-text { height: 14px; width: 100%; }
.skeleton-title { height: 18px; width: 60%; }
.skeleton-avatar { width: 36px; height: 36px; border-radius: var(--radius-md); }
```

### 3.14 属性栏（Property Panel，详情页右侧）

```css
.detail-panel {
  width: 320px;
  flex-shrink: 0;
  border-left: 1px solid var(--border);
  padding: 16px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.prop-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 24px;
}
.prop-label {
  width: 60px;
  flex-shrink: 0;
  color: var(--text-dim);
  font-size: var(--text-caption);
}
.prop-value {
  font-size: var(--text-label);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.prop-sep {
  border: none;
  border-top: 1px solid var(--border);
  margin: 2px 0;
  width: 100%;
}
```

---

## 四、交互态总规范

### 4.1 空态（Empty State）

- **所有列表/看板列/工作区**：居中空状态组件（圆形图标 + 标题 + 描述 + 可选操作按钮）。
- **空列表不显示表头**（避免孤零零的表头行）。
- **空看板列**：列内显示 `—`，保持列高度一致。

### 4.2 加载态（Loading）

- **初次加载**：骨架屏（保持布局结构，避免闪烁）。
- **局部刷新**：在刷新按钮上显示旋转图标，不遮挡内容。
- **流式输出**（对话）：气泡底部显示闪烁光标 `▊`，动画 `1.0s step-end infinite`。
- **运行中任务**：状态胶囊有脉冲光晕（签名动画）。

### 4.3 错误态（Error）

- **全局错误**（无法连接后端）：页面居中大错误卡片（图标 + 标题 + 技术细节折叠 + 重试按钮）。
- **任务失败**：详情页顶部红色 banner（错误码 + 可读提示 + 可选重试按钮 + 原始错误折叠）。
- **输入验证错误**：输入框红边框 + 下方红色小字提示。
- **网络请求失败**：toast 通知（红色边框 + 错误图标 + 简短消息）。

### 4.4 键盘导航矩阵

| 上下文          | 快捷键                        | 行为 |
|-----------------|-------------------------------|------|
| **全局**        | `Ctrl+K` / `Cmd+K`            | 打开命令面板 |
|                 | `Ctrl+N` / `Cmd+N`            | 新建任务（聚焦工作区输入框）|
|                 | `Ctrl+W` / `Cmd+W`            | 关闭当前标签页 |
|                 | `Ctrl+Tab` / `Ctrl+Shift+Tab` | 循环切换标签页 |
|                 | `Esc`                         | 关闭当前浮层（面板/对话框/菜单）|
| **命令面板**    | `↑` / `↓`                    | 上下选择 |
|                 | `Enter`                       | 执行选中命令 |
|                 | `Esc`                         | 关闭面板 |
| **菜单**        | `↑` / `↓`                    | 上下选择 |
|                 | `Enter`                       | 执行选中项 |
|                 | `Esc`                         | 关闭菜单 |
| **列表**        | `j` / `k` 或 `↑` / `↓`       | 上下选择（可选实现）|
|                 | `Enter`                       | 打开选中任务 |
| **输入框**      | `Tab`                         | 移到下一个输入框 |
|                 | `Shift+Tab`                   | 移到上一个输入框 |
|                 | `Enter`                       | 提交表单（多行输入 `Ctrl+Enter`）|

**焦点环规则**：
- 键盘焦点时显示 ring（`box-shadow: 0 0 0 3px var(--accent-soft)`）。
- 鼠标点击不显示 ring（用 `:focus-visible` 伪类区分）。
- `Tab` 顺序遵循视觉顺序（左→右，上→下）。

### 4.5 `prefers-reduced-motion` 降级

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01s !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01s !important;
  }
  /* 状态光晕改为静态高亮 */
  .status-running, .status-queued {
    animation: none;
    box-shadow: 0 0 0 1px var(--status-running);
  }
}
```

---

## 五、styles.css 重组方案

### 5.1 目标文件结构

```css
/* ============================================================
   AgentDeck 设计体系 v2 统一样式表
   版本：v2.0.0 · 生效时间：2026-09-05
   ============================================================ */

/* 第一区：令牌定义（@import tokens.css） */
/* 第二区：基础重置（reset + 全局字体） */
/* 第三区：布局骨架（app / sidebar / main / page-header / detail-columns） */
/* 第四区：组件样式（按字母序排列，每组件一段注释） */
/* 第五区：工具类（.mono / .dim / .truncate） */
/* 第六区：响应式断点（@media） */
/* 第七区：辅助功能（prefers-reduced-motion / prefers-color-scheme） */
```

### 5.2 四代覆盖层如何合并

**问题根源**：同一选择器在不同代际重复定义，后者部分覆盖前者，导致：
1. `:root` 出现三次（0.7 / 0.8 / 0.11），同名变量后者胜。
2. 浅色主题靠 `html.light .xxx` 组件级补丁维持（几十条散落规则）。
3. 同一组件样式分散在多个段落（如 `.btn` 基础在 0.7，`.btn:hover` 在 0.8，`.btn.primary` 又在别处）。

**迁移规则**（分四步执行）：

#### 步骤一：合并令牌定义
- 删除 styles.css 里所有 `:root` 和 `html.light` 段落。
- 在文件顶部 `@import 'tokens.css';`（新文件已包含完整暗/浅令牌）。
- 删除所有硬编码色值（如 `#171a21`、`rgba(79, 140, 255, 0.14)`），全部改为变量引用。

#### 步骤二：合并同名选择器
- 用搜索找到所有 `.xxx` 选择器，按组件分组。
- 每个组件的所有规则合并成一个 `.xxx { ... }` 块（默认态）。
- 伪类/状态分离成独立块：`.xxx:hover { ... }` / `.xxx.active { ... }` / `.xxx:disabled { ... }`。
- **铁律**：每个选择器在 styles.css 里只能出现一次（伪类除外）。

#### 步骤三：消除浅色补丁
- 删除所有 `html.light .xxx` 规则（约 50 条）。
- 浅色适配全部通过令牌变量自动完成——组件代码引用 `var(--bg)` / `var(--text)` 等，tokens.css 里 `html.light` 段重定义这些变量即可。
- **唯一例外**：如果某组件在浅色下需要完全不同的 `background-image`（如渐变方向），保留该 `html.light .xxx` 规则，但注释说明原因。

#### 步骤四：标注来源（可选）
- 每个组件块顶部加注释：`/* 按钮（Button）—— DESIGN-SYSTEM-V2.md §3.1 */`。
- 方便后续查规格。

### 5.3 验收标准

重组后的 styles.css 必须满足：
1. ✅ 不再有任何 `:root` / `html.light` 段落（已移到 tokens.css）。
2. ✅ 每个 CSS 选择器（不含伪类）只出现一次。
3. ✅ 不再有硬编码色值（全部用变量）。
4. ✅ `html.light` 组件级补丁不超过 5 条（且每条都有注释说明为何必须）。
5. ✅ 文件总行数减少到 ≤900 行（现在 1365 行）。
6. ✅ 按字母序排列组件块（除布局骨架在前）。

---

## 六、验收清单

### 设计规范
- [ ] 1. 签名元素（状态光环）在运行中/排队任务上可见，完成/失败无光晕
- [ ] 2. 色彩令牌：暗/浅两套完整，无组件级 `html.light` 补丁（≤5 条例外）
- [ ] 3. 字阶：全站仅用六步（micro/caption/label/body/title-sm/title），无中间值
- [ ] 4. 圆角：仅用四档（sm/md/lg/pill），无其他数值
- [ ] 5. 间距：基准 4px 倍率制，常用值为 4/6/8/10/12/16/20/24

### 组件规范
- [ ] 6. 按钮五态（默认/hover/active/disabled/focus）完整实现
- [ ] 7. 状态胶囊：运行中/排队有光晕动画，其他三态静态
- [ ] 8. 输入框 focus ring：`box-shadow: 0 0 0 3px var(--accent-soft)`，不用 outline
- [ ] 9. 菜单/toast/对话框入场动画：0.10s / 0.16s / 0.16s，缓动 ease-out
- [ ] 10. 任务卡 hover：背景变色 + 看板卡有 `translateY(-1px)` + 阴影

### 交互态
- [ ] 11. 空状态：圆形图标 + 标题 + 描述 + 可选操作按钮，居中
- [ ] 12. 骨架屏：1.6s 波浪动画，保持布局结构
- [ ] 13. 错误 banner：红底 + 错误码 + 可读提示 + 原始错误折叠
- [ ] 14. 流式输出：气泡底部闪烁光标 `▊`，1.0s step-end infinite

### 键盘导航
- [ ] 15. Ctrl+K 打开命令面板，↑↓ 选择，Enter 执行，Esc 关闭
- [ ] 16. Ctrl+N 聚焦工作区输入框，Ctrl+W 关闭当前标签页
- [ ] 17. 菜单 ↑↓ Enter Esc，所有可聚焦元素有 `:focus-visible` ring
- [ ] 18. Tab 顺序遵循视觉顺序（左→右，上→下）

### 辅助功能
- [ ] 19. `prefers-reduced-motion: reduce` 时动画时长 ≤0.01s，光晕改为静态高亮
- [ ] 20. 浅色主题完整可用，所有组件自动适配（无需手动切换类名）

---

## 七、后续迭代（不在本规格范围）

- **看板拖拽**：任务卡可拖到其他列，实时更新状态。
- **骨架屏实现**：加载时显示骨架，遵守 PAGE_GUTTER。
- **右键菜单**：任务卡/列表项右键显示操作菜单（复制链接/删除/归档）。
- **交接备注**：创建任务时可选输入，注入 prompt。
- **深色主题变体**：支持"更深"模式（--app-shell: #000000）。

---

**结语**：这套设计体系的核心是**克制的信息密度 + 一处大胆的动态光晕**。签名元素（状态光环）是 AgentDeck 多 agent 并行调度的视觉隐喻——甲板上每个活跃信号点都在发光，一眼看到谁在工作。所有静态状态保持安静，让运行态的光成为唯一的动态焦点。
