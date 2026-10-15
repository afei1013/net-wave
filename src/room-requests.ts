import { openDb } from './db'
import { findPeer } from './peers'
import { getHub } from './hub'
import { broadcastRoomOnline, createRoom, findRoom, joinRoom } from './rooms'
import { grantViewPermission } from './e2e'

/**
 * 房间审批：开启后「创建房间」需管理员在 /admin 审批（加入房间始终自由）。
 * 开关持久在 settings 表（room_approval = on/off）；未设置时以环境变量
 * NW_ROOM_APPROVAL 为初始值（缺省 on），管理员后台可随时切换。
 */

const APPROVAL_KEY = 'room_approval'

export function isRoomApprovalEnabled(): boolean {
  const row = openDb().prepare('SELECT value FROM settings WHERE key = ?').get(APPROVAL_KEY) as
    | { value: string }
    | undefined
  if (row) return row.value !== 'off'
  return (process.env.NW_ROOM_APPROVAL ?? 'on') !== 'off'
}

export function setRoomApprovalEnabled(enabled: boolean): void {
  openDb()
    .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .run(APPROVAL_KEY, enabled ? 'on' : 'off')
}

/** 用户视角的申请信息（侧栏「审批中」标记） */
export interface RoomRequestInfo {
  id: number
  kind: 'create' | 'join' | 'view'
  roomId: number | null
  roomName: string | null
  createdAt: number
}

/** 管理端列表项：附带申请人身份（申请人可能已不存在，昵称可空） */
export type AdminRoomRequestInfo = RoomRequestInfo & { peerId: string; peerName: string | null }

interface RequestRow extends RoomRequestInfo {
  peerId: string
  status: string
  handledAt: number | null
}

const toInfo = (row: RequestRow): RoomRequestInfo => ({
  id: row.id,
  kind: row.kind,
  roomId: row.roomId,
  roomName: row.roomName,
  createdAt: row.createdAt,
})

export type CreateRequestResult =
  | { ok: true; request: RoomRequestInfo; duplicated: boolean }
  | { ok: false; reason: 'invalid-name' | 'unknown-peer' }

/** 提交建房申请：同一节点同名 pending 幂等返回（duplicated），不重复入队 */
export function submitCreateRoomRequest(peerId: string, name: string): CreateRequestResult {
  const trimmed = name.trim()
  if (trimmed.length < 1 || trimmed.length > 50) return { ok: false, reason: 'invalid-name' }
  if (!findPeer(peerId)) return { ok: false, reason: 'unknown-peer' }
  const db = openDb()
  const existing = db
    .prepare(
      "SELECT id, kind, room_id AS roomId, room_name AS roomName, peer_id AS peerId, status, created_at AS createdAt, handled_at AS handledAt FROM room_requests WHERE kind = 'create' AND peer_id = ? AND room_name = ? AND status = 'pending'",
    )
    .get(peerId, trimmed) as RequestRow | undefined
  if (existing) return { ok: true, request: toInfo(existing), duplicated: true }
  const now = Date.now()
  const result = db
    .prepare("INSERT INTO room_requests (kind, room_id, room_name, peer_id, status, created_at) VALUES ('create', NULL, ?, ?, 'pending', ?)")
    .run(trimmed, peerId, now)
  return { ok: true, request: { id: Number(result.lastInsertRowid), kind: 'create', roomId: null, roomName: trimmed, createdAt: now }, duplicated: false }
}

/** 管理端待审列表：join 类的房间名从 rooms 表带出，按申请时间正序 */
export function listPendingRoomRequestsForAdmin(): AdminRoomRequestInfo[] {
  const db = openDb()
  return db
    .prepare(
      `SELECT rr.id, rr.kind, rr.room_id AS roomId, COALESCE(rr.room_name, r.name) AS roomName,
              rr.peer_id AS peerId, p.name AS peerName, rr.created_at AS createdAt
       FROM room_requests rr
       LEFT JOIN peers p ON p.id = rr.peer_id
       LEFT JOIN rooms r ON r.id = rr.room_id
       WHERE rr.status = 'pending'
       ORDER BY rr.created_at ASC, rr.id ASC`,
    )
    .all() as AdminRoomRequestInfo[]
}

