# 独立会议详情页 v0

**状态：已获用户确认的设计预览。** 2026-10-02 用户确认“可以，界面没问题”；正式会议组件已在未提交工作区接线，交付记录见 `docs/plan/team-meeting-issue-v2.md` §15。本文件仍只说明独立 v0 人工夹具，不代表安装版本。

## 查看

直接用浏览器打开 `docs/preview/team-meeting-v0.html`，无需启动 Electron、开发服务器或安装依赖。初次打开不自动抢开侧栏；点击顶部成员或气泡中的“查看本次执行”即可打开。

```powershell
Start-Process (Resolve-Path -LiteralPath 'docs/preview/team-meeting-v0.html').Path
```

也可看同目录的 `team-meeting-v0-dark.png`、`team-meeting-v0-light.png` 和 `team-meeting-v0-narrow.png`。截图中的选中侧栏由预览参数显式指定，不代表默认自动打开。

## 已确认设计

- 沿用普通 Issue 的标题、状态、成员栏、实名时间线、底部输入与右侧分栏，是否符合预期？
- 点击旧发言后，右侧固定该成员及该发言的 Task / Run / Turn；其他成员发言不切走。勾选“跟随当前发言者”才跟随，手动选择则退出跟随。
- 当前公开发言与内部调查分开显示；执行历史、投递版本、调查和日志在右侧，不跳普通任务页。
- “正在停止 / 停止受阻 / 已停止”是否足够清楚？停止受阻不会写成成功，执行失败不等于退出确认。
- 浅色、深色及窄窗下的正文密度和侧栏宽度，是否需要调整？

## 明确边界

- 所有内容、成员运行状态、投递信息、调查、工具事件、日志和纪要票数都是**人工夹具**；不是生产记录，也不代表 Claude 或其他平台真实验收通过。
- 预览复用现有 `src/renderer/src/tokens.css`，没有新增 UI 框架、图片生成服务或主进程依赖。预览不进入 renderer 构建，不改生产路由、不调用 `window.agentdeck`，停止、删除、发送及导航均不执行。
- 夹具接口遵循 `src/shared/meeting.ts` 的 `readTurns / getTurn / memberExecutions` 数据形状；不从评论标题反向解析。初始全量固定水位分页，后续仅按 `afterVersion` 增量，以稳定 ID / 版本合并。点“演示下一位发言”还会更新第一条旧序号记录，以验证不会被序号下界排除。
- 确认后的正式施工接入公共发言 API、`SideDock / WorkerPane`、全入口路由、真实控制按钮、错误重试、跨会议缓存、历史记录及 Markdown；预览中的缓存与日志模板仍不是正式实现，不用它替代真实组件验收。
- 阶段 4 的迁移、性能验收、打包、热更、安装版及生产历史核验尚未开始；既有完整 `smoke:all` 失败记录与退出证据不变。

## 预览验证

```powershell
node docs/preview/team-meeting-v0.test.mjs
```

该测试仅核验本地夹具交互，不替代真实页面、真实退出证明或真实平台验收。正式代码的验证门仍为 `npm run typecheck`、`npm run build`、`npm run smoke:stage6` 及触达面的专项。

2026-10-02 本轮：预览交互 31 项通过；`typecheck`、`build`、`smoke:stage6`、`smoke:ui` 通过。已用独立临时浏览器 profile 检查 1440×1000 深浅主题和 820×1000 窄窗截图；没有启动开发版 Electron 或连接生产数据。

确认后的真实 renderer/CSS 验证入口为 `npm run smoke:ui-meeting-browser`：使用人工 bridge 数据和独立 Edge profile，不运行模型或操作生产数据。真实组件明暗、窄窗及堆叠成员分栏截图输出到 `gui-test-screenshots/meeting-stage3/`，与本目录的静态 v0 截图区分。
