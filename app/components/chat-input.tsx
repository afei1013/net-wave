'use client'

import { useEffect, useRef, useState } from 'react'
import { PlusIcon, SendHorizontalIcon, SmileIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@components/ui/button'
import { Spinner } from '@components/ui/spinner'
import { EmojiPicker } from './emoji-picker'
import { UploadConfirmDialog, type PendingUpload } from './upload-confirm-dialog'

interface UploadTask {
  key: number
  name: string
  progress: number
}

interface ChatInputProps {
  placeholder: string
  onSendText: (text: string) => void
  onSendFile: (fileId: string) => void
}

/**
 * Discord 式输入条：+ 选择附件与粘贴文件先进上传确认弹窗（汇总可剔除，ADR-0004）、
 * 确认后 XHR 实时进度上传，完成后立即作为消息发出、Enter 发送 / Shift+Enter 换行（兼容中文输入法组词态）、
 * 文本非空时出现发送按钮。
 */
export function ChatInput({ placeholder, onSendText, onSendFile }: ChatInputProps) {
  const [text, setText] = useState('')
  const [uploads, setUploads] = useState<UploadTask[]>([])
  const [pending, setPending] = useState<PendingUpload[]>([])
  const [emojiOpen, setEmojiOpen] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const uploadKeyRef = useRef(0)
  // 表情面板的外点关闭判定范围：输入条 + 面板整体
  const rootRef = useRef<HTMLDivElement>(null)

  // 面板打开时：点击外部或 Escape 关闭
  useEffect(() => {
    if (!emojiOpen) return
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setEmojiOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setEmojiOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [emojiOpen])

  const autoResize = () => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 192)}px`
  }

  /** 表情插入输入框当前光标处（微信式：不直接发送，面板保持打开可连续选择） */
  const insertEmoji = (emoji: string) => {
    const el = textareaRef.current
    if (!el) {
      setText((prev) => prev + emoji)
      return
    }
    const start = el.selectionStart ?? text.length
    const end = el.selectionEnd ?? start
    const next = text.slice(0, start) + emoji + text.slice(end)
    setText(next)
    // 等 React 提交新值后恢复焦点与光标（到插入内容之后），并按新内容自适应高度
    requestAnimationFrame(() => {
      el.focus()
      const pos = start + emoji.length
      el.setSelectionRange(pos, pos)
      autoResize()
    })
  }

  const send = () => {
    const trimmed = text.trim()
    if (!trimmed) return
    onSendText(trimmed)
    setText('')
    requestAnimationFrame(autoResize)
  }

  /**
   * 上传前探测媒体宽高（随表单提交存库；渲染端据此预留纵横比，避免消息流布局抖动）。
   * 探测失败不阻断上传（尺寸留空，退回加载后再撑开的旧行为）。
   */
  const probeMediaSize = (file: File): Promise<{ width: number; height: number } | null> =>
    new Promise((resolve) => {
      if (file.type.startsWith('image/')) {
        createImageBitmap(file)
          .then((bmp) => resolve({ width: bmp.width, height: bmp.height }))
          .catch(() => resolve(null))
        return
      }
      if (file.type.startsWith('video/')) {
        const url = URL.createObjectURL(file)
        const video = document.createElement('video')
        video.preload = 'metadata'
        video.onloadedmetadata = () => {
          URL.revokeObjectURL(url)
          resolve(video.videoWidth > 0 && video.videoHeight > 0 ? { width: video.videoWidth, height: video.videoHeight } : null)
        }
        video.onerror = () => {
          URL.revokeObjectURL(url)
          resolve(null)
        }
        video.src = url
        return
      }
      resolve(null)
    })

  const uploadFile = async (file: File) => {
    const key = ++uploadKeyRef.current
    setUploads((prev) => [...prev, { key, name: file.name, progress: 0 }])
    const form = new FormData()
    // 宽高字段放在文件前：服务端无需等待即可在解析完表单后读取
    const dims = await probeMediaSize(file)
    if (dims) {
      form.append('width', String(dims.width))
      form.append('height', String(dims.height))
    }
    form.append('file', file)
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api/files')
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const percent = Math.round((e.loaded / e.total) * 100)
        setUploads((prev) => prev.map((u) => (u.key === key ? { ...u, progress: percent } : u)))
      }
    }
    xhr.onload = () => {
      setUploads((prev) => prev.filter((u) => u.key !== key))
      if (xhr.status === 200) {
        try {
          const body = JSON.parse(xhr.responseText) as { fileId?: string }
          if (body.fileId) {
            onSendFile(body.fileId)
            return
          }
        } catch {
          // 响应非预期 JSON，落入下方失败提示
        }
      }
      toast.error(`「${file.name}」上传失败`)
    }
    xhr.onerror = () => {
      setUploads((prev) => prev.filter((u) => u.key !== key))
      toast.error(`「${file.name}」上传失败`)
    }
    xhr.send(form)
  }

  /** 待发清单：选择器与粘贴入口都先进确认弹窗，确认后才真正上传 */
  const enqueuePending = (files: File[]) => {
    if (files.length === 0) return
    setPending((prev) => [...prev, ...files.map((file) => ({ key: ++uploadKeyRef.current, file }))])
  }

  const confirmPending = (files: File[]) => {
    setPending([])
    for (const file of files) void uploadFile(file)
  }

  const onPickFiles = (files: FileList | null) => {
    if (!files) return
    enqueuePending(Array.from(files))
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  return (
    <div className="px-4 pb-5" ref={rootRef}>
      {uploads.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {uploads.map((u) => (
            <span
              key={u.key}
              className="inline-flex items-center gap-2 rounded-lg bg-secondary px-3 py-1.5 text-xs text-secondary-foreground"
            >
              <Spinner className="size-3" />
              <span className="max-w-40 truncate">{u.name}</span>
              <span className="text-muted-foreground">{u.progress}%</span>
            </span>
          ))}
        </div>
      )}
      <div className="relative flex items-end gap-1 rounded-3xl bg-secondary px-2 py-1.5">
        {emojiOpen && (
          <div className="absolute bottom-full left-0 z-10 mb-2">
            <EmojiPicker onPick={insertEmoji} />
          </div>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          className="rounded-full text-muted-foreground hover:text-foreground"
          onClick={() => fileInputRef.current?.click()}
          aria-label="上传附件"
        >
          <PlusIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="rounded-full text-muted-foreground hover:text-foreground"
          onClick={() => setEmojiOpen((open) => !open)}
          aria-label="表情"
          aria-expanded={emojiOpen}
        >
          <SmileIcon />
        </Button>
        <textarea
          ref={textareaRef}
          rows={1}
          value={text}
          placeholder={placeholder}
          aria-label="输入消息"
          className="max-h-48 flex-1 resize-none self-center bg-transparent px-1 py-1.5 text-[15px] outline-none placeholder:text-muted-foreground"
          onChange={(e) => {
            setText(e.target.value)
            autoResize()
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              send()
            }
          }}
          onPaste={(e) => {
            // 粘贴板里的文件（截图、复制的图片/视频/文件）同样先进确认弹窗，防手滑误发
            const files = e.clipboardData?.files
            if (files && files.length > 0) {
              e.preventDefault()
              enqueuePending(Array.from(files))
            }
          }}
        />
        {text.trim() !== '' && (
          <Button
            size="icon-sm"
            className="mb-0.5 shrink-0 rounded-full"
            onClick={send}
            aria-label="发送"
          >
            <SendHorizontalIcon />
          </Button>
        )}
      </div>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => onPickFiles(e.target.files)}
      />
      <UploadConfirmDialog
        pending={pending}
        onConfirm={confirmPending}
        onCancel={() => setPending([])}
      />
    </div>
  )
}
