import { NextResponse } from 'next/server'
import { requirePeerId } from '@/api-auth'
import { canAccessConversation, findConversation, listMessages } from '@/chat'
import { isRoomE2eActive, maskRoomMessagesFor } from '@/e2e'

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const peerId = await requirePeerId()
  if (!peerId) {
    return NextResponse.json({ error: '未识别的节点身份' }, { status: 401 })
  }

  const { id } = await params
  const conversationId = Number(id)
  const conversation = Number.isInteger(conversationId) ? findConversation(conversationId) : null
  if (!conversation) {
    return NextResponse.json({ error: '会话不存在' }, { status: 404 })
  }

  // 端到端加密在该房间实际生效（总开关开启且房间未放开加密）时：非成员不再 403，
  // 改由服务端替换为加密占位（房主/授权者全明文、成员按加入时刻隔离历史、其余全部占位）
  const e2eRoom = conversation.type === 'room' && conversation.roomId != null && isRoomE2eActive(conversation.roomId)
  if (!e2eRoom && !canAccessConversation(conversation, peerId)) {
    return NextResponse.json({ error: '无权访问该会话' }, { status: 403 })
  }

  const url = new URL(request.url)
  const beforeRaw = url.searchParams.get('before')
  const before = beforeRaw ? Number(beforeRaw) : undefined
  const messages = listMessages(conversationId, Number.isInteger(before) ? before : undefined)
  if (!e2eRoom) {
    return NextResponse.json({ messages, meta: { masked: false, fullAccess: true } })
  }

  const { messages: visible, meta } = maskRoomMessagesFor(conversation.roomId as number, peerId, messages)
  return NextResponse.json({ messages: visible, meta })
}
