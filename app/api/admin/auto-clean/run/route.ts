import { NextResponse } from 'next/server'
import { requireAdminSessionToken } from '@/api-auth'
import { runCleanupNow } from '@/auto-clean'

/** 立即执行一次全量清理（无视开关与间隔，供手动清理；同样刷新 lastRun） */
export async function POST() {
  const token = await requireAdminSessionToken()
  if (!token) {
    return NextResponse.json({ error: '未登录或会话已过期' }, { status: 401 })
  }
  const stats = runCleanupNow()
  return NextResponse.json({ ok: true, ...stats })
}
