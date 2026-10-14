import { NextResponse } from 'next/server'
import { requireAdminSessionToken } from '@/api-auth'
import { listPendingRoomRequestsForAdmin } from '@/room-requests'

export async function GET() {
  const token = await requireAdminSessionToken()
  if (!token) {
    return NextResponse.json({ error: '未登录或会话已过期' }, { status: 401 })
  }
  return NextResponse.json({ requests: listPendingRoomRequestsForAdmin() })
}
