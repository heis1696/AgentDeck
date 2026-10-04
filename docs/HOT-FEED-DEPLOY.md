# 热更 feed 部署指南（阿里云 118.31.43.156）
> ✅ 当前已核验 v0.23.7 / 0.23.7-hot.1，源码发布提交 383cc9d；启动性能根治批（存储读路径缓存化 + 窗口先行 + app:ready 就绪屏障）已发包，三通道 HTTP 拉取验签与 zip 哈希复核通过。0.23.4 及更早发布记录保留为历史。


> 配套设计：`docs/HOT-UPDATE-IMPL-DESIGN.md` §6.2/§9.1、`docs/archive/INSTALLER-FREE-HOT-UPDATE.md`。
> 现阶段：IP 直连 HTTP（域名审核中）。内容真实性由 Ed25519 manifest 验签兜底，不依赖传输层加密；域名到位后按文末步骤迁移 HTTPS。

## 一、服务器侧（一次性，约 5 分钟）

### 1. 安装并配置 nginx

```bash
ssh root@118.31.43.156
apt install -y nginx   # 或 yum install -y nginx
mkdir -p /var/www/agentdeck-feed
cat > /etc/nginx/conf.d/agentdeck-feed.conf <<'EOF'
server {
    listen 80;
    server_name 118.31.43.156;
    root /var/www/agentdeck-feed/stable;
    autoindex off;
    sendfile on;
    # manifest 是定点入口（服务端回滚点），必须实时；zip 不可变，尽量缓存
    location ~ /manifest\.json$ { add_header Cache-Control "no-cache"; }
    location ~ \.zip$ { add_header Cache-Control "public, max-age=604800, immutable"; }
}
EOF
nginx -t && systemctl reload nginx
```

### 2. 安全组

阿里云控制台 → ECS → 安全组：放行 **TCP 80** 入方向（源 0.0.0.0/0）。

> **IP 直连与备案**：大陆服务器无域名时 IP 直连 80 端口一般可用；若被运营商/平台阻断，改用高位端口（如 `listen 8443;` + 安全组放行 8443），并同步把 `src/main/hot/trust.ts` 的 `DEFAULT_FEED_BASE` 改为 `http://118.31.43.156:8443` 重发壳版本，或在客户端设置页把更新源填成带端口地址。

## 二、每次发版（两条命令）

```bash
# 1) 产出三层 feed（renderer/payload/shell）+ 便携分发包 dist/agentdeck-<版本>-portable-win-x64.zip
HOT_SIGNING_KEY_PATH="C:\Users\16961\.agentdeck\hot-keys\ad-2026-09-r2.pem" npm run release:hot -- --key-id ad-2026-09-r2 --seq <递增序号>
# 2) 上传到服务器（依赖本机已配好 ssh 免密登录 root@118.31.43.156）
npm run deploy:hot          # 等价 FEED_HOST/FEED_USER/FEED_REMOTE_DIR 可用 env 覆盖；--dry-run 只打印命令
```

客户端（设置 → 更新 → 检查更新）即可收到新版本。客户端入口是 /renderer/manifest.json、/payload/manifest.json、/shell/manifest.json；nginx 的根是 stable，不应再在 URL 中加 /stable。

部署先上传到本次专属暂存目录并逐文件校验 SHA256，所有上传通过后才发布；版本历史及 zip 不可覆盖不同字节，stable 清单最后用原子 rename 切换。--force 只强制重传相同绑定，不允许覆盖历史。--dry-run 仅查询远端清单，不写服务器。FEED_LOCAL_DIR 可选择只含本次发布的独立 feed 根，避免同步陈旧本地历史；FEED_HOST/FEED_USER/FEED_REMOTE_DIR 仍可覆盖目标。

打包只纳入 out/main、out/preload、out/renderer，不含 out 中的 smoke/log/browser 缓存。壳包以 package.json 的版本号绑定不可变历史；已发布 0.23.0 的壳后，新源码必须升版本，不能只递增热更序号。renderer 清单要求至少同版主进程，新增 IPC 不会先暴露给旧主进程；payload 保留原有升级能力底线。

## 三、运维操作

- **服务端回滚（止血）**：`versions/<通道>/<版本>/manifest.json` 覆盖 `stable/<通道>/manifest.json`，再 `nginx -s reload`（或等 no-cache 生效）。版本号单调递增，回滚 = 发一个"更高版本号引用旧产物"。
- **客户端回滚**：设置 → 更新 → 回退上一版（渲染层通道，本地保留 3 版）；壳回滚 = 应用目录旁的 `.old-<ts>` 历史目录（保留 2 个），由更新器 `rollback('shell')` 反向替换。
- **签名密钥**：私钥绝不进仓库（当前在仓库外 `~/.agentdeck/hot-keys/ad-2026-09-r2.pem`，keyId 为 ad-2026-09-r2）；发布前必须确认其导出公钥与 `src/main/hot/trust.ts` 的内置信任锚一致，不用临时 smoke 信任覆盖当成生产验签。正式对外发布前离线重生成，公钥替换 `src/main/hot/trust.ts`，约 12 个月轮换（§9.5）。

