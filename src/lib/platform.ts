export function isIOS(): boolean {
  const ua = navigator.userAgent
  return /iPhone|iPad|iPod/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1)
}

export function isStandalone(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean }
  return nav.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches === true
}

export function isApplePlatform(): boolean {
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent)
}

export function hasTouch(): boolean {
  return navigator.maxTouchPoints > 0
}

/** Share a file through the system sheet (iOS: «Сохранить в Файлы»), or download it. */
export async function shareOrDownload(blob: Blob, filename: string): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' })
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean }
  if (isIOS() && nav.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename })
      return 'shared'
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return 'cancelled'
    }
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
  return 'downloaded'
}

/** Open a file picker and resolve with the chosen file (null when cancelled). */
export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.style.display = 'none'
    let settled = false
    input.addEventListener('change', () => {
      settled = true
      resolve(input.files?.[0] ?? null)
      input.remove()
    })
    input.addEventListener('cancel', () => {
      if (!settled) resolve(null)
      input.remove()
    })
    document.body.appendChild(input)
    input.click()
  })
}
