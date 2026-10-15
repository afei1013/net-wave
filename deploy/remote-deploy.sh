#!/usr/bin/env bash
# 一键远程部署：本地推送 GitHub → 服务器 git pull + 重建容器 + 健康检查
# 这是日常更新的推荐方式（替代 pack-upload.sh 打包上传）。
#
# 一次性前提（只需做一次）:
#   1) 本地: ssh-copy-id -i ~/.ssh/id_rsa.pub root@服务器IP        # 免密登录
#   2) 服务器: git clone 本仓库到 /opt/net-wave（私有库需配 Deploy Key，见 DEPLOY.md「Git 部署」）
#
# 用法: bash deploy/remote-deploy.sh [user@服务器IP]
#       （默认 root@110.40.203.45，可用环境变量 REMOTE_DIR 覆盖服务器目录）
set -euo pipefail

TARGET=${1:-root@110.40.203.45}
REMOTE_DIR=${REMOTE_DIR:-/opt/net-wave}
# Git Bash 关闭 MSYS 路径转换（防止 ssh 参数里的 /路径 被误转成 Windows 路径）
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

echo "==> [1/3] 推送最新代码到 GitHub"
git push

echo "==> [2/3] 服务器拉取代码并重建容器（首次较慢，增量构建通常 1-3 分钟）"
ssh "$TARGET" "cd '${REMOTE_DIR}' && git pull --ff-only && docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml up -d --build"

echo "==> [3/3] 健康检查"
sleep 3
ssh "$TARGET" "curl -fsS http://127.0.0.1:3000/api/health && echo ' ✓' && docker ps --filter name=net-wave --format '容器状态: {{.Status}}'"
echo ""
echo "==> 部署完成！"
