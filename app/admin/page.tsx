'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowLeftIcon, CheckIcon, KeyRoundIcon, Loader2Icon, ShieldIcon, TrashIcon, XIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@components/ui/button'
import { Input } from '@components/ui/input'
import { Badge } from '@components/ui/badge'
import { Skeleton } from '@components/ui/skeleton'
import { Switch } from '@components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@components/ui/alert-dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@components/ui/table'
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@components/ui/field'

interface AdminRoom {
  id: number
  name: string
  createdBy: string | null
  creatorName: string | null
  memberCount: number
  messageCount: number
  createdAt: number
  /** 房间级加密标志（总开关开启时生效） */
  encrypted: boolean
}

interface AdminRoomRequest {
  id: number
  kind: 'create' | 'join' | 'view'
  roomId: number | null
  roomName: string | null
  peerId: string
  peerName: string | null
  createdAt: number
}

interface ViewGrant {
  peerId: string
  peerName: string | null
  grantedAt: number
}

interface AutoCleanConfig {
  enabled: boolean
  days: number
  lastRun: number | null
}

function formatDateTime(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 管理员登录卡片：错误密码提示重试等待，被限流时展示剩余秒数 */
function LoginForm({ onLogin }: { onLogin: (password: string) => Promise<void> }) {
  const [password, setPassword] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!password || pending) return
    setPending(true)
    setError(null)
    try {
      await onLogin(password)
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败')
    } finally {
      setPending(false)
    }
  }

  return (
    <form onSubmit={submit} className="w-full max-w-sm rounded-xl border bg-sidebar p-6">
      <div className="mb-4 flex flex-col items-center gap-2 text-center">
        <div className="flex size-12 items-center justify-center rounded-2xl bg-primary text-white">
          <ShieldIcon className="size-6" />
        </div>
        <h1 className="text-lg font-bold">管理中心</h1>
        <p className="text-sm text-muted-foreground">
          输入服务中心管理员密码继续；初始密码见服务中心启动日志。
        </p>
      </div>
      <FieldGroup>
        <Field data-invalid={error != null || undefined}>
          <FieldLabel htmlFor="admin-password">管理员密码</FieldLabel>
          <Input
            id="admin-password"
            type="password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {error ? (
            <FieldDescription aria-live="polite">{error}</FieldDescription>
          ) : (
            <FieldDescription>连续失败会触发逐步加长的等待时间。</FieldDescription>
          )}
        </Field>
      </FieldGroup>
      <Button type="submit" className="mt-4 w-full" disabled={pending || !password}>
        {pending && <Loader2Icon data-icon="inline-start" className="animate-spin" />}
        登录
      </Button>
    </form>
  )
}

