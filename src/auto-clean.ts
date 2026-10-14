import { readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { openDb } from './db'
import { getHub } from './hub'
import { broadcastRoomOnline } from './rooms'

/**
 * 定时全量清理：每隔 N 天清空全部聊天数据与房间（消息、会话、房间及成员、
 * 待审申请、上传文件含磁盘占用）。保留节点身份与管理配置。
 * 开关与天数由管理后台配置（settings 表持久化），默认关闭、7 天。
 */

const ENABLED_KEY = 'auto_clean_enabled'
const DAYS_KEY = 'auto_clean_days'
const LAST_RUN_KEY = 'auto_clean_last_run'

export const AUTO_CLEAN_DAYS_MIN = 1
export const AUTO_CLEAN_DAYS_MAX = 3650

export interface AutoCleanConfig {
  enabled: boolean
  days: number
  lastRun: number | null
}

export function getAutoCleanConfig(): AutoCleanConfig {
  const db = openDb()
  const read = (key: string) =>
    (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value
  const days = Number(read(DAYS_KEY))
  return {
    enabled: read(ENABLED_KEY) === 'on',
    days: Number.isInteger(days) && days >= AUTO_CLEAN_DAYS_MIN && days <= AUTO_CLEAN_DAYS_MAX ? days : 7,
    lastRun: (() => {
      const raw = read(LAST_RUN_KEY)
      const n = Number(raw)
      return Number.isFinite(n) && n > 0 ? n : null
    })(),
  }
}

export type AutoCleanUpdateResult =
  | { ok: true; config: AutoCleanConfig }
  | { ok: false; reason: 'invalid-days' }

/** 更新配置（部分字段）：days 需为 1-3650 的整数 */
export function setAutoCleanConfig(update: { enabled?: boolean; days?: unknown }): AutoCleanUpdateResult {
  if (update.days !== undefined) {
    const days = Number(update.days)
    if (!Number.isInteger(days) || days < AUTO_CLEAN_DAYS_MIN || days > AUTO_CLEAN_DAYS_MAX) {
      return { ok: false, reason: 'invalid-days' }
    }
    openDb().prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(DAYS_KEY, String(days))
  }
  if (update.enabled !== undefined) {
    openDb().prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(ENABLED_KEY, update.enabled ? 'on' : 'off')
  }
  return { ok: true, config: getAutoCleanConfig() }
}

export interface CleanupStats {
  messages: number
  rooms: number
  files: number
}

/**
 * 全量清理：事务清空聊天侧全部表，并释放上传文件的磁盘占用（幂等；
 * 正在被下载的文件删除失败时留待下轮清理）。完成后广播在线客户端刷新列表。
 */
export function performCleanup(): CleanupStats {
  const db = openDb()
  const stats: CleanupStats = { messages: 0, rooms: 0, files: 0 }
  db.transaction(() => {
    stats.messages = (db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n
    stats.rooms = (db.prepare('SELECT COUNT(*) AS n FROM rooms').get() as { n: number }).n
    stats.files = (db.prepare('SELECT COUNT(*) AS n FROM files WHERE deleted_at IS NULL').get() as { n: number }).n
    db.prepare('DELETE FROM messages').run()
    db.prepare('DELETE FROM conversations').run()
    db.prepare('DELETE FROM room_members').run()
    db.prepare('DELETE FROM room_requests').run()
    db.prepare('DELETE FROM hidden_conversations').run()
    db.prepare('DELETE FROM rooms').run()
    db.prepare('DELETE FROM files').run()
  })()

  // 磁盘文件逐个删除：目录不存在视为幂等成功；单个文件被占用（下载中）不阻断整体
  const filesRoot = join(process.env.DATA_DIR ?? './data', 'files')
  try {
    for (const name of readdirSync(filesRoot)) {
      try {
        unlinkSync(join(filesRoot, name))
      } catch {
        // Windows 下载中的文件占用句柄：留待下轮清理
      }
    }
  } catch {
    // files 目录不存在：无磁盘占用需释放
  }

  const hub = getHub()
  hub.broadcast('conversations-updated', {})
  hub.broadcast('rooms-updated', {})
  broadcastRoomOnline()
  return stats
}

/** 定时调度入口：开启且距上次执行已满 days 天时执行清理（server.ts 每小时调用） */
export function runAutoCleanIfDue(now = Date.now()): CleanupStats | null {
  const config = getAutoCleanConfig()
  if (!config.enabled) return null
  if (config.lastRun != null && now - config.lastRun < config.days * 86_400_000) return null
  const stats = performCleanup()
  openDb().prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(LAST_RUN_KEY, String(now))
  return stats
}

/** 管理后台「立即清理」：无视间隔立即执行，并刷新 lastRun（下次定时从现在起算） */
export function runCleanupNow(): CleanupStats {
  const stats = performCleanup()
  openDb().prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(LAST_RUN_KEY, String(Date.now()))
  return stats
}
