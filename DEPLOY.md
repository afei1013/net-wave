# net-wave 云服务器部署手册（Linux + Docker + Nginx + HTTPS）

本手册描述将 net-wave 部署到一台 **中国大陆 Linux 云服务器**（≥2核2G，可 SSH 登录）并绑定域名启用 HTTPS 的完整流程。所有命令均可直接复制执行。

## 架构总览

```
浏览器 ──HTTPS(443)──> Nginx 反向代理 ──> 127.0.0.1:3000 ──> net-wave 容器(Docker)
                       (域名/证书/WS升级)                    └── 数据卷 net-wave-data
                                                           (SQLite + 上传文件，容器重建不丢失)
```

- 复用仓库自带的 [Dockerfile](Dockerfile) 三阶段构建，服务器上直接构建镜像
- 容器只绑定 `127.0.0.1`（通过 `.env` 中 `NW_BIND`），公网仅暴露 80/443
- Nginx 负责 WebSocket（`/ws`）升级转发与真实 IP 透传（应用已支持 `X-Forwarded-For`）
- 证书使用 Let's Encrypt 免费证书，certbot 自动续期

`deploy/` 目录文件说明：

| 文件 | 在哪运行 | 用途 |
|---|---|---|
| `pack-upload.sh` | 本地（Git Bash） | 打包源码并上传服务器 |
| `server-init.sh` | 服务器（root） | 一次性初始化：Docker、镜像加速、swap、Nginx、certbot、防火墙 |
| `enable-site.sh` | 服务器（root） | 绑定域名并签发 HTTPS 证书 |
| `backup.sh` | 服务器 | 停机一致性备份数据卷 |
| `env.example` | 服务器 | `.env` 配置模板 |
| `docker-compose.prod.yml` | 服务器 | 生产构建覆盖（npm 国内源） |
| `nginx-net-wave.conf` | 服务器 | Nginx 站点配置模板（enable-site.sh 自动安装） |

---

## 〇、前置准备（云控制台操作）

1. **ICP 备案**：大陆服务器的 80/443 端口绑定域名访问，要求域名已完成 ICP 备案。
   - 已备案 → 直接继续；
   - 未备案 → 到云厂商控制台提交备案（通常 1~3 周）。期间可用「附录 A」的临时方案先通过 `IP:端口` 访问。
2. **安全组**：放行入方向 TCP `22`（SSH）、`80`、`443`。**不要放行 3000**。
3. **DNS 解析**：到域名控制台添加 A 记录，主机记录按需（如 `@` 或 `www`），记录值为服务器公网 IP。

---

## 一、本地打包上传（Git Bash / macOS / Linux）

```bash
cd /c/Users/admin/Desktop/net-wave-main      # 进入项目根目录（按实际路径调整）
bash deploy/pack-upload.sh ubuntu@你的服务器IP       # 默认部署到 /opt/net-wave
# 自定义目录：bash deploy/pack-upload.sh ubuntu@你的服务器IP /srv/net-wave
```

> - **登录用户名**：Ubuntu 系统一般为 `ubuntu`，CentOS / Alibaba Cloud Linux 一般为 `root`
> - 非 root 用户对 `/opt` 无权限时，脚本会自动用 `sudo` 创建目录并授权
> - 脚本已内置 Git Bash 路径转换兼容，scp 不会落错位置
> - 首次连接会询问是否信任主机指纹（输 `yes`），并要求输入服务器密码。建议配置 SSH 密钥免密登录

## 二、服务器初始化（一次性，约 5 分钟）

```bash
ssh ubuntu@你的服务器IP
cd /opt/net-wave
sudo bash deploy/server-init.sh
```

脚本自动完成：

1. 安装 Docker Engine + compose 插件（走阿里云镜像仓库源）
2. 配置 Docker Hub 国内镜像加速（`/etc/docker/daemon.json`）
3. 创建 2G swap（Next.js 构建内存兜底，2G 小机必需）
4. 安装 Nginx + certbot，并放行系统防火墙 22/80/443

## 三、启动应用

```bash
cd /opt/net-wave
cp deploy/env.example .env
vim .env            # 建议设置 ADMIN_PASSWORD（不设则首启随机生成，只打印一次）
```

构建并启动（首次约 5~10 分钟，需编译 better-sqlite3 原生模块 + 构建 Next.js）：

```bash
docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml up -d --build
```

验证：

```bash
docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml ps   # STATUS 应为 Up (healthy)
curl http://127.0.0.1:3000/api/health                                       # 应返回 {"status":"ok"}
```

> 未设置 `ADMIN_PASSWORD` 时，查看初始密码：`docker compose logs net-wave | grep 密码`

## 四、绑定域名 + HTTPS

前提：DNS 已解析、备案已通过（见「〇、前置准备」）。

```bash
sudo bash deploy/enable-site.sh 你的域名 你的邮箱
# 例：sudo bash deploy/enable-site.sh wave.example.com admin@example.com
```

