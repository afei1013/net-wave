import { NextResponse } from 'next/server'
import { requirePeerId } from '@/api-auth'
import { submitViewRequest } from '@/e2e'

/** 申请房间历史查看权限（端到端加密显示开启时，预览页/历史隔离提示条入口） */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const peerId = await requirePeerId()
  if (!peerId) {
    return NextResponse.json({ error: '未识别的节点身份' }, { status: 401 })
  }

  const { id } = await params
  const roomId = Number(id)
  if (!Number.isInteger(roomId)) {
    return NextResponse.json({ error: '房间不存在' }, { status: 404 })
  }
  const result = submitViewRequest(peerId, roomId)
  if (!result.ok) {
    if (result.reason === 'room-not-found') return NextResponse.json({ error: '房间不存在' }, { status: 404 })
    if (result.reason === 'room-not-encrypted') {
      return NextResponse.json({ error: '该房间未开启加密，无需申请历史查看权限' }, { status: 409 })
    }
    return NextResponse.json({ error: '你已拥有该房间的全部查看权限，无需申请' }, { status: 409 })
  }
  return NextResponse.json({ pending: true, duplicated: result.duplicated }, { status: result.duplicated ? 200 : 202 })
}