## 四、域名到位后的迁移

1. 域名 DNS A 记录 → 118.31.43.156；阿里云申请免费证书（或 Let's Encrypt），nginx 443 + 80 跳转（大陆域名需 ICP 备案）。
2. `src/main/hot/trust.ts` 的 `DEFAULT_FEED_BASE` 改为 `https://<域名>`，随下一个壳版本发出。
3. 存量用户在壳更新前仍走 IP（updateFeedUrl 留空 = 内置值）；更新到新壳后自动切域名。

## 五、分发渠道策略（§9.2）

- **zip 便携版为主渠道**（GA）：`dist/agentdeck-<版本>-portable-win-x64.zip`，解压即用，支持全三层热更。
- **NSIS 保留 4-8 周并行期**作为桥接版：Release Notes 引导存量用户迁移到 zip 渠道（安装版无法壳自替换，人工迁移一次性）；zip 渠道稳定运行 ≥2 个版本且无分发类缺陷后停发 NSIS。
- zip 首次运行的 SmartScreen/MOTW 摩擦：文档引导"右键属性解除锁定"；根治靠代码签名证书（§9.4，不晚于对外分发规模扩大前购入）。

## 六、2026-10-02 正式发布记录

| 通道 | 版本 | 字节数 | ZIP SHA256 |
| --- | --- | --- | --- |
| renderer | 0.23.1-hot.1 | 4724287 | bb40ea40255b09b9db0091f00c0c108fcd8091b5dfa5bbab6eb50a4f2cd2b5a2 |
| payload | 0.23.1-hot.1 | 5971361 | ae09ba722087f1baeefc9e8d3352b5fc8f203d71c3dcc0f6d0733aca5a4c618e |
| shell / portable | 0.23.1 | 329276270 | c1594e38a4bc75bd65a5a3d2d76f21dfb550964f4fce789004b481484812e304 |

三清单签名使用内置信任锚 ad-2026-09-r2 复核；stable 与 versions 共 12 个服务器文件完整 SHA256 相符。三包 HEAD=200、Range=206；renderer/payload 全量 HTTP 下载验哈希，壳包核验服务端完整哈希及公开首段字节，没有重复全量 HTTP 下载。便携包入口为 http://118.31.43.156/shell/shell-0.23.1.zip；Ed25519 清单签名不等同于 Windows Authenticode 签名，本次没有配置后者。

发布细节与验收边界见 docs/plan/team-meeting-issue-v2.md §16；日志和 JSON 证据位于 out/server-release-audit/。用户授权的是主干推送及服务器发包，本次未执行安装程序、直接更新现用安装目录或手工迁移生产数据。

## 七、0.23.2 使用反馈补丁发布

| 通道 | 版本 | 字节数 | ZIP SHA256 |
| --- | --- | --- | --- |
| renderer | 0.23.2-hot.1 | 4725900 | e20b5afb2c0756770ee47e8a57cc6ad1bf4098cbfafbb9764b96843e176b6f1a |
| payload | 0.23.2-hot.1 | 5970118 | 0006d79f620f5564d418ea32c247acb69d34cf1d2ff75da79f4d28d7bd4e1088 |
| shell / portable | 0.23.2 | 329275027 | f14862c9b969ae9b159384a248cb81cf6b3de026cb70e6e5a1ace1cdf9dd664c |

默认内置信任锚 ad-2026-09-r2 验签，当前 13 个服务器文件与 0.23.1 六个不可变历史文件完整 SHA256 均匹配。三包 HEAD=200、Range=206；renderer/payload 全量 HTTP 下载验哈希，壳包复核服务器完整哈希及公开首段字节。便携包入口 http://118.31.43.156/shell/shell-0.23.2.zip；源码与全量/隔离副本门禁、暂存复用与单连接原子发布、连接超时失败留证详见 docs/plan/team-meeting-issue-v2.md §17，证据在 out/feedback-release-audit/。没有直接替换用户现用安装目录或手工迁移生产会议数据。

## 八、0.23.4 发布（ZCode 经验吸收批）

| 通道 | 版本 | 字节数 | ZIP SHA256 |
| --- | --- | --- | --- |
| renderer | 0.23.4-hot.1 | 4738806 | fac515a1642c71f4d65e390596bb37a45435f1debf48a32bd8b38a0b55f8077d |
| payload | 0.23.4-hot.1 | 6000152 | 439cefdc792204c16f42a28b52a73d53223243e92ad4bf9c0bc7c459c20f9980 |
| shell / portable | 0.23.4 | 329304832 | 9b6ed7447fa0a443047592a54d483d30ecdde8b43601dcf09bdc3475d2df5371 |

内容：界面字号设置与相对字阶（--ui-font-size 公式化）、执行记录回合窗口化与超长 worklog 折叠、确认框影响预览与提交中安全门、设计/架构机器检查（check:design / check:architecture，架构基线已还清至零）、发布前独立审查六项修复。三通道 manifest 签名 keyId=ad-2026-09-r2，部署为暂存校验后原子切换；发布后 HTTP 拉取三通道 stable 清单核验版本与哈希一致，壳包 HEAD=200。部署过程中一次 ssh 连接超时（网络瞬断），按幂等协议重试 deploy:hot 成功。便携包入口 http://118.31.43.156/shell/shell-0.23.4.zip。