export default function AdminPage() {
  const [authed, setAuthed] = useState<boolean | null>(null)
  const [rooms, setRooms] = useState<AdminRoom[] | null>(null)
  const [requests, setRequests] = useState<AdminRoomRequest[] | null>(null)
  const [approvalEnabled, setApprovalEnabled] = useState<boolean | null>(null)
  // 行级操作进行中标记：审批按钮防重复点击
  const [actingId, setActingId] = useState<number | null>(null)
  // 定时清理配置 + 表单态
  const [cleanConfig, setCleanConfig] = useState<AutoCleanConfig | null>(null)
  const [cleanDaysInput, setCleanDaysInput] = useState('')
  const [cleanSaving, setCleanSaving] = useState(false)
  const [cleanRunning, setCleanRunning] = useState(false)
  // 端到端加密显示总开关
  const [e2eEnabled, setE2eEnabled] = useState<boolean | null>(null)
  // 历史查看授权弹窗
  const [grantRoom, setGrantRoom] = useState<AdminRoom | null>(null)
  const [grantPeers, setGrantPeers] = useState<{ id: string; name: string }[]>([])
  const [grantPeerId, setGrantPeerId] = useState('')
  const [grantList, setGrantList] = useState<ViewGrant[]>([])
  const [grantBusy, setGrantBusy] = useState(false)

  const loadRooms = useCallback(async () => {
    const res = await fetch('/api/admin/rooms')
    if (res.status === 401) {
      setAuthed(false)
      return
    }
    const body = (await res.json()) as { rooms: AdminRoom[] }
    setRooms(body.rooms)
  }, [])

  const loadRequests = useCallback(async () => {
    const res = await fetch('/api/admin/room-requests')
    if (res.status === 401) {
      setAuthed(false)
      return
    }
    const body = (await res.json()) as { requests: AdminRoomRequest[] }
    setRequests(body.requests)
  }, [])

  const loadApproval = useCallback(async () => {
    const res = await fetch('/api/admin/approval')
    if (res.status === 401) return
    const body = (await res.json()) as { enabled: boolean }
    setApprovalEnabled(body.enabled)
  }, [])

  const loadCleanConfig = useCallback(async () => {
    const res = await fetch('/api/admin/auto-clean')
    if (res.status === 401) return
    const body = (await res.json()) as AutoCleanConfig
    setCleanConfig(body)
    setCleanDaysInput(String(body.days))
  }, [])

  const loadE2e = useCallback(async () => {
    const res = await fetch('/api/admin/e2e')
    if (res.status === 401) return
    const body = (await res.json()) as { enabled: boolean }
    setE2eEnabled(body.enabled)
  }, [])

  useEffect(() => {
    void (async () => {
      const res = await fetch('/api/admin/session')
      const body = (await res.json()) as { authenticated: boolean }
      setAuthed(body.authenticated)
      if (body.authenticated) {
        void loadRooms()
        void loadRequests()
        void loadApproval()
        void loadCleanConfig()
        void loadE2e()
      }
    })()
  }, [loadRooms, loadRequests, loadApproval, loadCleanConfig])

  // 待审列表轮询：管理后台无 WS 连接，15 秒自动刷新以便及时看到新申请
  useEffect(() => {
    if (!authed) return
    const timer = setInterval(() => void loadRequests(), 15_000)
    return () => clearInterval(timer)
  }, [authed, loadRequests])

  const login = async (password: string) => {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    })
    if (res.ok) {
      setAuthed(true)
      void loadRooms()
      void loadRequests()
      void loadApproval()
      void loadCleanConfig()
      void loadE2e()
      return
    }
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? '登录失败')
  }

  const logout = async () => {
    await fetch('/api/admin/logout', { method: 'POST' })
    setAuthed(false)
    setRooms(null)
    setRequests(null)
    setCleanConfig(null)
  }

  const deleteRoom = async (roomId: number, name: string) => {
    const res = await fetch(`/api/admin/rooms/${roomId}`, { method: 'DELETE' })
    if (!res.ok) {
      toast.error(`删除房间 ${name} 失败`)
      return
    }
    toast.success(`已删除房间 ${name}`)
    void loadRooms()
  }

  /** 房间级加密开关：放开=该房间恢复原有可见性（授权/申请随之失效）；仅总开关开启时可设置 */
  const toggleRoomEncryption = async (room: AdminRoom, encrypted: boolean) => {
    const res = await fetch(`/api/admin/rooms/${room.id}/encryption`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ encrypted }),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      toast.error(body.error ?? '切换失败')
      return
    }
    setRooms((prev) => (prev ? prev.map((r) => (r.id === room.id ? { ...r, encrypted } : r)) : prev))
    toast.success(encrypted ? `「${room.name}」已开启加密：历史隔离与授权生效` : `「${room.name}」已放开加密：恢复原有可见性`)
  }

  /** 审批操作：批准建房会真正创建房间，两个列表都刷新 */
  const handleRequest = async (request: AdminRoomRequest, action: 'approve' | 'reject') => {
    setActingId(request.id)
    try {
      const res = await fetch(`/api/admin/room-requests/${request.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        toast.error(body.error ?? '操作失败')
      } else if (action === 'approve') {
        toast.success(request.kind === 'create' ? `已同意建房，房间「${request.roomName}」已创建` : `已同意 ${request.peerName ?? '节点'} 加入「${request.roomName}」`)
      } else {
        toast.success(`已拒绝该${request.kind === 'create' ? '建房' : '加入'}申请`)
      }
    } finally {
      setActingId(null)
      void loadRequests()
      void loadRooms()
    }
  }

  const toggleApproval = async (enabled: boolean) => {
    const res = await fetch('/api/admin/approval', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    })
    if (!res.ok) {
      toast.error('切换审批开关失败')
      return
    }
    setApprovalEnabled(enabled)
    toast.success(enabled ? '已开启审批：建房需管理员同意' : '已关闭审批：建房恢复自由模式（加入始终自由）')
  }

  /** 定时清理开关：即时生效 */
  const toggleCleanEnabled = async (enabled: boolean) => {
    const res = await fetch('/api/admin/auto-clean', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    })
    if (!res.ok) {
      toast.error('切换定时清理开关失败')
      return
    }
    const body = (await res.json()) as AutoCleanConfig
    setCleanConfig(body)
    toast.success(enabled ? `已开启定时清理：每 ${body.days} 天全量清空一次` : '已关闭定时清理')
  }

  /** 保存清理周期天数 */
  const saveCleanDays = async () => {
    setCleanSaving(true)
    try {
      const res = await fetch('/api/admin/auto-clean', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ days: Number(cleanDaysInput) }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        toast.error(body.error ?? '保存失败')
        return
      }
      const body = (await res.json()) as AutoCleanConfig
      setCleanConfig(body)
      setCleanDaysInput(String(body.days))
      toast.success(`清理周期已设为每 ${body.days} 天一次`)
    } finally {
      setCleanSaving(false)
    }
  }

  /** 立即执行一次全量清理（AlertDialog 确认后调用） */
  const runCleanNow = async () => {
    setCleanRunning(true)
    try {
      const res = await fetch('/api/admin/auto-clean/run', { method: 'POST' })
      if (!res.ok) {
        toast.error('清理执行失败')
        return
      }
      const body = (await res.json()) as { messages: number; rooms: number; files: number }
      void loadRooms()
      void loadRequests()
    } finally {
      setCleanRunning(false)
    }
  }

  /** 端到端加密显示总开关：即时生效 */
  const toggleE2e = async (enabled: boolean) => {
    const res = await fetch('/api/admin/e2e', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    })
    if (!res.ok) {
      toast.error('切换端到端加密开关失败')
      return
    }
    setE2eEnabled(enabled)
    toast.success(
      enabled
        ? '已开启端到端加密显示：房间历史仅成员（加入后）/房主/授权者可见'
        : '已关闭端到端加密显示：恢复原有可见性',
    )
  }

  /** 打开历史授权弹窗：拉取节点全量列表与该房间现有授权 */
  const openGrants = async (room: AdminRoom) => {
    setGrantRoom(room)
    setGrantPeerId('')
    setGrantPeers([])
    setGrantList([])
    const [peersRes, grantsRes] = await Promise.all([
      fetch('/api/admin/peers'),
      fetch(`/api/admin/rooms/${room.id}/view-grants`),
    ])
    if (peersRes.ok) {
      setGrantPeers(((await peersRes.json()) as { peers: { id: string; name: string }[] }).peers)
    }
    if (grantsRes.ok) {
      setGrantList(((await grantsRes.json()) as { grants: ViewGrant[] }).grants)
    }
  }

  const grantAccess = async () => {
    if (!grantRoom || !grantPeerId) return
    setGrantBusy(true)
    try {
      const res = await fetch(`/api/admin/rooms/${grantRoom.id}/view-grants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ peerId: grantPeerId }),
      })
      if (!res.ok) {
        toast.error('授权失败')
        return
      }
      setGrantList(((await res.json()) as { grants: ViewGrant[] }).grants)
      setGrantPeerId('')
      toast.success('已授权，该节点无需加入即可查看全部历史')
    } finally {
      setGrantBusy(false)
    }
  }

  const revokeAccess = async (peerId: string) => {
    if (!grantRoom) return
    const res = await fetch(`/api/admin/rooms/${grantRoom.id}/view-grants?peerId=${encodeURIComponent(peerId)}`, {
      method: 'DELETE',
    })
    if (!res.ok) {
      toast.error('撤销失败')
      return
    }
    setGrantList(((await res.json()) as { grants: ViewGrant[] }).grants)
    toast.success('已撤销授权')
  }

  if (authed === null) {
    return (
      <div className="flex h-dvh items-center justify-center">
        <Loader2Icon className="size-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!authed) {
    return (
      <div className="flex h-dvh items-center justify-center bg-chat p-4">
        <LoginForm onLogin={login} />
      </div>
    )
  }

  return (
    <div className="flex h-dvh flex-col bg-chat">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-white/[0.06] px-3 md:px-4">
        <Button variant="ghost" size="icon-sm" aria-label="返回聊天" asChild>
          <Link href="/">
            <ArrowLeftIcon />
          </Link>
        </Button>
        <ShieldIcon className="size-4 text-muted-foreground" />
        <h1 className="flex-1 truncate font-semibold">管理中心</h1>
        <Button variant="ghost" size="sm" onClick={() => void logout()}>
          退出登录
        </Button>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 font-semibold">
              房间审批
              {requests != null && requests.length > 0 && (
                <Badge variant="default" className="text-xs">{requests.length} 待审</Badge>
              )}
            </h2>
            <span className="flex flex-wrap items-center justify-end gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span className="flex items-center gap-2">
                {approvalEnabled != null && (approvalEnabled ? '建房需审批 · 加入自由' : '自由建房（加入始终自由）')}
                <Switch
                  checked={approvalEnabled ?? false}
                  disabled={approvalEnabled == null}
                  onCheckedChange={(checked) => void toggleApproval(checked)}
                  aria-label="房间审批开关"
                />
              </span>
              <span className="flex items-center gap-2">
                端到端加密
                <Switch
                  checked={e2eEnabled ?? false}
                  disabled={e2eEnabled == null}
                  onCheckedChange={(checked) => void toggleE2e(checked)}
                  aria-label="端到端加密显示开关"
                />
              </span>
            </span>
          </div>
          {requests === null ? (
            <div className="flex flex-col gap-2">
              {[0, 1].map((i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : requests.length === 0 ? (
            <p className="rounded-lg border bg-sidebar py-8 text-center text-sm text-muted-foreground">
              暂无待审批申请
            </p>
          ) : (
            <div className="rounded-lg border bg-sidebar">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">类型</TableHead>
                    <TableHead>申请人</TableHead>
                    <TableHead>房间</TableHead>
                    <TableHead>申请时间</TableHead>
                    <TableHead className="pr-4 text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {requests.map((request) => (
                    <TableRow key={request.id}>
                      <TableCell className="pl-4">
                        <Badge variant={request.kind === 'create' ? 'default' : request.kind === 'view' ? 'outline' : 'secondary'}>
                          {request.kind === 'create' ? '建房' : request.kind === 'view' ? '查看历史' : '加入'}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {request.peerName ?? <Badge variant="secondary">未知节点</Badge>}
                      </TableCell>
                      <TableCell className="font-medium">
                        <span className="flex items-center gap-1.5">
                          <span className="text-muted-foreground">#</span>
                          {request.roomName}
                        </span>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{formatDateTime(request.createdAt)}</TableCell>
                      <TableCell className="pr-4 text-right">
                        <span className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={actingId === request.id}
                            onClick={() => void handleRequest(request, 'approve')}
                          >
                            {actingId === request.id ? (
                              <Loader2Icon data-icon="inline-start" className="animate-spin" />
                            ) : (
                              <CheckIcon data-icon="inline-start" />
                            )}
                            通过
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-muted-foreground hover:text-destructive"
                            disabled={actingId === request.id}
                            onClick={() => void handleRequest(request, 'reject')}
                          >
                            <XIcon data-icon="inline-start" />
                            拒绝
                          </Button>
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          <div className="flex items-baseline justify-between">
            <h2 className="font-semibold">房间管理</h2>
            <span className="text-xs text-muted-foreground">删除房间会一并移除其成员与历史消息</span>
          </div>
          {rooms === null ? (
            <div className="flex flex-col gap-2">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : rooms.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">还没有房间</p>
          ) : (
            <div className="rounded-lg border bg-sidebar">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">名称</TableHead>
                    <TableHead>创建者</TableHead>
                    <TableHead>成员</TableHead>
                    <TableHead>消息数</TableHead>
                    <TableHead>创建时间</TableHead>
                    <TableHead>加密</TableHead>
                    <TableHead className="pr-4 text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rooms.map((room) => (
                    <TableRow key={room.id}>
                      <TableCell className="pl-4 font-medium">
                        <span className="flex items-center gap-1.5">
                          <span className="text-muted-foreground">#</span>
                          {room.name}
                        </span>
                      </TableCell>
                      <TableCell>
                        {room.creatorName ? (
                          room.creatorName
                        ) : (
                          <Badge variant="secondary">未知</Badge>
                        )}
                      </TableCell>
                      <TableCell>{room.memberCount}</TableCell>
                      <TableCell>{room.messageCount}</TableCell>
                      <TableCell className="text-muted-foreground">{formatDateTime(room.createdAt)}</TableCell>
                      <TableCell>
                        {/* 联动：端到端加密总开关开启才可设置房间级开关 */}
                        <Switch
                          checked={room.encrypted}
                          disabled={e2eEnabled !== true}
                          onCheckedChange={(checked) => void toggleRoomEncryption(room, checked)}
                          aria-label={`${room.encrypted ? '关闭' : '开启'} ${room.name} 的加密`}
                        />
                      </TableCell>
                      <TableCell className="pr-4 text-right">
                        <span className="flex justify-end gap-0.5">
                          {/* 联动：仅「总开关开 + 该房间加密中」时授权有意义 */}
                          {e2eEnabled && room.encrypted && (
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`管理 ${room.name} 的历史查看授权`}
                              className="text-muted-foreground hover:text-foreground"
                              onClick={() => void openGrants(room)}
                            >
                              <KeyRoundIcon />
                            </Button>
                          )}
                          <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button variant="ghost" size="icon-sm" aria-label={`删除房间 ${room.name}`} className="text-muted-foreground hover:text-destructive">
                              <TrashIcon />
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>删除房间 #{room.name}？</AlertDialogTitle>
                              <AlertDialogDescription>
                                将同时删除 {room.memberCount} 名成员的会话入口与 {room.messageCount} 条历史消息，操作不可撤销。
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>取消</AlertDialogCancel>
                              <AlertDialogAction variant="destructive" onClick={() => void deleteRoom(room.id, room.name)}>
                                删除
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          <div className="flex items-baseline justify-between">
            <h2 className="font-semibold">数据清理</h2>
            <span className="text-xs text-muted-foreground">
              上次清理：{cleanConfig?.lastRun != null ? formatDateTime(cleanConfig.lastRun) : '从未执行'}
            </span>
          </div>
          <div className="flex flex-col gap-3 rounded-lg border bg-sidebar p-4">
            <p className="text-sm text-muted-foreground">
              开启后每隔指定天数自动清空全部聊天记录、会话、房间（含待审批申请）与上传文件（含磁盘占用）；节点身份与管理配置保留，清理不可恢复。
            </p>
            {cleanConfig === null ? (
              <Skeleton className="h-9 w-full" />
            ) : (
              <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
                <span className="flex items-center gap-2 text-sm">
                  <Switch
                    checked={cleanConfig.enabled}
                    onCheckedChange={(checked) => void toggleCleanEnabled(checked)}
                    aria-label="定时清理开关"
                  />
                  {cleanConfig.enabled ? '已开启' : '已关闭'}
                </span>
                <span className="flex items-center gap-2 text-sm">
                  每
                  <Input
                    type="number"
                    min={1}
                    max={3650}
                    value={cleanDaysInput}
                    onChange={(e) => setCleanDaysInput(e.target.value)}
                    className="h-8 w-20"
                    aria-label="清理周期天数"
                  />
                  天清理一次
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={cleanSaving || cleanDaysInput === String(cleanConfig.days)}
                    onClick={() => void saveCleanDays()}
                  >
                    保存
                  </Button>
                </span>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button size="sm" variant="destructive" disabled={cleanRunning} className="ml-auto">
                      {cleanRunning && <Loader2Icon data-icon="inline-start" className="animate-spin" />}
                      立即清理
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>立即清空全部聊天数据与房间？</AlertDialogTitle>
                      <AlertDialogDescription>
                        将删除所有聊天记录、会话、房间与上传文件（含磁盘占用），操作不可恢复。在线用户的列表会自动刷新。
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>取消</AlertDialogCancel>
                      <AlertDialogAction variant="destructive" onClick={() => void runCleanNow()}>
                        确认清理
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            )}
          </div>
        </div>
      </main>

      {/* 历史查看授权弹窗：选择节点授予/撤销某房间的全量明文查看权限 */}
      <Dialog open={grantRoom !== null} onOpenChange={(open) => !open && setGrantRoom(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>「{grantRoom?.name}」历史查看授权</DialogTitle>
            <DialogDescription>
              被授权节点无需加入房间即可查看全部明文消息（端到端加密显示开启时生效）；房主天然拥有全部权限。
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2">
            <select
              value={grantPeerId}
              onChange={(e) => setGrantPeerId(e.target.value)}
              aria-label="选择节点"
              className="h-9 flex-1 rounded-md border bg-background px-2 text-sm outline-none"
            >
              <option value="">选择节点…</option>
              {grantPeers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <Button size="sm" disabled={!grantPeerId || grantBusy} onClick={() => void grantAccess()}>
              授权
            </Button>
          </div>
          <div className="mt-1 flex flex-col gap-1.5">
            {grantList.length === 0 ? (
              <p className="py-2 text-center text-xs text-muted-foreground">暂无授权节点</p>
            ) : (
              grantList.map((g) => (
                <div key={g.peerId} className="flex items-center justify-between rounded-md border px-3 py-1.5 text-sm">
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="truncate">{g.peerName ?? '未知节点'}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{formatDateTime(g.grantedAt)}</span>
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
                    onClick={() => void revokeAccess(g.peerId)}
                  >
                    撤销
                  </Button>
                </div>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