/** 用户本人的待审建房与历史查看申请（侧栏「审批中」行、预览页申请按钮状态） */
export function listMyPendingRequests(peerId: string): RoomRequestInfo[] {
  const db = openDb()
  return db
    .prepare(
      `SELECT rr.id, rr.kind, rr.room_id AS roomId, COALESCE(rr.room_name, r.name) AS roomName, rr.created_at AS createdAt
       FROM room_requests rr
       LEFT JOIN rooms r ON r.id = rr.room_id
       WHERE rr.status = 'pending' AND rr.peer_id = ? AND rr.kind IN ('create', 'view')
       ORDER BY rr.created_at ASC, rr.id ASC`,
    )
    .all(peerId) as RoomRequestInfo[]
}

export type HandleResult =
  | { ok: true; approved: boolean; kind: 'create' | 'join' | 'view'; roomName: string | null; peerId: string }
  | { ok: false; reason: 'not-found' | 'already-handled' | 'room-gone' | 'invalid-name' }

/**
 * 处理待审申请：批准建房即真正创建房间（申请人自动成为成员）。
 * join 分支仅用于处理历史遗留的加入申请（加入现已自由），批准即入成员。
 * view 分支为房间历史查看权限申请（端到端加密显示），批准即写入授权并通知。
 * 处理结果经 WS 推给申请人（room-request-result），批准时附带列表刷新广播。
 * 拒绝后申请人可重新提交（历史记录保留在库中）。
 */
export function handleRoomRequest(requestId: number, approve: boolean): HandleResult {
  const db = openDb()
  const row = db
    .prepare(
      'SELECT id, kind, room_id AS roomId, room_name AS roomName, peer_id AS peerId, status, created_at AS createdAt, handled_at AS handledAt FROM room_requests WHERE id = ?',
    )
    .get(requestId) as RequestRow | undefined
  if (!row) return { ok: false, reason: 'not-found' }
  if (row.status !== 'pending') return { ok: false, reason: 'already-handled' }

  const markHandled = (status: 'approved' | 'rejected') => {
    db.prepare('UPDATE room_requests SET status = ?, handled_at = ? WHERE id = ?').run(status, Date.now(), requestId)
  }

  if (approve && row.kind === 'create') {
    const room = createRoom(row.peerId, row.roomName ?? '')
    if (!room) return { ok: false, reason: 'invalid-name' }
    markHandled('approved')
    notifyApproved(row.peerId, 'create', room.name)
    return { ok: true, approved: true, kind: 'create', roomName: room.name, peerId: row.peerId }
  }
  if (approve && row.kind === 'join') {
    const room = joinRoom(row.peerId, row.roomId ?? 0)
    // 目标房间可能已被删除：自动关闭该申请，管理员侧提示
    if (!room) {
      markHandled('rejected')
      return { ok: false, reason: 'room-gone' }
    }
    markHandled('approved')
    notifyApproved(row.peerId, 'join', room.name)
    return { ok: true, approved: true, kind: 'join', roomName: room.name, peerId: row.peerId }
  }
  if (approve && row.kind === 'view') {
    const room = findRoom(row.roomId ?? 0)
    if (!room) {
      markHandled('rejected')
      return { ok: false, reason: 'room-gone' }
    }
    markHandled('approved')
    // 授权即完成可见性变更；grantViewPermission 内部会通知该节点并推送会话刷新
    grantViewPermission(room.id, row.peerId)
    return { ok: true, approved: true, kind: 'view', roomName: room.name, peerId: row.peerId }
  }

  const roomName = row.kind === 'create' ? row.roomName : (findRoom(row.roomId ?? 0)?.name ?? null)
  markHandled('rejected')
  getHub().sendToPeer(row.peerId, 'room-request-result', { status: 'rejected', kind: row.kind, roomName })
  return { ok: true, approved: false, kind: row.kind, roomName, peerId: row.peerId }
}

/** 批准后的通知：结果 + 申请人会话刷新 + 全员房间列表/在线数刷新（与直接建房/加入的广播口径一致） */
function notifyApproved(peerId: string, kind: 'create' | 'join', roomName: string): void {
  const hub = getHub()
  hub.sendToPeer(peerId, 'room-request-result', { status: 'approved', kind, roomName })
  hub.sendToPeer(peerId, 'conversations-updated', {})
  hub.broadcast('rooms-updated', {})
  broadcastRoomOnline()
}
