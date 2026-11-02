import { Capacitor } from '@capacitor/core'
import { db } from '../db/db'
import { getMeta, setMeta } from '../db/settings'

/** True inside the iOS app built with Capacitor (false in Safari / the PWA). */
export function isNative(): boolean {
  return Capacitor.isNativePlatform()
}

export async function applyStatusBar(theme: 'light' | 'dark'): Promise<void> {
  if (!isNative()) return
  try {
    const { StatusBar, Style } = await import('@capacitor/status-bar')
    // Style.Dark = light text, for dark backgrounds.
    await StatusBar.setStyle({ style: theme === 'dark' ? Style.Dark : Style.Light })
  } catch {
    /* plugin unavailable */
  }
}

/** Folder inside the app's Documents (visible in Files → On My iPhone → Mnemo). */
export const BACKUP_DIR = 'Backups'
const KEEP = 10
const DAY = 86_400_000

function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

async function writeBlob(path: string, blob: Blob): Promise<void> {
  const { Filesystem, Directory } = await import('@capacitor/filesystem')
  // Chunks of 3 MiB keep base64 boundaries aligned and memory use flat.
  const CHUNK = 3 * 1024 * 1024
  const bytes = new Uint8Array(await blob.arrayBuffer())
  for (let off = 0; off < Math.max(1, bytes.length); off += CHUNK) {
    const data = toBase64(bytes.subarray(off, off + CHUNK))
    if (off === 0) await Filesystem.writeFile({ path, data, directory: Directory.Documents, recursive: true })
    else await Filesystem.appendFile({ path, data, directory: Directory.Documents })
  }
}

async function prune(): Promise<void> {
  const { Filesystem, Directory } = await import('@capacitor/filesystem')
  const { files } = await Filesystem.readdir({ path: BACKUP_DIR, directory: Directory.Documents })
  const auto = files.map((f) => f.name).filter((n) => n.startsWith('mnemo-auto-')).sort()
  for (const name of auto.slice(0, Math.max(0, auto.length - KEEP))) {
    await Filesystem.deleteFile({ path: `${BACKUP_DIR}/${name}`, directory: Directory.Documents })
  }
}

export interface AutoBackupStatus {
  lastAt: number
  files: number
}

export async function autoBackupStatus(): Promise<AutoBackupStatus> {
  const lastAt = await getMeta<number>('autoBackupAt', 0)
  if (!isNative()) return { lastAt, files: 0 }
  try {
    const { Filesystem, Directory } = await import('@capacitor/filesystem')
    const { files } = await Filesystem.readdir({ path: BACKUP_DIR, directory: Directory.Documents })
    return { lastAt, files: files.filter((f) => f.name.startsWith('mnemo-auto-')).length }
  } catch {
    return { lastAt, files: 0 }
  }
}

let running: Promise<string | null> | null = null

/**
 * Daily automatic backup into the app's Documents folder (native app only).
 * The Mac-side reinstall script copies this folder off the phone before every reinstall.
 */
export function autoBackup(force = false): Promise<string | null> {
  if (!isNative()) return Promise.resolve(null)
  running ??= (async () => {
    try {
      const last = await getMeta<number>('autoBackupAt', 0)
      if (!force && Date.now() - last < DAY * 0.9) return null
      if ((await db.cards.count()) === 0) return null
      const { exportBackup } = await import('../import/backup')
      const blob = await exportBackup()
      const d = new Date()
      const p = (n: number) => String(n).padStart(2, '0')
      const name = `mnemo-auto-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.zip`
      await writeBlob(`${BACKUP_DIR}/${name}`, blob)
      await setMeta('autoBackupAt', Date.now())
      await prune()
      return name
    } finally {
      running = null
    }
  })()
  return running
}

/** Start background duties of the native app: backups on launch and on return to the app. */
export async function startNativeServices(): Promise<void> {
  if (!isNative()) return
  setTimeout(() => void autoBackup().catch(() => {}), 4000)
  try {
    const { App } = await import('@capacitor/app')
    await App.addListener('appStateChange', ({ isActive }) => {
      if (isActive) void autoBackup().catch(() => {})
    })
  } catch {
    /* plugin unavailable */
  }
}
