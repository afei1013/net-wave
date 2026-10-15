import { NextResponse } from 'next/server'
import { getHub } from '@/hub'
import { requirePeerId } from '@/api-auth'
import { broadcastRoomOnline, createRoom, listRooms } from '@/rooms'
import { isE2eEnabled } from '@/e2e'
import { isRoomApprovalEnabled, listMyPendingRequests, submitCreateRoomRequest } from '@/room-requests'

export async function GET() {
  const peerId = await requirePeerId()
  if (!peerId) return NextResponse.json({ error: '未识别的节点身份' }, { status: 401 })
  return NextResponse.json({
    rooms: listRooms(),
    approvalEnabled: isRoomApprovalEnabled(),
    e2eEnabled: isE2eEnabled(),
    myRequests: listMyPendingRequests(peerId),
  })
}

export async function POST(request: Request) {
  const peerId = await requirePeerId()
  if (!peerId) return NextResponse.json({ error: '未识别的节点身份' }, { status: 401 })

  const body = (await request.json().catch(() => null)) as { name?: unknown } | null
  const name = typeof body?.name === 'string' ? body.name : ''

  // 审批开启：入待审队列，管理员批准后房间才创建（202 与直接建房的 200 区分两种结果）
  if (isRoomApprovalEnabled()) {
    const result = submitCreateRoomRequest(peerId, name)
    if (!result.ok) {
      return NextResponse.json({ error: '房间名需在 1-50 个字符之间' }, { status: 400 })
    }
    return NextResponse.json({ pending: true, request: result.request }, { status: 202 })
  }

  const room = createRoom(peerId, name)
  if (!room) {
    return NextResponse.json({ error: '房间名需在 1-50 个字符之间' }, { status: 400 })
  }
  // 建房即加入：自己的会话列表立即出现该房间，在线成员数一并广播
  getHub().sendToPeer(peerId, 'conversations-updated', {})
  getHub().broadcast('rooms-updated', {})
  broadcastRoomOnline()
  return NextResponse.json(room)
}
