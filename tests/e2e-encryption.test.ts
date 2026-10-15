import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startApp, type AppHandle } from './helpers/startApp'
import { connectWs, createPeer, sendWs } from './helpers/clients'

const ADMIN_PASSWORD = 'e2e-test-password'

let app: AppHandle

beforeAll(async () => {
  app = await startApp({ env: { ADMIN_PASSWORD, NW_ROOM_APPROVAL: 'off', NW_E2E_ENCRYPTION: 'on' } })
})

afterAll(async () => {
  await app.stop()
})

interface MsgRow {
  id: number
  text: string | null
  senderId: string
  createdAt: number
}
interface MsgBody {
  messages: MsgRow[]
  meta?: { masked: boolean; fullAccess: boolean }
}

async function adminLogin(): Promise<string> {
  const res = await fetch(`${app.baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: ADMIN_PASSWORD }),
  })
  expect(res.status).toBe(200)
  return (res.headers.get('set-cookie') ?? '').match(/nw_admin=([^;]+)/)?.[0] ?? ''
}

async function adminPut(path: string, body: unknown): Promise<Response> {
  const cookie = await adminLogin()
  return fetch(`${app.baseUrl}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(body),
  })
}

async function fetchMessages(peerId: string, conversationId: number): Promise<{ status: number; body: MsgBody }> {
  const res = await fetch(`${app.baseUrl}/api/conversations/${conversationId}/messages`, {
    headers: { Cookie: `nw_peer=${peerId}` },
  })
  return { status: res.status, body: (await res.json().catch(() => ({ messages: [] }))) as MsgBody }
}

