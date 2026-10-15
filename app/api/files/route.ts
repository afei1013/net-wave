import busboy from 'busboy'
import { NextResponse } from 'next/server'
import { Readable } from 'node:stream'
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web'
import { requirePeerId } from '@/api-auth'
import { saveFileStream } from '@/files'

/** 去路径、控制字符与过长部分，避免落库异常文件名 */
function sanitizeFilename(raw: string): string {
  const base = raw.split(/[/\\]/).pop() ?? ''
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return cleaned.slice(0, 200) || '未命名文件'
}

export async function POST(request: Request) {
  const peerId = await requirePeerId()
  if (!peerId) {
    return NextResponse.json({ error: '未识别的节点身份' }, { status: 401 })
  }

  const bb = busboy({
    headers: { 'content-type': request.headers.get('content-type') ?? '' },
    defParamCharset: 'utf-8',
    limits: { files: 1 },
  })

  // 非文件字段（上传端探测的媒体宽高）。multipart 顺序解析：字段在客户端一律
  // 置于文件之前，故 file 事件触发时字段必然已全部收集，无需等待 finish/close
  // （busboy 的 close 要等文件流消费完才触发，先等它再消费流会死锁）
  const fields = new Map<string, string>()
  bb.on('field', (name, value) => {
    if (fields.size < 8) fields.set(name, value)
  })

  const part = new Promise<{ stream: Readable; name: string; mime: string } | null>((resolve, reject) => {
    let settled = false
    bb.on('file', (_field, stream, info) => {
      if (settled) {
        stream.resume()
        return
      }
      settled = true
      resolve({
        stream,
        name: sanitizeFilename(info.filename),
        mime: info.mimeType || 'application/octet-stream',
      })
    })
    bb.on('error', reject)
    const finishWithoutFile = () => {
      if (!settled) resolve(null)
    }
    bb.on('finish', finishWithoutFile)
    bb.on('close', finishWithoutFile)
  })

  Readable.fromWeb(request.body as unknown as NodeWebReadableStream).pipe(bb)

  const file = await part
  if (!file) {
    return NextResponse.json({ error: '缺少文件字段' }, { status: 400 })
  }
  // 媒体宽高：整数且在合理范围内才采信（客户端探测，非安全边界）
  const dim = (key: 'width' | 'height') => {
    const n = Number(fields.get(key))
    return Number.isInteger(n) && n > 0 && n <= 30_000 ? n : null
  }
  const width = dim('width')
  const height = dim('height')
  const dims = width != null && height != null ? { width, height } : null
  try {
    const meta = await saveFileStream(file.stream, file.name, file.mime, peerId, dims)
    return NextResponse.json({ fileId: meta.id, name: meta.name, size: meta.size, mime: meta.mime, kind: meta.kind })
  } catch (err) {
    console.error('文件保存失败', err)
    return NextResponse.json({ error: '文件保存失败' }, { status: 500 })
  }
}
