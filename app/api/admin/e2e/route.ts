import { NextResponse } from 'next/server'
import { requireAdminSessionToken } from '@/api-auth'
import { isE2eEnabled, setE2eEnabled } from '@/e2e'

/** 端到端加密显示总开关：开启后房间消息按身份分级（房主/授权者全明文、
 *  成员仅加入后、非成员全占位）；私聊与实时投递不受影响 */
export async function GET() {
  const token = await requireAdminSessionToken()
  if (!token) {
    return NextResponse.json({ error: '未登录或会话已过期' }, { status: 401 })
  }
  return NextResponse.json({ enabled: isE2eEnabled() })
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
  setE2eEnabled(body.enabled)
  return NextResponse.json({ enabled: body.enabled })
}
