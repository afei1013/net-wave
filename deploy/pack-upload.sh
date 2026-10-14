#!/usr/bin/env bash
# 本地打包上传：net-wave 源码 → 云服务器（Windows Git Bash / Linux / macOS 均可运行）
#
# 用法:
#   bash deploy/pack-upload.sh ubuntu@1.2.3.4           # 上传到默认目录 /opt/net-wave
#   bash deploy/pack-upload.sh root@1.2.3.4             # 同上
#   bash deploy/pack-upload.sh ubuntu@1.2.3.4 /srv/app  # 自定义服务器目录
#
# 说明: 非 root 用户（如 ubuntu）对 /opt 无权限时，脚本自动用 sudo 创建目录并授权
set -euo pipefail

TARGET=${1:?用法: bash deploy/pack-upload.sh 用户名@服务器IP [服务器目录]}
REMOTE_DIR=${2:-/opt/net-wave}

# Git Bash(MSYS) 会把 "主机:/路径" 参数里的 /路径 误转换成 Windows 路径，
# 导致 scp 在服务器上落到错误位置；此变量关闭该转换（Linux/macOS 上无副作用）
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
STAMP=$(date +%Y%m%d-%H%M%S)
# 打包产物放入独立暂存目录：打包前创建、随包排除、退出时自动清理。
# 不能直接放项目根目录——tar 会因「归档目录在读取期间被修改」报错退出
STAGE_DIR=.net-wave-upload
TARBALL="${STAGE_DIR}/net-wave-${STAMP}.tar.gz"
trap 'rm -rf "$STAGE_DIR"' EXIT
mkdir -p "$STAGE_DIR"

echo "==> [1/4] 打包源码 ${ROOT}"
echo "    （排除 node_modules / .next / .git / data / .env / backups）"
tar -czf "$TARBALL" \
  --exclude='node_modules' \
  --exclude='.next' \
  --exclude='.git' \
  --exclude='data' \
  --exclude='.env' \
  --exclude='backups' \
  --exclude='*.log' \
  --exclude="$STAGE_DIR" \
  --exclude='net-wave-*.tar.gz' \
  .
echo "    产物: ${TARBALL} ($(du -h "$TARBALL" | cut -f1))"

echo "==> [2/4] 准备服务器目录 ${REMOTE_DIR}"
if ssh "$TARGET" "mkdir -p '${REMOTE_DIR}' 2>/dev/null && [ -w '${REMOTE_DIR}' ]"; then
  echo "    目录就绪"
else
  echo "    当前登录用户无权限，改用 sudo 创建并授权..."
  ssh -t "$TARGET" "sudo mkdir -p '${REMOTE_DIR}' && sudo chown \$(whoami) '${REMOTE_DIR}'"
fi

echo "==> [3/4] 上传并解压（经服务器家目录中转）"
# 上传到家目录下的相对路径（不触发路径转换），再由远端解压到目标目录
scp "$TARBALL" "$TARGET:net-wave-upload.tar.gz"
ssh "$TARGET" "[ -f ~/net-wave-upload.tar.gz ] || { echo '错误: 上传后服务器端找不到文件'; exit 1; }"
ssh "$TARGET" "tar -xzf ~/net-wave-upload.tar.gz -C '${REMOTE_DIR}' && rm ~/net-wave-upload.tar.gz"

echo "==> [4/4] 校验"
ssh "$TARGET" "[ -f '${REMOTE_DIR}/docker-compose.yml' ] || { echo '错误: ${REMOTE_DIR} 下缺少 docker-compose.yml'; exit 1; }"
ssh "$TARGET" "echo '    服务器端已就位文件（前 20 项）:' && ls '${REMOTE_DIR}' | head -20"

echo ""
echo "==> 上传完成！接下来登录服务器："
echo "    ssh ${TARGET}"
echo "    cd ${REMOTE_DIR}"
echo "    sudo bash deploy/server-init.sh"
echo "    cp deploy/env.example .env && vim .env"
echo "    docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml up -d --build"