脚本自动完成：预检 DNS → 部署临时 HTTP 配置 → certbot 签发证书（webroot 方式，可自动续期）→ 替换为正式 Nginx 配置（HTTP 跳转 HTTPS + WebSocket 反代）→ 配置续期钩子。

完成后 `https://你的域名` 即可访问。证书每 90 天由 `certbot.timer` 自动续期，可随时演练：`sudo certbot renew --dry-run`。

## 五、验收清单

- [ ] `https://你的域名` 打开首页，HTTP 自动跳转 HTTPS
- [ ] 浏览器控制台无 WebSocket 报错（`wss://你的域名/ws` 连接正常；若失败检查 Nginx 配置是否含 Upgrade 头）
- [ ] 注册/登录管理中心（`/admin`），密码正确
- [ ] 发送文本消息、上传/下载文件正常（上传大文件报 413 → 调大 Nginx `client_max_body_size`）
- [ ] 管理中心「节点列表」能看到客户端真实公网 IP（验证 X-Forwarded-For 透传）
- [ ] `docker compose ps` 显示 `Up (healthy)`

---

## 六、日常运维

以下命令均在服务器项目目录（`/opt/net-wave`）执行。为方便先设置别名：

```bash
echo "alias nw='docker compose -f /opt/net-wave/docker-compose.yml -f /opt/net-wave/deploy/docker-compose.prod.yml'" >> ~/.bashrc && source ~/.bashrc
```

之后可用 `nw ps`、`nw logs -f`、`nw restart` 等简写。

### 升级发版

本地改完代码后：

```bash
# 本地
bash deploy/pack-upload.sh root@你的服务器IP
# 服务器
cd /opt/net-wave && nw up -d --build     # 数据在数据卷中，不受影响
```

### 回滚

旧镜像在升级后仍保留。查看历史镜像层：

```bash
docker images              # 找到 <none> 标签的旧构建
docker inspect net-wave:local --format '{{.Created}}'
```

回滚做法：`git`/源码回退后重新 `nw up -d --build`（数据不受影响）。极端情况恢复备份数据见下。

### 备份与恢复

```bash
bash deploy/backup.sh              # 停容器打包数据卷 → 自动重启，输出到 ./backups/
```

恢复方法已随备份输出打印。建议 crontab 定时备份并异地保存：

```bash
crontab -e
# 每天 4:00 备份，保留最近 14 份
0 4 * * * cd /opt/net-wave && bash deploy/backup.sh >> /var/log/net-wave-backup.log 2>&1 && ls -t backups/*.tar.gz | tail -n +15 | xargs -r rm
```

### 常用命令

```bash
nw logs -f --tail=100     # 跟踪日志
nw restart                # 重启
nw down                   # 停止并移除容器（数据卷保留）
docker exec -it net-wave sh    # 进入容器排查
free -h && docker stats --no-stream    # 查看内存/资源占用
```

---

## 七、常见问题排查

| 现象 | 排查 |
|---|---|
| 构建时 `pnpm install` 超时 | 确认使用 `deploy/docker-compose.prod.yml` 覆盖文件（npmmirror 源）；Dockerfile 中 `ARG npm_config_registry` 默认已是国内源 |
| 拉取基础镜像 `node:24-alpine` 失败 | 更换 `/etc/docker/daemon.json` 加速源（建议用阿里云控制台「容器镜像服务→镜像加速器」专属地址），然后 `systemctl restart docker` |
| 构建中途被杀（exit 137） | 内存不足。确认 swap 已启用（`free -h`）；仍失败则本地构建镜像后 `docker save/load` 上传 |
| 网页打不开、502 | `curl 127.0.0.1:3000/api/health` 不通 → 查容器 `nw logs`；通 → 查 Nginx：`nginx -t`、`systemctl status nginx` |
| WebSocket 连不上 | 确认站点配置含 `proxy_set_header Upgrade/Connection`（`/etc/nginx/sites-available/net-wave`），改后 `nginx -t && systemctl reload nginx` |
| 上传大文件 413 | 调大 `nginx-net-wave.conf` 中 `client_max_body_size` 后重载 |
| 证书续期失败 | `sudo certbot renew --dry-run` 查看报错；确认 80 端口可访问且 DNS 未变更 |
| 忘记管理员密码 | `.env` 设置 `ADMIN_PASSWORD` 后 `nw up -d`（环境变量优先，每次启动重置） |

---

## 附录 A：备案期间临时通过 IP 访问

备案通过前，域名走 80/443 会被云厂商拦截，可临时用「IP + 高位端口」直接访问（跳过 Nginx）：

```bash
# .env 中临时改为：
#   NW_BIND=0.0.0.0
#   PORT=8080
nw up -d
# 并在云安全组放行 8080（用完记得关闭）
```

访问 `http://服务器IP:8080`。**备案通过后务必改回 `NW_BIND=127.0.0.1`** 并关闭安全组 8080。

## 附录 B：整体流程速查

```
本地: pack-upload.sh ──> 服务器: server-init.sh ──> 配置 .env ──> compose up -d --build
      ──> enable-site.sh 域名 邮箱 ──> 验收清单 ──> 上线 ✅
```
