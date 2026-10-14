import { NextResponse } from 'next/server'
import { requireAdminSessionToken } from '@/api-auth'
import { isRoomApprovalEnabled, setRoomApprovalEnabled } from '@/room-requests'

/** 房间审批总开关：关闭后建房/加入恢复自由模式（待审申请保留，仍可继续处理） */
export async function GET() {
  const token = await requireAdminSessionToken()
  if (!token) {
    return NextResponse.json({ error: '未登录或会话已过期' }, { status: 401 })
  }
  return NextResponse.json({ enabled: isRoomApprovalEnabled() })
}

export async function PUT(request: Request) {
  const token = await requireAdminSessionToken()
  if (!token) {
    return NextResponse.json({ error: '未登录或会话已过期' }, { status: 401 })
  }
  const body = (await request.json().catch(() => null)) as { enabled?: unknown } | null
  if (typeof body?.enabled !== 'boolean') {
    return NextResponse.json({ error: '参数无效（enabled 需为布尔值）' }, { status: 400 })
  }
  setRoomApprovalEnabled(body.enabled)
  return NextResponse.json({ enabled: body.enabled })
}
