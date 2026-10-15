import { openDb } from './db'
import { getHub } from './hub'
import type { MessageRow } from './chat'
import { findRoom } from './rooms'

/**
 * 端到端加密显示（房间消息访问控制 + 服务端替换）：
 * 开启后房间消息按查看者身份分级——房主/管理员授权者看全部明文；
 * 普通成员仅可见加入之后的消息（更早历史由服务端替换为加密占位）；
 * 非成员同样只看到加密占位（200 而非 403，配套预览页与授权申请流程）。
 * 私聊不受影响。开关存 settings（e2e_encryption），默认关闭。
 */

const ENABLED_KEY = 'e2e_encryption'

/** 加密占位文案：服务端统一替换（保留发送者与时间，隐藏正文与文件） */
export const E2E_PLACEHOLDER = '🔒 数据已端到端加密，如需查看请申请该房间历史数据查看权限'

export function isE2eEnabled(): boolean {
  const row = openDb().prepare('SELECT value FROM settings WHERE key = ?').get(ENABLED_KEY) as
    | { value: string }
    | undefined
  if (row) return row.value === 'on'
  return process.env.NW_E2E_ENCRYPTION === 'on'
}

export function setE2eEnabled(enabled: boolean): void {
  openDb()
    .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .run(ENABLED_KEY, enabled ? 'on' : 'off')
}

/**
 * 房间级加密是否实际生效：总开关开启 且 该房间未放开加密。
 * 层级联动：总开关关 → 一切照旧；房间放开加密 → 该房间恢复原有可见性（授权随之失效）。
 */
export function isRoomE2eActive(roomId: number): boolean {
  if (!isE2eEnabled()) return false
  const row = openDb().prepare('SELECT COALESCE(encrypted, 1) AS encrypted FROM rooms WHERE id = ?').get(roomId) as
    | { encrypted: number }
    | undefined
  return row != null && row.encrypted === 1
}

/** 管理员设置房间级加密（仅在总开关开启时允许） */
export function setRoomEncrypted(roomId: number, encrypted: boolean): { ok: true } | { ok: false; reason: 'room-not-found' | 'master-off' } {
  if (!isE2eEnabled()) return { ok: false, reason: 'master-off' }
  const result = openDb().prepare('UPDATE rooms SET encrypted = ? WHERE id = ?').run(encrypted ? 1 : 0, roomId)
  if (result.changes === 0) return { ok: false, reason: 'room-not-found' }
  // 可见性变化影响所有在线节点：广播刷新
  getHub().broadcast('conversations-updated', {})
  getHub().broadcast('rooms-updated', {})
  return { ok: true }
}

/** 全量明文权限：房主本人或被管理员授权的节点 */
export function canViewFullHistory(roomId: number, peerId: string): boolean {
  const db = openDb()
  const room = db.prepare('SELECT created_by FROM rooms WHERE id = ?').get(roomId) as { created_by: string | null } | undefined
  if (room?.created_by === peerId) return true
  return (
    db.prepare('SELECT 1 FROM room_view_grants WHERE room_id = ? AND peer_id = ?').get(roomId, peerId) != null
  )
}

/** 加入时刻：成员隔离历史的分界；非成员为 null */
export function joinedAtOf(roomId: number, peerId: string): number | null {
  const row = openDb()
    .prepare('SELECT joined_at FROM room_members WHERE room_id = ? AND peer_id = ?')
    .get(roomId, peerId) as { joined_at: number } | undefined
  return row?.joined_at ?? null
}

export interface E2eViewMeta {
  /** 本次返回中是否存在被替换的占位消息 */
  masked: boolean
  /** 查看者是否拥有全量明文权限（房主/授权） */
  fullAccess: boolean
}

/**
 * 按查看者身份做服务端替换：返回新数组（无需替换时原样返回）。
 * 前提：E2E 开启且为房间会话；判定均以数据库为准，前端不参与裁决。
 */
export function maskRoomMessagesFor(
  roomId: number,
  peerId: string,
  messages: MessageRow[],
): { messages: MessageRow[]; meta: E2eViewMeta } {
  if (canViewFullHistory(roomId, peerId)) {
    return { messages, meta: { masked: false, fullAccess: true } }
  }
  const joinedAt = joinedAtOf(roomId, peerId)
  let masked = false
  const result = messages.map((m) => {
    if (joinedAt != null && m.createdAt >= joinedAt) return m
    masked = true
    return { ...m, kind: 'text', text: E2E_PLACEHOLDER, fileId: null, file: null } satisfies MessageRow
  })
  return { messages: result, meta: { masked, fullAccess: false } }
}

// ---------- 查看权限申请（复用 room_requests，kind = 'view'） ----------

export type ViewRequestResult =
  | { ok: true; duplicated: boolean }
  | { ok: false; reason: 'room-not-found' | 'already-granted' | 'room-not-encrypted' }

/** 提交历史查看权限申请：房主/已授权者无需申请；同节点同房间 pending 幂等 */
export function submitViewRequest(peerId: string, roomId: number): ViewRequestResult {
  if (!findRoom(roomId)) return { ok: false, reason: 'room-not-found' }
  // 联动约束：仅对「加密生效中」的房间可申请（总开关关/房间放开加密时无意义）
  if (!isRoomE2eActive(roomId)) return { ok: false, reason: 'room-not-encrypted' }
  if (canViewFullHistory(roomId, peerId)) return { ok: false, reason: 'already-granted' }
  const db = openDb()
  const existing = db
    .prepare("SELECT 1 FROM room_requests WHERE kind = 'view' AND peer_id = ? AND room_id = ? AND status = 'pending'")
    .get(peerId, roomId)
  if (existing) return { ok: true, duplicated: true }
  db.prepare("INSERT INTO room_requests (kind, room_id, peer_id, status, created_at) VALUES ('view', ?, ?, 'pending', ?)").run(
    roomId,
    peerId,
    Date.now(),
  )
  return { ok: true, duplicated: false }
}

// ---------- 管理员授权管理 ----------

export interface RoomViewGrant {
  peerId: string
  peerName: string | null
  grantedAt: number
}

export function listViewGrants(roomId: number): RoomViewGrant[] {
  return openDb()
    .prepare(
      `SELECT g.peer_id AS peerId, p.name AS peerName, g.granted_at AS grantedAt
       FROM room_view_grants g LEFT JOIN peers p ON p.id = g.peer_id
       WHERE g.room_id = ? ORDER BY g.granted_at DESC`,
    )
    .all(roomId) as RoomViewGrant[]
}

/** 授予（管理员主动或审批通过）：幂等（重复授权刷新时间）并通知该节点；仅对加密生效中的房间有意义 */
export function grantViewPermission(roomId: number, peerId: string): boolean {
  if (!findRoom(roomId) || !isRoomE2eActive(roomId)) return false
  openDb()
    .prepare('INSERT OR REPLACE INTO room_view_grants (room_id, peer_id, granted_at) VALUES (?, ?, ?)')
    .run(roomId, peerId, Date.now())
  const room = findRoom(roomId)
  if (room) {
    getHub().sendToPeer(peerId, 'room-request-result', { status: 'approved', kind: 'view', roomName: room.name })
    getHub().sendToPeer(peerId, 'conversations-updated', {})
  }
  return true
}

export function revokeViewPermission(roomId: number, peerId: string): boolean {
  const result = openDb()
    .prepare('DELETE FROM room_view_grants WHERE room_id = ? AND peer_id = ?')
    .run(roomId, peerId)
  return result.changes > 0
}
