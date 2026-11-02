import { db } from './db'

const urlCache = new Map<string, string>()
const pending = new Map<string, Promise<string | null>>()

const EXT_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  heic: 'image/heic',
  bmp: 'image/bmp',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  webm: 'audio/webm',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  ttf: 'font/ttf',
  otf: 'font/otf',
  woff: 'font/woff',
  woff2: 'font/woff2',
  css: 'text/css',
}

export function mimeFromName(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return EXT_MIME[ext] ?? 'application/octet-stream'
}

async function sha1Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', data)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Store a file in the media library; identical content is stored once. Returns its name. */
export async function saveMedia(blob: Blob, ext: string): Promise<string> {
  const buf = await blob.arrayBuffer()
  const name = `mn-${(await sha1Hex(buf)).slice(0, 16)}.${ext}`
  if (!(await db.media.get(name))) {
    await db.media.put({ name, blob, type: blob.type || mimeFromName(name), size: blob.size, createdAt: Date.now() })
  }
  return name
}

export async function putMediaFile(name: string, data: Blob | Uint8Array): Promise<void> {
  const type = mimeFromName(name)
  const blob = data instanceof Blob ? data : new Blob([data as BlobPart], { type })
  await db.media.put({ name, blob, type: blob.type || type, size: blob.size, createdAt: Date.now() })
  const old = urlCache.get(name)
  if (old) {
    URL.revokeObjectURL(old)
    urlCache.delete(name)
  }
}

/** Object URL for a stored media file (cached), or null when missing. */
export function mediaUrl(name: string): Promise<string | null> {
  const hit = urlCache.get(name)
  if (hit) return Promise.resolve(hit)
  let p = pending.get(name)
  if (!p) {
    p = db.media.get(name).then((m) => {
      pending.delete(name)
      if (!m) return null
      const url = URL.createObjectURL(m.blob)
      urlCache.set(name, url)
      return url
    })
    pending.set(name, p)
  }
  return p
}

export function isExternalSrc(src: string): boolean {
  return /^(https?:|data:|blob:)/i.test(src)
}

/** Downscale photos before storing them: phones produce 4000px images that bloat storage. */
export async function prepareImage(file: File, maxSide = 1600): Promise<{ blob: Blob; ext: string }> {
  if (file.type === 'image/gif' || file.type === 'image/svg+xml') {
    return { blob: file, ext: file.type === 'image/gif' ? 'gif' : 'svg' }
  }
  try {
    const bmp = await createImageBitmap(file)
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height))
    const w = Math.round(bmp.width * scale)
    const h = Math.round(bmp.height * scale)
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, w, h)
    bmp.close()
    const isPng = file.type === 'image/png'
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, isPng ? 'image/png' : 'image/jpeg', 0.85))
    if (blob && blob.size < file.size) return { blob, ext: isPng ? 'png' : 'jpg' }
  } catch {
    /* fall back to the original file */
  }
  const ext = file.name.split('.').pop()?.toLowerCase() || 'jpg'
  return { blob: file, ext }
}

/** Editor: turn stored media names into displayable object URLs (original name kept in data-media). */
export async function hydrateMediaHtml(html: string): Promise<string> {
  const tpl = document.createElement('template')
  tpl.innerHTML = html
  const imgs = [...tpl.content.querySelectorAll('img')]
  await Promise.all(
    imgs.map(async (img) => {
      const src = img.getAttribute('src') ?? ''
      if (!src || isExternalSrc(src)) return
      const url = await mediaUrl(safeDecode(src)).catch(() => null)
      if (url) {
        img.setAttribute('data-media', src)
        img.setAttribute('src', url)
      }
    }),
  )
  return tpl.innerHTML
}

/** Editor: turn object URLs back into media names before saving. */
export function dehydrateMediaHtml(html: string): string {
  const tpl = document.createElement('template')
  tpl.innerHTML = html
  for (const img of tpl.content.querySelectorAll('img[data-media]')) {
    img.setAttribute('src', img.getAttribute('data-media')!)
    img.removeAttribute('data-media')
  }
  return tpl.innerHTML
}

export function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

export async function mediaUsage(): Promise<{ count: number; bytes: number }> {
  let count = 0
  let bytes = 0
  await db.media.each((m) => {
    count++
    bytes += m.size
  })
  return { count, bytes }
}
