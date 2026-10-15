/** 前端共享类型：页面与组件共用（与后端 API 契约对应） */

import type { FileMeta, MessageRow } from './message-view'

export interface Peer {
  id: string
  name: string
  ip?: string | null
  mac?: string | null
  /** 节点隐私偏好（服务端持久）：隐藏后本人网络信息不随消息/presence 下发 */
  hideIp?: boolean
  hideMac?: boolean
}

export interface RoomInfo {
  id: number
  name: string
  createdBy: string | null
  memberCount: number
  conversationId: number
}

/** 房间申请（建房/查看历史权限）：pending 期间侧栏展示「审批中」；view 为历史查看授权申请 */
export interface RoomRequest {
  id: number
  kind: 'create' | 'join' | 'view'
  roomId: number | null
  roomName: string | null
  createdAt: number
}

export interface ConversationSummary {
  id: number
  type: 'direct' | 'room'
  peer?: { id: string; name: string; ip?: string | null; mac?: string | null }
  room?: { id: number; name: string; memberCount: number; createdBy: string | null }
  lastMessage: MessageRow | null
}

export interface CenterInfo {
  lanUrl: string
  qrDataUrl: string
}

export type { FileMeta }
