#!/usr/bin/env bash
# 服务器一次性初始化：Docker + 国内镜像加速 + swap + Nginx + certbot + 防火墙
# 在服务器上以 root 运行：sudo bash deploy/server-init.sh
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "错误: 请以 root 运行: sudo bash deploy/server-init.sh"; exit 1; }

# ---------- [1/6] Docker Engine + Compose 插件 ----------
echo "==> [1/6] 安装 Docker Engine + Compose 插件"
if command -v docker >/dev/null 2>&1; then
  echo "    Docker 已安装: $(docker --version)"
else
  if command -v apt-get >/dev/null 2>&1; then
    . /etc/os-release
    apt-get update
    apt-get install -y ca-certificates curl
    install -m 0755 -d /etc/apt/keyrings
    # 优先阿里云镜像站的 docker-ce 官方仓库（大陆服务器直连官方源易超时）
    curl -fsSL "https://mirrors.aliyun.com/docker-ce/linux/${ID}/gpg" -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://mirrors.aliyun.com/docker-ce/linux/${ID} ${VERSION_CODENAME} stable" \
      > /etc/apt/sources.list.d/docker.list
    apt-get update
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  elif command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then
    PKG_MGR=$(command -v dnf >/dev/null 2>&1 && echo dnf || echo yum)
    ${PKG_MGR} install -y yum-utils
    yum-config-manager --add-repo https://mirrors.aliyun.com/docker-ce/linux/centos/docker-ce.repo
    ${PKG_MGR} install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  else
    echo "错误: 未识别的包管理器，请参照 https://docs.docker.com/engine/install/ 手动安装"; exit 1
  fi
  systemctl enable --now docker
fi
docker compose version >/dev/null 2>&1 || { echo "错误: docker compose 插件未安装"; exit 1; }

# ---------- [2/6] Docker Hub 国内镜像加速 ----------
echo "==> [2/6] 配置 Docker Hub 镜像加速"
mkdir -p /etc/docker
if [ -f /etc/docker/daemon.json ]; then
  cp /etc/docker/daemon.json "/etc/docker/daemon.json.bak.$(date +%s)"
  echo "    已备份原 daemon.json"
fi
# 公共加速源可用性会变化；若你有阿里云控制台的「容器镜像服务-镜像加速器」专属地址，替换进去最稳
cat > /etc/docker/daemon.json <<'EOF'
{
  "registry-mirrors": [
    "https://docker.m.daocloud.io",
    "https://docker.1ms.run",
    "https://dockerproxy.net"
  ]
}
EOF
systemctl restart docker
echo "    验证拉取（失败不影响后续步骤，仅提示需更换加速源）："
docker run --rm hello-world >/dev/null 2>&1 \
  && echo "    镜像拉取正常" \
  || echo "    警告: hello-world 拉取失败，请将 daemon.json 中加速源替换为你的阿里云专属加速地址后: systemctl restart docker"

# ---------- [3/6] 2G swap（Next.js 构建内存兜底，2G 内存小机必需） ----------
echo "==> [3/6] 配置 swap"
if [ -n "$(swapon --show 2>/dev/null)" ]; then
  echo "    已存在 swap，跳过: $(swapon --show | tail -n +2 | awk '{print $1, $3}' | tr '\n' ' ')"
else
  if [ -f /swapfile ]; then
    echo "    存在未启用的 /swapfile，尝试激活"
    swapon /swapfile || { mkswap /swapfile && swapon /swapfile; }
  else
    fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
    swapon /swapfile
  fi
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  # 内存充足时尽量不使用 swap，仅在构建峰值兜底
  sysctl -w vm.swappiness=10 >/dev/null
  grep -q '^vm.swappiness' /etc/sysctl.conf || echo 'vm.swappiness=10' >> /etc/sysctl.conf
  echo "    已启用 2G swap"
fi

# ---------- [4/6] Nginx + certbot ----------
echo "==> [4/6] 安装 Nginx + certbot"
if command -v apt-get >/dev/null 2>&1; then
  apt-get install -y nginx certbot python3-certbot-nginx
elif command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then
  PKG_MGR=$(command -v dnf >/dev/null 2>&1 && echo dnf || echo yum)
  ${PKG_MGR} install -y epel-release 2>/dev/null || true
  ${PKG_MGR} install -y nginx certbot python3-certbot-nginx
fi
systemctl enable --now nginx
# certbot 续期验证用的 webroot 目录
mkdir -p /var/www/certbot

# ---------- [5/6] 系统防火墙放行（云安全组需在控制台单独放行） ----------
echo "==> [5/6] 配置系统防火墙"
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow 22/tcp; ufw allow 80/tcp; ufw allow 443/tcp
  echo "    ufw 已放行 22/80/443"
elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd --permanent --add-service=ssh --add-service=http --add-service=https
  firewall-cmd --reload
  echo "    firewalld 已放行 ssh/http/https"
else
  echo "    未检测到活动的系统防火墙（若用云安全组，请在控制台放行 22/80/443）"
fi

# ---------- [6/6] 完成提示 ----------
echo ""
echo "==> 初始化完成！后续步骤："
echo "    1) 配置环境变量: cp deploy/env.example .env && vim .env"
echo "    2) 启动应用:     docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml up -d --build"
echo "    3) 绑定域名+HTTPS: sudo bash deploy/enable-site.sh 你的域名 你的邮箱"
