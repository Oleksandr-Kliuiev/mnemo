import { useLiveQuery } from 'dexie-react-hooks'
import { db } from './db'
import type { Settings } from './types'

export const DEFAULT_SETTINGS: Settings = {
  desiredRetention: 0.9,
  maxInterval: 36500,
  learningSteps: '1m 10m',
  relearningSteps: '10m',
  dayCutoff: 4,
  learnAheadMin: 20,
  reviewOrder: 'mix',
  burySiblings: true,
  twoButtons: false,
  showIntervals: true,
  leechThreshold: 8,
  leechAction: 'tag',
  theme: 'system',
  cardFontScale: 1,
  autoplayAudio: true,
  weights: '',
  lastBackupAt: 0,
  onboarded: false,
}

export async function getSettings(): Promise<Settings> {
  const rows = await db.settings.toArray()
  const out = { ...DEFAULT_SETTINGS } as Record<string, unknown>
  for (const r of rows) if (r.key in DEFAULT_SETTINGS) out[r.key] = r.value
  return out as unknown as Settings
}

export async function setSetting<K extends keyof Settings>(key: K, value: Settings[K]): Promise<void> {
  await db.settings.put({ key, value })
  if (key === 'theme') {
    try {
      localStorage.setItem('mnemo-theme', String(value))
    } catch {
      /* storage may be unavailable */
    }
  }
}

/** Reactive settings; returns defaults until the first read completes. */
export function useSettings(): Settings {
  return useLiveQuery(getSettings, [], DEFAULT_SETTINGS)
}

/** Free-form key/value storage for things that are not user settings. */
export async function getMeta<T>(key: string, fallback: T): Promise<T> {
  const row = await db.settings.get(`meta:${key}`)
  return row ? (row.value as T) : fallback
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  await db.settings.put({ key: `meta:${key}`, value })
}
