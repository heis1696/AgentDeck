# 热更 feed 部署指南（阿里云 118.31.43.156）
> ✅ 校验于 `6b2f038` / v0.22.0-hot.19（2026-09-19 文档审计）——`release:hot` / `deploy:hot` 脚本与 `DEFAULT_FEED_BASE`（`src/main/hot/trust.ts`）均与本文一致，为热更现行运维手册。


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
    root /var/www/agentdeck-feed;
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
HOT_SIGNING_KEY_PATH="C:\Users\16961\.agentdeck\hot-keys\ad-2026-09.pem" npm run release:hot -- --seq <递增序号>
# 2) 上传到服务器（依赖本机已配好 ssh 免密登录 root@118.31.43.156）
npm run deploy:hot          # 等价 FEED_HOST/FEED_USER/FEED_REMOTE_DIR 可用 env 覆盖；--dry-run 只打印命令
```

客户端（设置 → 更新 → 检查更新）即可收到新版本。

## 三、运维操作

- **服务端回滚（止血）**：`versions/<通道>/<版本>/manifest.json` 覆盖 `stable/<通道>/manifest.json`，再 `nginx -s reload`（或等 no-cache 生效）。版本号单调递增，回滚 = 发一个"更高版本号引用旧产物"。
- **客户端回滚**：设置 → 更新 → 回退上一版（渲染层通道，本地保留 3 版）；壳回滚 = 应用目录旁的 `.old-<ts>` 历史目录（保留 2 个），由更新器 `rollback('shell')` 反向替换。
- **签名密钥**：私钥绝不进仓库（当前在仓库外 `~/.agentdeck/hot-keys/ad-2026-09.pem`，开发密钥）；正式对外发布前离线重生成，公钥替换 `src/main/hot/trust.ts`（keyId 历法 `ad-YYYY-MM`），约 12 个月轮换（§9.5）。

## 四、域名到位后的迁移

1. 域名 DNS A 记录 → 118.31.43.156；阿里云申请免费证书（或 Let's Encrypt），nginx 443 + 80 跳转（大陆域名需 ICP 备案）。
2. `src/main/hot/trust.ts` 的 `DEFAULT_FEED_BASE` 改为 `https://<域名>`，随下一个壳版本发出。
3. 存量用户在壳更新前仍走 IP（updateFeedUrl 留空 = 内置值）；更新到新壳后自动切域名。

## 五、分发渠道策略（§9.2）

- **zip 便携版为主渠道**（GA）：`dist/agentdeck-<版本>-portable-win-x64.zip`，解压即用，支持全三层热更。
- **NSIS 保留 4-8 周并行期**作为桥接版：Release Notes 引导存量用户迁移到 zip 渠道（安装版无法壳自替换，人工迁移一次性）；zip 渠道稳定运行 ≥2 个版本且无分发类缺陷后停发 NSIS。
- zip 首次运行的 SmartScreen/MOTW 摩擦：文档引导"右键属性解除锁定"；根治靠代码签名证书（§9.4，不晚于对外分发规模扩大前购入）。
