import { NextResponse } from 'next/server'
import { getHub } from '@/hub'
import { requirePeerId } from '@/api-auth'
import { broadcastRoomOnline, joinRoom } from '@/rooms'
import { isRoomApprovalEnabled, submitJoinRoomRequest } from '@/room-requests'

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const peerId = await requirePeerId()
  if (!peerId) {
    return NextResponse.json({ error: '未识别的节点身份' }, { status: 401 })
  }

  const { id } = await params
  const roomId = Number(id)

  if (isRoomApprovalEnabled()) {
    if (!Number.isInteger(roomId)) return NextResponse.json({ error: '房间不存在' }, { status: 404 })
    const result = submitJoinRoomRequest(peerId, roomId)
    if (!result.ok) {
      return NextResponse.json({ error: '房间不存在' }, { status: 404 })
    }
    // 已是成员：与自由模式一致的幂等直入
    if (result.member) {
      notifyJoined(peerId)
      return NextResponse.json(result.room)
    }
    return NextResponse.json({ pending: true, request: result.request }, { status: 202 })
  }

  const room = Number.isInteger(roomId) ? joinRoom(peerId, roomId) : null
  if (!room) {
    return NextResponse.json({ error: '房间不存在' }, { status: 404 })
  }
  notifyJoined(peerId)
  return NextResponse.json(room)
}

/** 加入者本地会话列表更新；全员刷新公开房间列表的人数与各房间在线成员数 */
function notifyJoined(peerId: string) {
  getHub().sendToPeer(peerId, 'conversations-updated', {})
  getHub().broadcast('rooms-updated', {})
  broadcastRoomOnline()
}
