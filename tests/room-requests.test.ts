import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startApp, type AppHandle } from './helpers/startApp'
import { connectWs, createPeer } from './helpers/clients'

const ADMIN_PASSWORD = 'approval-test-password'

let app: AppHandle

beforeAll(async () => {
  // 显式开启审批（也是缺省行为），聚焦申请→审批全链路
  app = await startApp({ env: { ADMIN_PASSWORD, NW_ROOM_APPROVAL: 'on' } })
})

afterAll(async () => {
  await app.stop()
})

async function adminLogin(): Promise<string> {
  const res = await fetch(`${app.baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: ADMIN_PASSWORD }),
  })
  expect(res.status).toBe(200)
  return (res.headers.get('set-cookie') ?? '').match(/nw_admin=([^;]+)/)?.[0] ?? ''
}

interface PendingRequest {
  id: number
  kind: 'create' | 'join'
  roomId: number | null
  roomName: string | null
  peerId: string
  peerName: string | null
}

async function listPending(cookie: string): Promise<PendingRequest[]> {
  const res = await fetch(`${app.baseUrl}/api/admin/room-requests`, { headers: { Cookie: cookie } })
  expect(res.status).toBe(200)
  return ((await res.json()) as { requests: PendingRequest[] }).requests
}

async function submitCreate(peerId: string, name: string): Promise<Response> {
  return fetch(`${app.baseUrl}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `nw_peer=${peerId}` },
    body: JSON.stringify({ name }),
  })
}

async function submitJoin(peerId: string, roomId: number): Promise<Response> {
  return fetch(`${app.baseUrl}/api/rooms/${roomId}/join`, {
    method: 'POST',
    headers: { Cookie: `nw_peer=${peerId}` },
  })
}

