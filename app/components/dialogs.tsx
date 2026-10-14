'use client'

import { Button } from '@components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@components/ui/dialog'
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@components/ui/field'
import { Input } from '@components/ui/input'
import type { CenterInfo } from '../types'

interface CreateRoomDialogProps {
  visible: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (name: string) => void
  /** 房间审批开关：开启时提交的是申请，管理员批准后房间才创建 */
  approvalEnabled?: boolean
}

export function CreateRoomDialog({ visible, onOpenChange, onSubmit, approvalEnabled = false }: CreateRoomDialogProps) {
  return (
    <Dialog open={visible} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            const input = (e.currentTarget.elements.namedItem('room-name') as HTMLInputElement)
            onSubmit(input.value)
          }}
        >
          <DialogHeader>
            <DialogTitle>{approvalEnabled ? '申请创建房间' : '创建房间'}</DialogTitle>
            <DialogDescription>
              {approvalEnabled
                ? '提交后需管理员审批，通过后房间才会创建并自动进入。'
                : '房间对中心内所有节点公开，可自由加入。'}
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-2">
            <Field>
              <FieldLabel htmlFor="room-name">房间名称</FieldLabel>
              <Input
                id="room-name"
                name="room-name"
                placeholder="例如：周末开黑"
                maxLength={50}
                autoFocus
              />
              <FieldDescription>
                {approvalEnabled ? '1-50 个字符，通过审批后自动进入。' : '1-50 个字符，创建后自动进入。'}
              </FieldDescription>
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="submit">{approvalEnabled ? '提交申请' : '创建并进入'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

interface QrDialogProps {
  visible: boolean
  onOpenChange: (open: boolean) => void
  centerInfo: CenterInfo | null
}

export function QrDialog({ visible, onOpenChange, centerInfo }: QrDialogProps) {
  const copyUrl = async () => {
    if (!centerInfo) return
    await navigator.clipboard?.writeText(centerInfo.lanUrl)
  }

  return (
    <Dialog open={visible} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>手机扫码加入</DialogTitle>
          <DialogDescription>
            同一局域网内的节点扫码即可直接进入，无需安装与登录。
          </DialogDescription>
        </DialogHeader>
        {centerInfo && (
          <div className="flex flex-col items-center gap-3 py-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={centerInfo.qrDataUrl}
              alt="服务中心二维码"
              className="size-52 rounded-lg bg-white p-2"
            />
            <Button variant="secondary" size="sm" onClick={() => void copyUrl()}>
              复制地址 {centerInfo.lanUrl}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