## 九、0.23.5 发布（启动性能根治批）

| 通道 | 版本 | 字节数 | ZIP SHA256 |
| --- | --- | --- | --- |
| renderer | 0.23.5-hot.1 | 4738806 | 929fab03feec8f1ea70b2d38208d94a052063b339d78f10809714644a44d2fac |
| payload | 0.23.5-hot.1 | 6007524 | d8a2d3a26e924a0d8296b55e1fd94871b8857f17a7c56825b739b0dafc72554a |
| shell / portable | 0.23.5 | 329312204 | 64689c446aad20bec13266b4393790ea87f77dfaeb1c2271845f6034221c4178 |

内容：TaskStore/IssueStore 读路径缓存化（内存权威文档 + 磁盘身份失效，事务私有副本与回执失败回滚）、启动次序框架（窗口先行 + app:ready 就绪屏障，preload invoke 统一排队）。实测（425 任务/69MB 日志）：窗口出现 270ms、get×200 由秒级降 3ms、IssueStore sync 无变化由 200-400ms/次降 1.4ms/次；审码判官复核无阻断/高危。三通道 manifest 签名 keyId=ad-2026-09-r2，部署为暂存校验后原子切换；发布后 HTTP 拉取三通道 stable 清单，Ed25519 验签（信任锚 4eb1c26a…）与 artifact zip 哈希全部复核一致；payload 36 文件含 out/preload（preload 随 payload 与壳同步，无新旧错峰配对）；壳包与便携包 HEAD=200。便携包入口 http://118.31.43.156/shell/shell-0.23.5.zip。

## 十、0.23.6 发布（工作区做实 + Issue 管线做实）

| 通道 | 版本 | 字节数 | ZIP SHA256 |
| --- | --- | --- | --- |
| renderer | 0.23.6-hot.1 | 4751739 | 3205ec41d13ef622e942ce2a78672abf49fec3c6ea56f883920c0d12dd5dc105 |
| payload | 0.23.6-hot.1 | 6024711 | 22943a89fae7e6ff734e0a64dd65325391281f2cd19b7a6cd28b7cc3ea14af84 |
| shell / portable | 0.23.6 | 329329293 | 9e5e9c18245033d23644538ecbbbe71667aa5379579791804a777b019253ec15 |

内容（ZCode 经验吸收第二/三批）：工作区 git 状态卡（新 IPC workspace:gitSummary——分支/领先落后/暂存·未暂存·未跟踪计数/最近提交；派单页与任务详情 Git 视图「当前工作区」段，非仓库灰态）；Issue 人工流转状态机出 UI（shared/taskflow ISSUE_TRANSITIONS 矩阵：主线+终态重开+受阻旁路；updateWorkflow 非法拒绝写盘、settleWorkflow 机器收口通道；详情下拉只列合法项 + 站点灯管线轨道 + 优先级可编辑；看板拖拽/右键只给合法目标列）。三通道 manifest 签名 keyId=ad-2026-09-r2，暂存校验后原子切换；发布后 HTTP 拉取三通道 stable 清单核验版本/哈希一致，壳包 HEAD=200。便携包入口 http://118.31.43.156/shell/shell-0.23.6.zip。

## 十一、0.23.7 发布（工作区与 Issue 体验批）

| 通道 | 版本 | 字节数 | ZIP SHA256 |
| --- | --- | --- | --- |
| renderer | 0.23.7-hot.1 | 4774776 | 73e17d1b88b788a80e7d3fe4a388a6fcf6f134ad7582e79b5bd086baa557ec36 |
| payload | 0.23.7-hot.1 | 6050357 | 3a66eba59e52f045d5f184c739de53b36a4e4104637b6d4761e17eb80cf28e49 |
| shell / portable | 0.23.7 | 329354835 | 766be7f9abadb28d669094f15b40729d64cd94b133af1a6d4adbbc642b09f2b7 |

内容（ZCode 经验吸收第四批）：@ 文件引用输入壳（派单框 + 追问框共用 useFileReferenceMenu，目录下钻/完整相对路径/IME 让路）+ Issue 标签编辑；Issue 详情 meta 两线语义分组翻新（chip 统一基线 + 色彩纪律）；聊天区全幅（终结 936/1120 多代宽度帽）+ 回合索引线窄屏收窄存活（SideDock 打开不再消失）；运行檐「正在做什么」实时活动摘要；执行记录页内搜索（回合级、数据层匹配、Enter/Shift+Enter 循环跳转）；最近工作区剔除机器生成的委派 worktree（存量载入清洗）。三通道 manifest keyId=ad-2026-09-r2，暂存校验后原子切换，发布后 HTTP 核验一致，壳包 HEAD=200。便携包入口 http://118.31.43.156/shell/shell-0.23.7.zip。
