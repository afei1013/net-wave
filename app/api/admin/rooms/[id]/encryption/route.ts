import { NextResponse } from 'next/server'
import { requireAdminSessionToken } from '@/api-auth'
import { setRoomEncrypted } from '@/e2e'

/**
 * 房间级加密开关（联动约束：仅端到端加密总开关开启时可设置）。
 * 放开加密 = 该房间恢复原有可见性（非成员 403、成员全明文），历史查看授权随之失效。
 */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const token = await requireAdminSessionToken()
  if (!token) {
    return NextResponse.json({ error: '未登录或会话已过期' }, { status: 401 })
  }
  const { id } = await params
  const roomId = Number(id)
  const body = (await request.json().catch(() => null)) as { encrypted?: unknown } | null
  if (!Number.isInteger(roomId) || typeof body?.encrypted !== 'boolean') {
    return NextResponse.json({ error: '参数无效（encrypted 需为布尔值）' }, { status: 400 })
  }
  const result = setRoomEncrypted(roomId, body.encrypted)
  if (!result.ok) {
    if (result.reason === 'master-off') {
      return NextResponse.json({ error: '端到端加密总开关未开启，无法设置房间级加密' }, { status: 409 })
    }
    return NextResponse.json({ error: '房间不存在' }, { status: 404 })
  }
  return NextResponse.json({ ok: true, encrypted: body.encrypted })
}
