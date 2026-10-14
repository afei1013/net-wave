import { NextResponse } from 'next/server'
import { requireAdminSessionToken } from '@/api-auth'
import { handleRoomRequest } from '@/room-requests'

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const token = await requireAdminSessionToken()
  if (!token) {
    return NextResponse.json({ error: '未登录或会话已过期' }, { status: 401 })
  }

  const { id } = await params
  const requestId = Number(id)
  const body = (await request.json().catch(() => null)) as { action?: unknown } | null
  if (!Number.isInteger(requestId) || (body?.action !== 'approve' && body?.action !== 'reject')) {
    return NextResponse.json({ error: '参数无效（action 需为 approve 或 reject）' }, { status: 400 })
  }

  const result = handleRoomRequest(requestId, body.action === 'approve')
  if (!result.ok) {
    if (result.reason === 'not-found') {
      return NextResponse.json({ error: '申请不存在' }, { status: 404 })
    }
    if (result.reason === 'already-handled') {
      return NextResponse.json({ error: '该申请已被处理过' }, { status: 409 })
    }
    if (result.reason === 'room-gone') {
      return NextResponse.json({ error: '目标房间已被删除，该申请已自动关闭' }, { status: 410 })
    }
    return NextResponse.json({ error: '房间名无效（1-50 个字符），无法创建' }, { status: 400 })
  }
  return NextResponse.json({ handled: true, approved: result.approved, kind: result.kind, roomName: result.roomName })
}
