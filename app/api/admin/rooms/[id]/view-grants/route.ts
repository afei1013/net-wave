import { NextResponse } from 'next/server'
import { requireAdminSessionToken } from '@/api-auth'
import { grantViewPermission, listViewGrants, revokeViewPermission } from '@/e2e'
import { findRoom } from '@/rooms'
import { findPeer } from '@/peers'

/** 房间历史查看授权管理：列表 / 授予（管理员主动，无需申请） / 撤销 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const token = await requireAdminSessionToken()
  if (!token) {
    return NextResponse.json({ error: '未登录或会话已过期' }, { status: 401 })
  }
  const { id } = await params
  const roomId = Number(id)
  if (!Number.isInteger(roomId) || !findRoom(roomId)) {
    return NextResponse.json({ error: '房间不存在' }, { status: 404 })
  }
  return NextResponse.json({ grants: listViewGrants(roomId) })
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const token = await requireAdminSessionToken()
  if (!token) {
    return NextResponse.json({ error: '未登录或会话已过期' }, { status: 401 })
  }
  const { id } = await params
  const roomId = Number(id)
  const body = (await request.json().catch(() => null)) as { peerId?: unknown } | null
  const peerId = typeof body?.peerId === 'string' ? body.peerId : ''
  if (!Number.isInteger(roomId) || !findRoom(roomId)) {
    return NextResponse.json({ error: '房间不存在' }, { status: 404 })
  }
  if (!peerId || !findPeer(peerId)) {
    return NextResponse.json({ error: '节点不存在' }, { status: 404 })
  }
  if (!grantViewPermission(roomId, peerId)) {
    return NextResponse.json({ error: '授权失败' }, { status: 500 })
  }
  return NextResponse.json({ ok: true, grants: listViewGrants(roomId) })
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const token = await requireAdminSessionToken()
  if (!token) {
    return NextResponse.json({ error: '未登录或会话已过期' }, { status: 401 })
  }
  const { id } = await params
  const roomId = Number(id)
  const peerId = new URL(request.url).searchParams.get('peerId') ?? ''
  if (!Number.isInteger(roomId) || !findRoom(roomId)) {
    return NextResponse.json({ error: '房间不存在' }, { status: 404 })
  }
  if (!revokeViewPermission(roomId, peerId)) {
    return NextResponse.json({ error: '该节点没有此房间的授权' }, { status: 404 })
  }
  return NextResponse.json({ ok: true, grants: listViewGrants(roomId) })
}