/** 建房（自由模式）并向房间发一条文本消息 */
async function roomWithMessage(name: string, text: string) {
  const owner = await createPeer(app.baseUrl)
  const roomRes = await fetch(`${app.baseUrl}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `nw_peer=${owner}` },
    body: JSON.stringify({ name }),
  })
  const room = (await roomRes.json()) as { id: number; conversationId: number }
  const conn = await connectWs(app, owner)
  await conn.wait('presence')
  sendWs(conn.ws, { type: 'send-message', conversationId: room.conversationId, text })
  await conn.wait('message')
  return { owner, conn, room }
}

describe('端到端加密显示（历史隔离 + 授权）', () => {
  it('管理接口需登录；默认开启（本实例经环境变量）', async () => {
    expect((await fetch(`${app.baseUrl}/api/admin/e2e`)).status).toBe(401)
    const cookie = await adminLogin()
    const res = await fetch(`${app.baseUrl}/api/admin/e2e`, { headers: { Cookie: cookie } })
    expect(((await res.json()) as { enabled: boolean }).enabled).toBe(true)
  })

  it('非成员：不再 403，全部消息为服务端替换的加密占位', async () => {
    const { owner, conn, room } = await roomWithMessage('加密预览房', '秘密内容ABC')
    const outsider = await createPeer(app.baseUrl)

    const { status, body } = await fetchMessages(outsider, room.conversationId)
    expect(status).toBe(200)
    expect(body.messages.length).toBe(1)
    expect(body.messages[0].text).toContain('端到端加密')
    expect(body.messages[0].text).not.toContain('秘密内容ABC')
    expect(body.meta).toEqual({ masked: true, fullAccess: false })

    // 房主视角明文不受影响
    const ownerView = await fetchMessages(owner, room.conversationId)
    expect(ownerView.body.messages[0].text).toBe('秘密内容ABC')
    expect(ownerView.body.meta).toEqual({ masked: false, fullAccess: true })
    conn.ws.close()
  })

  it('成员历史隔离：加入前的消息加密占位，加入后的明文', async () => {
    const { owner, conn, room } = await roomWithMessage('历史隔离房', '加入前的秘密')
    const joiner = await createPeer(app.baseUrl)

    // 加入（自由）并再发一条新消息
    const joinRes = await fetch(`${app.baseUrl}/api/rooms/${room.id}/join`, {
      method: 'POST',
      headers: { Cookie: `nw_peer=${joiner}` },
    })
    expect(joinRes.status).toBe(200)
    const jConn = await connectWs(app, joiner)
    await jConn.wait('presence')
    sendWs(jConn.ws, { type: 'send-message', conversationId: room.conversationId, text: '加入后的明文' })
    await jConn.wait('message')

    const view = await fetchMessages(joiner, room.conversationId)
    expect(view.body.meta).toEqual({ masked: true, fullAccess: false })
    const texts = view.body.messages.map((m) => m.text)
    expect(texts).toContain('加入后的明文')
    expect(texts.some((t) => t != null && t.includes('端到端加密'))).toBe(true)
    expect(texts).not.toContain('加入前的秘密')

    // 房主全明文
    const ownerView = await fetchMessages(owner, room.conversationId)
    expect(ownerView.body.meta).toEqual({ masked: false, fullAccess: true })
    conn.ws.close()
    jConn.ws.close()
  })

  it('申请→管理员批准→全量明文（含 WS 通知与幂等）', async () => {
    const { owner, conn, room } = await roomWithMessage('授权流程房', '待授权的秘密')
    const applicant = await createPeer(app.baseUrl)

    // 房主无需申请（409）；普通申请 202、重复申请幂等
    const ownerApply = await fetch(`${app.baseUrl}/api/rooms/${room.id}/view-request`, {
      method: 'POST',
      headers: { Cookie: `nw_peer=${owner}` },
    })
    expect(ownerApply.status).toBe(409)
    conn.ws.close()

    const apply = await fetch(`${app.baseUrl}/api/rooms/${room.id}/view-request`, {
      method: 'POST',
      headers: { Cookie: `nw_peer=${applicant}` },
    })
    expect(apply.status).toBe(202)
    const again = await fetch(`${app.baseUrl}/api/rooms/${room.id}/view-request`, {
      method: 'POST',
      headers: { Cookie: `nw_peer=${applicant}` },
    })
    expect(again.status).toBe(200) // 幂等

    // 管理端待审列表出现「查看历史」申请
    const cookie = await adminLogin()
    const pending = await fetch(`${app.baseUrl}/api/admin/room-requests`, { headers: { Cookie: cookie } })
    const list = ((await pending.json()) as { requests: { id: number; kind: string; peerId: string }[] }).requests
    const target = list.find((r) => r.kind === 'view' && r.peerId === applicant)
    expect(target).toBeDefined()

    const approve = await fetch(`${app.baseUrl}/api/admin/room-requests/${target!.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ action: 'approve' }),
    })
    expect(approve.status).toBe(200)

    // 授权后免加入即可看全量明文
    const view = await fetchMessages(applicant, room.conversationId)
    expect(view.body.meta).toEqual({ masked: false, fullAccess: true })
    expect(view.body.messages[0].text).toBe('待授权的秘密')
  })

  it('管理员主动授权与撤销', async () => {
    const { room } = await roomWithMessage('主动授权房', '管理员授权的秘密')
    const cookie = await adminLogin()
    const peer = await createPeer(app.baseUrl)

    // 授权前：占位
    expect((await fetchMessages(peer, room.conversationId)).body.meta?.fullAccess).toBe(false)

    const grant = await fetch(`${app.baseUrl}/api/admin/rooms/${room.id}/view-grants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ peerId: peer }),
    })
    expect(grant.status).toBe(200)
    expect(((await grant.json()) as { grants: unknown[] }).grants).toHaveLength(1)

    // 授权后：明文
    expect((await fetchMessages(peer, room.conversationId)).body.meta?.fullAccess).toBe(true)

    // 撤销后：回到占位
    const revoke = await fetch(`${app.baseUrl}/api/admin/rooms/${room.id}/view-grants?peerId=${encodeURIComponent(peer)}`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    })
    expect(revoke.status).toBe(200)
    const view = await fetchMessages(peer, room.conversationId)
    expect(view.body.meta).toEqual({ masked: true, fullAccess: false })
  })

  it('总开关关闭：恢复原有行为（非成员 403、成员全明文）', async () => {
    const { owner, conn, room } = await roomWithMessage('开关关闭房', '关闭后的消息')
    const outsider = await createPeer(app.baseUrl)
    const joiner = await createPeer(app.baseUrl)
    await fetch(`${app.baseUrl}/api/rooms/${room.id}/join`, { method: 'POST', headers: { Cookie: `nw_peer=${joiner}` } })

    const off = await adminPut('/api/admin/e2e', { enabled: false })
    expect(off.status).toBe(200)

    // 非成员回到 403；成员（含加入前历史）全明文
    expect((await fetchMessages(outsider, room.conversationId)).status).toBe(403)
    const view = await fetchMessages(joiner, room.conversationId)
    expect(view.body.messages.map((m) => m.text)).toContain('关闭后的消息')
    expect(view.body.meta).toEqual({ masked: false, fullAccess: true })
    conn.ws.close()

    // 联动约束：总开关关闭时，房间级开关接口被拒绝（409）
    const roomToggle = await adminPut(`/api/admin/rooms/${room.id}/encryption`, { encrypted: false })
    expect(roomToggle.status).toBe(409)

    // 恢复开启，不影响后续用例
    await adminPut('/api/admin/e2e', { enabled: true })
  })

  it('房间级粒度：放开加密的房间恢复原有行为，申请/授权随之失效', async () => {
    const { owner, conn, room } = await roomWithMessage('房间粒度房', '房间粒度的秘密')
    const outsider = await createPeer(app.baseUrl)
    const joiner = await createPeer(app.baseUrl)
    await fetch(`${app.baseUrl}/api/rooms/${room.id}/join`, { method: 'POST', headers: { Cookie: `nw_peer=${joiner}` } })

    // 默认房间加密（继承总开关开启）：外人占位、成员历史隔离
    expect((await fetchMessages(outsider, room.conversationId)).body.meta?.fullAccess).toBe(false)

    // 管理员放开该房间加密
    const relax = await adminPut(`/api/admin/rooms/${room.id}/encryption`, { encrypted: false })
    expect(relax.status).toBe(200)

    // 该房间恢复原有行为：非成员 403、成员（含加入前历史）全明文
    expect((await fetchMessages(outsider, room.conversationId)).status).toBe(403)
    const view = await fetchMessages(joiner, room.conversationId)
    expect(view.body.messages.map((m) => m.text)).toContain('房间粒度的秘密')
    expect(view.body.meta).toEqual({ masked: false, fullAccess: true })

    // 联动：房间放开加密后申请被拒（409）、主动授权被拒（409）
    const apply = await fetch(`${app.baseUrl}/api/rooms/${room.id}/view-request`, {
      method: 'POST',
      headers: { Cookie: `nw_peer=${outsider}` },
    })
    expect(apply.status).toBe(409)
    const cookie = await adminLogin()
    const grant = await fetch(`${app.baseUrl}/api/admin/rooms/${room.id}/view-grants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ peerId: outsider }),
    })
    expect(grant.status).toBe(409)

    // 房主视角不受影响
    expect((await fetchMessages(owner, room.conversationId)).body.messages[0].text).toBe('房间粒度的秘密')
    conn.ws.close()

    // 恢复房间加密，验证可再开启
    const reEncrypt = await adminPut(`/api/admin/rooms/${room.id}/encryption`, { encrypted: true })
    expect(reEncrypt.status).toBe(200)
    expect((await fetchMessages(outsider, room.conversationId)).body.meta?.fullAccess).toBe(false)
  })
})
