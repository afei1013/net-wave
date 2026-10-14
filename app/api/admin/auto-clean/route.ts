import { NextResponse } from 'next/server'
import { requireAdminSessionToken } from '@/api-auth'
import { getAutoCleanConfig, setAutoCleanConfig } from '@/auto-clean'

/** 定时全量清理配置：开启后每隔 N 天自动清空全部聊天数据、房间与上传文件 */
export async function GET() {
  const token = await requireAdminSessionToken()
  if (!token) {
    return NextResponse.json({ error: '未登录或会话已过期' }, { status: 401 })
  }
  return NextResponse.json(getAutoCleanConfig())
}

export async function PUT(request: Request) {
  const token = await requireAdminSessionToken()
  if (!token) {
    return NextResponse.json({ error: '未登录或会话已过期' }, { status: 401 })
  }
  const body = (await request.json().catch(() => null)) as { enabled?: unknown; days?: unknown } | null
  const result = setAutoCleanConfig({
    enabled: typeof body?.enabled === 'boolean' ? body.enabled : undefined,
    days: body?.days,
  })
  if (!result.ok) {
    return NextResponse.json({ error: `清理天数需为 1-3650 的整数` }, { status: 400 })
  }
  return NextResponse.json(result.config)
}
