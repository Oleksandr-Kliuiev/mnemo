import { mediaUrl } from '../db/media'

/**
 * iOS only lets a page play sound after a user gesture. We keep one audio element and
 * "unlock" it on the first tap; later plays reuse it and are then allowed.
 */
let el: HTMLAudioElement | null = null
let queue: string[] = []
let unlocked = false

function audio(): HTMLAudioElement {
  if (!el) {
    el = new Audio()
    el.preload = 'auto'
    el.addEventListener('ended', playNext)
    el.addEventListener('error', playNext)
  }
  return el
}

/** 50 ms of silence as a WAV object URL, used to unlock audio on iOS. */
function silentWav(): string {
  const rate = 8000
  const n = 400
  const buf = new ArrayBuffer(44 + n)
  const v = new DataView(buf)
  const w = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i))
  }
  w(0, 'RIFF')
  v.setUint32(4, 36 + n, true)
  w(8, 'WAVE')
  w(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 1, true)
  v.setUint32(24, rate, true)
  v.setUint32(28, rate, true)
  v.setUint16(32, 1, true)
  v.setUint16(34, 8, true)
  w(36, 'data')
  v.setUint32(40, n, true)
  for (let i = 0; i < n; i++) v.setUint8(44 + i, 128)
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }))
}

export function unlockAudio(): void {
  if (unlocked) return
  unlocked = true
  const a = audio()
  a.src = silentWav()
  a.play().then(
    () => a.pause(),
    () => {
      unlocked = false
    },
  )
  try {
    // Touch speech synthesis in the same gesture so later utterances are allowed too.
    const u = new SpeechSynthesisUtterance('')
    u.volume = 0
    window.speechSynthesis?.speak(u)
  } catch {
    /* not supported */
  }
}

async function playNext() {
  const name = queue.shift()
  if (!name) return
  const url = await mediaUrl(name)
  if (!url) return playNext()
  const a = audio()
  a.src = url
  a.play().catch(() => {
    queue = []
  })
}

export function playSounds(names: string[]): void {
  stopSounds()
  queue = [...names]
  void playNext()
}

export function stopSounds(): void {
  queue = []
  if (el) {
    el.pause()
  }
}
