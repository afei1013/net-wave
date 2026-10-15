#!/usr/bin/env bash
# 绑定域名 + 签发 HTTPS 证书（服务器上一次性执行）
# 前提：域名 DNS A 记录已指向本机公网 IP，且已完成 ICP 备案
#
# 用法: sudo bash deploy/enable-site.sh 你的域名 [邮箱]
set -euo pipefail

DOMAIN=${1:?用法: sudo bash deploy/enable-site.sh 你的域名 [邮箱]}
EMAIL=${2:-}

[ "$(id -u)" -eq 0 ] || { echo "错误: 请以 root 运行"; exit 1; }
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WEBROOT=/var/www/certbot
mkdir -p "$WEBROOT"

# ---------- 预检：DNS 是否已解析到本机 ----------
echo "==> 预检: ${DOMAIN} 的 DNS 解析"
RESOLVED_IP=$(getent hosts "$DOMAIN" 2>/dev/null | awk '{print $1}' | head -1 || true)
if [ -z "$RESOLVED_IP" ]; then
  echo "    警告: ${DOMAIN} 暂无 DNS 解析记录，证书验证会失败！"
  echo "          请先到域名控制台添加 A 记录指向本机公网 IP，再重新运行本脚本"
  exit 1
fi
echo "    解析到 ${RESOLVED_IP}（若与本机公网 IP 不一致，证书验证同样会失败）"

# ---------- 定位 nginx 站点配置路径 ----------
if [ -d /etc/nginx/sites-available ]; then
  SITE_PATH=/etc/nginx/sites-available/net-wave
  ENABLE_CMD="ln -sf /etc/nginx/sites-available/net-wave /etc/nginx/sites-enabled/net-wave"
else
  SITE_PATH=/etc/nginx/conf.d/net-wave.conf
  ENABLE_CMD="true"
fi

# ---------- [1/4] 部署临时 HTTP 配置（供证书 webroot 验证） ----------
echo "==> [1/4] 部署临时 HTTP 配置"
cat > "$SITE_PATH" <<EOF
# net-wave 临时配置：证书签发中（enable-site.sh 会随后替换为正式配置）
server {
    listen 80;
    server_name ${DOMAIN};
    location ^~ /.well-known/acme-challenge/ {
        root ${WEBROOT};
        default_type text/plain;
    }
    location / {
        default_type text/plain;
        return 200 'net-wave 部署中：HTTPS 证书签发完成后将自动启用正式站点。';
    }
}
EOF
eval "$ENABLE_CMD"
# 分开执行让 set -e 真正生效：&& 组合中前置命令失败不会中止脚本（曾掩盖过配置错误）
nginx -t
systemctl reload nginx

# ---------- [2/4] 签发 Let's Encrypt 证书（webroot 方式，可自动续期） ----------
echo "==> [2/4] 签发证书"
CERTBOT_ARGS=(certonly --webroot -w "$WEBROOT" -d "$DOMAIN" --non-interactive --agree-tos)
if [ -n "$EMAIL" ]; then
  CERTBOT_ARGS+=(-m "$EMAIL")
else
  CERTBOT_ARGS+=(--register-unsafely-without-email)
fi
certbot "${CERTBOT_ARGS[@]}"

# ---------- [3/4] 部署正式配置（HTTP→HTTPS + WebSocket 反代） ----------
echo "==> [3/4] 部署正式 Nginx 配置"
sed "s/net-wave\.example\.com/${DOMAIN}/g" "$ROOT/deploy/nginx-net-wave.conf" > "$SITE_PATH"
eval "$ENABLE_CMD"
nginx -t
systemctl reload nginx

# ---------- [4/4] 续期后自动重载 nginx ----------
echo "==> [4/4] 配置续期钩子"
mkdir -p /etc/letsencrypt/renewal-hooks/deploy
cat > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh <<'EOF'
#!/usr/bin/env bash
nginx -s reload
EOF
chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh

echo ""
echo "==> 完成！访问 https://${DOMAIN} 验证"
echo "    证书由 certbot.timer 每 90 天自动续期，可演练: certbot renew --dry-run"
