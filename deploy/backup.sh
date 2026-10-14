#!/usr/bin/env bash
# net-wave 数据备份（服务器上、项目根目录执行）
# SQLite 处于 WAL 模式，为保证备份一致性：停容器 → 打包数据卷 → 重启容器
#
# 用法: bash deploy/backup.sh [备份输出目录，默认 ./backups]
set -euo pipefail

BACKUP_DIR=${1:-./backups}
STAMP=$(date +%Y%m%d-%H%M%S)
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
COMPOSE_FILES=(-f docker-compose.yml -f deploy/docker-compose.prod.yml)
mkdir -p "$BACKUP_DIR"
BACKUP_DIR_ABS=$(cd "$BACKUP_DIR" && pwd)
OUT_NAME="net-wave-data-${STAMP}.tar.gz"

# 数据卷实际名称带 compose 项目前缀（取决于项目目录名），动态解析
VOLUME=$(docker volume ls --format '{{.Name}}' | grep -E '(^|_)net-wave-data$' | head -1)
[ -n "$VOLUME" ] || { echo "错误: 未找到 net-wave-data 数据卷，请确认应用已启动"; exit 1; }

echo "==> 停止容器（保证 SQLite 一致性）"
docker compose "${COMPOSE_FILES[@]}" stop net-wave

echo "==> 打包数据卷 ${VOLUME}"
docker run --rm \
  -v "${VOLUME}:/data:ro" \
  -v "${BACKUP_DIR_ABS}:/backup" \
  alpine tar -czf "/backup/${OUT_NAME}" -C /data .

echo "==> 重启容器"
docker compose "${COMPOSE_FILES[@]}" start net-wave

echo ""
echo "==> 备份完成: ${BACKUP_DIR}/${OUT_NAME} ($(du -h "${BACKUP_DIR}/${OUT_NAME}" | cut -f1))"
echo ""
echo "    恢复方法（会覆盖现有数据，谨慎操作）："
echo "    1. docker compose ${COMPOSE_FILES[*]} down"
echo "    2. docker volume rm ${VOLUME} && docker volume create ${VOLUME}"
echo "    3. docker run --rm -v ${VOLUME}:/data -v ${BACKUP_DIR_ABS}:/backup alpine tar -xzf /backup/${OUT_NAME} -C /data"
echo "    4. docker compose ${COMPOSE_FILES[*]} up -d"
echo ""
echo "    建议将备份文件定期下载到本地或上传对象存储：scp user@服务器:${BACKUP_DIR}/${OUT_NAME} ."