async function handleRequest(cookie: string, requestId: number, action: 'approve' | 'reject'): Promise<Response> {
  return fetch(`${app.baseUrl}/api/admin/room-requests/${requestId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ action }),
  })
}

/** 经审批创建一个房间（测试辅助），返回房主与房间公开信息 */
async function createRoomViaApproval(name: string): Promise<{ owner: string; id: number; name: string }> {
  const owner = await createPeer(app.baseUrl)
  const submit = await submitCreate(owner, name)
  expect(submit.status).toBe(202)
  const cookie = await adminLogin()
  const target = (await listPending(cookie)).find((r) => r.roomName === name)
  expect(target).toBeDefined()
  expect((await handleRequest(cookie, target!.id, 'approve')).status).toBe(200)
  const roomsRes = await fetch(`${app.baseUrl}/api/rooms`, { headers: { Cookie: `nw_peer=${owner}` } })
  const room = ((await roomsRes.json()) as { rooms: { id: number; name: string }[] }).rooms.find((r) => r.name === name)
  expect(room).toBeDefined()
  return { owner, ...room! }
}

describe('房间审批', () => {
  it('审批接口需管理员会话', async () => {
    expect((await fetch(`${app.baseUrl}/api/admin/room-requests`)).status).toBe(401)
    expect((await fetch(`${app.baseUrl}/api/admin/approval`)).status).toBe(401)
    const put = await fetch(`${app.baseUrl}/api/admin/approval`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    })
    expect(put.status).toBe(401)
  })

  it('建房走审批：202 pending → 管理员通过 → 房间创建且申请人是成员', async () => {
    const owner = await createPeer(app.baseUrl)
    const submit = await submitCreate(owner, '审批建房')
    expect(submit.status).toBe(202)
    const submitBody = (await submit.json()) as { pending: boolean; request: { kind: string; roomName: string } }
    expect(submitBody.pending).toBe(true)
    expect(submitBody.request.kind).toBe('create')
    expect(submitBody.request.roomName).toBe('审批建房')

    const cookie = await adminLogin()
    const target = (await listPending(cookie)).find((r) => r.roomName === '审批建房')
    expect(target?.kind).toBe('create')

    expect((await handleRequest(cookie, target!.id, 'approve')).status).toBe(200)

    // 房间出现在公开列表且申请人自动成为成员；我的待审列表清空
    const roomsRes = await fetch(`${app.baseUrl}/api/rooms`, { headers: { Cookie: `nw_peer=${owner}` } })
    const roomsBody = (await roomsRes.json()) as {
      rooms: { name: string; memberCount: number }[]
      approvalEnabled: boolean
      myRequests: unknown[]
    }
    const room = roomsBody.rooms.find((r) => r.name === '审批建房')
    expect(room?.memberCount).toBe(1)
    expect(roomsBody.approvalEnabled).toBe(true)
    expect(roomsBody.myRequests).toHaveLength(0)

    const convs = await fetch(`${app.baseUrl}/api/conversations`, { headers: { Cookie: `nw_peer=${owner}` } })
    const convsBody = (await convs.json()) as { conversations: { type: string; room?: { name: string } }[] }
    expect(convsBody.conversations.some((c) => c.type === 'room' && c.room?.name === '审批建房')).toBe(true)
  })

  it('重复申请幂等：同一节点同名/同房间 pending 不重复入队', async () => {
    const peer = await createPeer(app.baseUrl)
    expect((await submitCreate(peer, '幂等建房')).status).toBe(202)
    expect((await submitCreate(peer, '幂等建房')).status).toBe(202)
    const cookie = await adminLogin()
    expect(((await listPending(cookie)).filter((r) => r.roomName === '幂等建房'))).toHaveLength(1)
  })

  it('加入走审批：通过后成为成员；已是成员再点加入幂等直入', async () => {
    const { owner, id: roomId, name } = await createRoomViaApproval('审批加入房')
    const joiner = await createPeer(app.baseUrl)

    const join = await submitJoin(joiner, roomId)
    expect(join.status).toBe(202)
    expect(((await join.json()) as { pending: boolean }).pending).toBe(true)

    const cookie = await adminLogin()
    const target = (await listPending(cookie)).find((r) => r.kind === 'join' && r.roomId === roomId)
    expect(target?.peerId).toBe(joiner)
    expect((await handleRequest(cookie, target!.id, 'approve')).status).toBe(200)

    // 成员生效：会话列表出现该房间
    const convs = await fetch(`${app.baseUrl}/api/conversations`, { headers: { Cookie: `nw_peer=${joiner}` } })
    const convsBody = (await convs.json()) as { conversations: { type: string; room?: { name: string } }[] }
    expect(convsBody.conversations.some((c) => c.type === 'room' && c.room?.name === name)).toBe(true)

    // 已是成员：再次加入与自由模式一致（200 直入而非 202 申请）
    const again = await submitJoin(joiner, roomId)
    expect(again.status).toBe(200)

    // 房主仍为创建者视角成员数 2
    const roomsRes = await fetch(`${app.baseUrl}/api/rooms`, { headers: { Cookie: `nw_peer=${owner}` } })
    const room = ((await roomsRes.json()) as { rooms: { name: string; memberCount: number }[] }).rooms.find((r) => r.name === name)
    expect(room?.memberCount).toBe(2)
  })

  it('加入不存在的房间返回 404（不产生申请）', async () => {
    const peer = await createPeer(app.baseUrl)
    expect((await submitJoin(peer, 999_999)).status).toBe(404)
    const cookie = await adminLogin()
    expect((await listPending(cookie)).filter((r) => r.peerId === peer)).toHaveLength(0)
  })

  it('拒绝后可重新申请；重复处理同一申请返回 409', async () => {
    const peer = await createPeer(app.baseUrl)
    expect((await submitCreate(peer, '被拒房间')).status).toBe(202)
    const cookie = await adminLogin()
    const first = (await listPending(cookie)).find((r) => r.roomName === '被拒房间' && r.peerId === peer)
    expect((await handleRequest(cookie, first!.id, 'reject')).status).toBe(200)

    // 已处理的申请再操作：409
    expect((await handleRequest(cookie, first!.id, 'approve')).status).toBe(409)

    // 拒绝后允许重新申请（新记录）
    const resubmit = await submitCreate(peer, '被拒房间')
    expect(resubmit.status).toBe(202)
    const second = (await listPending(cookie)).find((r) => r.roomName === '被拒房间' && r.peerId === peer)
    expect(second!.id).not.toBe(first!.id)
  })

  it('删除房间连带关闭待审的加入申请', async () => {
    const { owner, id: roomId } = await createRoomViaApproval('连带关闭房')
    const joiner = await createPeer(app.baseUrl)
    expect((await submitJoin(joiner, roomId)).status).toBe(202)

    // 房主删除房间
    const del = await fetch(`${app.baseUrl}/api/rooms/${roomId}`, {
      method: 'DELETE',
      headers: { Cookie: `nw_peer=${owner}` },
    })
    expect(del.status).toBe(200)

    const cookie = await adminLogin()
    expect((await listPending(cookie)).filter((r) => r.roomId === roomId)).toHaveLength(0)
  })

  it('审批开关：关闭后建房/加入恢复自由模式', async () => {
    const cookie = await adminLogin()
    const off = await fetch(`${app.baseUrl}/api/admin/approval`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ enabled: false }),
    })
    expect(off.status).toBe(200)

    const peer = await createPeer(app.baseUrl)
    const create = await submitCreate(peer, '自由模式房')
    expect(create.status).toBe(200)
    const room = (await create.json()) as { id: number; name: string }
    expect(room.name).toBe('自由模式房')

    const other = await createPeer(app.baseUrl)
    expect((await submitJoin(other, room.id)).status).toBe(200)

    // 重新开启：恢复 202 申请
    const on = await fetch(`${app.baseUrl}/api/admin/approval`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ enabled: true }),
    })
    expect(on.status).toBe(200)
    expect((await submitCreate(peer, '开关往返房')).status).toBe(202)
  })

  it('审批结果实时推送：批准与拒绝均通知申请人', async () => {
    const peer = await createPeer(app.baseUrl)
    const conn = await connectWs(app, peer)
    await conn.wait('presence')

    const cookie = await adminLogin()
    expect((await submitCreate(peer, '推送批准房')).status).toBe(202)
    const approved = (await listPending(cookie)).find((r) => r.roomName === '推送批准房')
    await handleRequest(cookie, approved!.id, 'approve')
    const gotApproved = (await conn.wait('room-request-result', (d: any) => d.status === 'approved')) as {
      kind: string
      roomName: string
    }
    expect(gotApproved.kind).toBe('create')
    expect(gotApproved.roomName).toBe('推送批准房')

    expect((await submitCreate(peer, '推送拒绝房')).status).toBe(202)
    const rejected = (await listPending(cookie)).find((r) => r.roomName === '推送拒绝房')
    await handleRequest(cookie, rejected!.id, 'reject')
    const gotRejected = (await conn.wait('room-request-result', (d: any) => d.status === 'rejected')) as {
      kind: string
    }
    expect(gotRejected.kind).toBe('create')
    conn.ws.close()
  })
})
