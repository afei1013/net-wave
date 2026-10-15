import { NextResponse } from 'next/server'
import { requireAdminSessionToken } from '@/api-auth'
import { openDb } from '@/db'

/** 管理端节点列表：授权弹窗选择目标节点用（含全部历史节点，非仅在线） */
export async function GET() {
  const token = await requireAdminSessionToken()
  if (!token) {
    return NextResponse.json({ error: '未登录或会话已过期' }, { status: 401 })
  }
  const peers = openDb()
    .prepare('SELECT id, name, created_at AS createdAt FROM peers ORDER BY created_at DESC LIMIT 500')
    .all() as { id: string; name: string; createdAt: number }[]
  return NextResponse.json({ peers })
}
