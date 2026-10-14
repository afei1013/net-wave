import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startApp, type AppHandle } from './helpers/startApp'
import { connectWs, createPeer, sendWs } from './helpers/clients'

const ADMIN_PASSWORD = 'auto-clean-test-password'

let app: AppHandle

beforeAll(async () => {
  app = await startApp({ env: { ADMIN_PASSWORD, NW_ROOM_APPROVAL: 'off' } })
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

describe('定时全量清理', () => {
  it('清理接口需管理员会话', async () => {
    expect((await fetch(`${app.baseUrl}/api/admin/auto-clean`)).status).toBe(401)
    const put = await fetch(`${app.baseUrl}/api/admin/auto-clean`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    })
    expect(put.status).toBe(401)
    expect((await fetch(`${app.baseUrl}/api/admin/auto-clean/run`, { method: 'POST' })).status).toBe(401)
  })

  it('默认配置与天数校验：默认关闭/7 天，非法天数 400', async () => {
    const cookie = await adminLogin()
    const get = await fetch(`${app.baseUrl}/api/admin/auto-clean`, { headers: { Cookie: cookie } })
    expect(await get.json()).toEqual({ enabled: false, days: 7, lastRun: null })

    for (const bad of [0, -1, 1.5, 9999]) {
      const res = await fetch(`${app.baseUrl}/api/admin/auto-clean`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ days: bad }),
      })
      expect(res.status).toBe(400)
    }
    const ok = await fetch(`${app.baseUrl}/api/admin/auto-clean`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ days: 30 }),
    })
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as { days: number }).days).toBe(30)
  })

  it('立即清理：消息/房间/文件全量清空，在线节点收到广播，lastRun 更新，重复执行幂等', async () => {
    // 造数据：房间 + 文本消息 + 文件消息
    const owner = await createPeer(app.baseUrl)
    const roomRes = await fetch(`${app.baseUrl}/api/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `nw_peer=${owner}` },
      body: JSON.stringify({ name: '清理测试房间' }),
    })
    const room = (await roomRes.json()) as { id: number; conversationId: number }

    const conn = await connectWs(app, owner)
    await conn.wait('presence')
    sendWs(conn.ws, { type: 'send-message', conversationId: room.conversationId, text: '将被清理的消息' })
    await conn.wait('message')

    const form = new FormData()
    form.append('file', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), '清理测试.png')
    const upload = await fetch(`${app.baseUrl}/api/files`, {
      method: 'POST',
      body: form,
      headers: { Cookie: `nw_peer=${owner}` },
    })
    const { fileId } = (await upload.json()) as { fileId: string }
    sendWs(conn.ws, { type: 'send-message', conversationId: room.conversationId, fileId })
    await conn.wait('message')

    // 清理前文件可下载
    expect((await fetch(`${app.baseUrl}/api/files/${fileId}`, { headers: { Cookie: `nw_peer=${owner}` } })).status).toBe(200)

    // 广播等待先注册，再触发清理
    const gotBroadcast = conn.wait('rooms-updated')
    const cookie = await adminLogin()
    const run = await fetch(`${app.baseUrl}/api/admin/auto-clean/run`, {
      method: 'POST',
      headers: { Cookie: cookie },
    })
    expect(run.status).toBe(200)
    const stats = (await run.json()) as { messages: number; rooms: number; files: number }
    expect(stats.messages).toBeGreaterThanOrEqual(2)
    expect(stats.rooms).toBeGreaterThanOrEqual(1)
    expect(stats.files).toBeGreaterThanOrEqual(1)
    await gotBroadcast
    conn.ws.close()

    // 全量清空断言：房间、会话、文件全部消失
    const rooms = await fetch(`${app.baseUrl}/api/rooms`, { headers: { Cookie: `nw_peer=${owner}` } })
    expect(((await rooms.json()) as { rooms: unknown[] }).rooms).toHaveLength(0)
    const convs = await fetch(`${app.baseUrl}/api/conversations`, { headers: { Cookie: `nw_peer=${owner}` } })
    expect(((await convs.json()) as { conversations: unknown[] }).conversations).toHaveLength(0)
    expect((await fetch(`${app.baseUrl}/api/files/${fileId}`, { headers: { Cookie: `nw_peer=${owner}` } })).status).toBe(404)

    // lastRun 已记录；再次执行统计归零（幂等）
    const cfg = await fetch(`${app.baseUrl}/api/admin/auto-clean`, { headers: { Cookie: cookie } })
    expect(((await cfg.json()) as { lastRun: number | null }).lastRun).not.toBeNull()
    const run2 = await fetch(`${app.baseUrl}/api/admin/auto-clean/run`, {
      method: 'POST',
      headers: { Cookie: cookie },
    })
    expect(await run2.json()).toEqual({ ok: true, messages: 0, rooms: 0, files: 0 })
  })

  it('配置持久化：重启后开关与天数保留，未到期不误清', async () => {
    const cookie = await adminLogin()
    const on = await fetch(`${app.baseUrl}/api/admin/auto-clean`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ enabled: true, days: 3 }),
    })
    expect(on.status).toBe(200)

    await app.stop()
    app = await startApp({ dataDir: app.dataDir, env: { ADMIN_PASSWORD, NW_ROOM_APPROVAL: 'off' } })

    // 重启使内存 admin session 失效（401），重新登录后配置仍在
    const cookie2 = await adminLogin()
    const cfg = await fetch(`${app.baseUrl}/api/admin/auto-clean`, { headers: { Cookie: cookie2 } })
    const body = (await cfg.json()) as { enabled: boolean; days: number; lastRun: number | null }
    expect(body.enabled).toBe(true)
    expect(body.days).toBe(3)
    // 上次执行时间未过期：启动期检查不触发清理（lastRun 保留而非清零重跑）
    expect(body.lastRun).not.toBeNull()
  })
})
