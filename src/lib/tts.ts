export const TTS_LANGUAGES: { code: string; name: string }[] = [
  { code: 'en-US', name: 'Английский (США)' },
  { code: 'en-GB', name: 'Английский (Британия)' },
  { code: 'de-DE', name: 'Немецкий' },
  { code: 'fr-FR', name: 'Французский' },
  { code: 'es-ES', name: 'Испанский' },
  { code: 'it-IT', name: 'Итальянский' },
  { code: 'pt-BR', name: 'Португальский (Бразилия)' },
  { code: 'nl-NL', name: 'Нидерландский' },
  { code: 'nb-NO', name: 'Норвежский' },
  { code: 'sv-SE', name: 'Шведский' },
  { code: 'da-DK', name: 'Датский' },
  { code: 'fi-FI', name: 'Финский' },
  { code: 'pl-PL', name: 'Польский' },
  { code: 'cs-CZ', name: 'Чешский' },
  { code: 'uk-UA', name: 'Украинский' },
  { code: 'ru-RU', name: 'Русский' },
  { code: 'tr-TR', name: 'Турецкий' },
  { code: 'el-GR', name: 'Греческий' },
  { code: 'he-IL', name: 'Иврит' },
  { code: 'ar-SA', name: 'Арабский' },
  { code: 'hi-IN', name: 'Хинди' },
  { code: 'zh-CN', name: 'Китайский' },
  { code: 'ja-JP', name: 'Японский' },
  { code: 'ko-KR', name: 'Корейский' },
]

export function ttsSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window
}

function pickVoice(lang: string): SpeechSynthesisVoice | undefined {
  const voices = window.speechSynthesis.getVoices()
  const norm = lang.toLowerCase().replace('_', '-')
  const base = norm.split('-')[0]
  const exact = voices.filter((v) => v.lang.toLowerCase().replace('_', '-') === norm)
  const pool = exact.length ? exact : voices.filter((v) => v.lang.toLowerCase().startsWith(base))
  // Prefer enhanced/premium voices when the system has them.
  return pool.find((v) => /premium|enhanced|улучш/i.test(v.name)) ?? pool.find((v) => v.localService) ?? pool[0]
}

export function speak(text: string, lang: string, rate = 1): void {
  if (!ttsSupported() || !text.trim()) return
  const synth = window.speechSynthesis
  synth.cancel()
  const u = new SpeechSynthesisUtterance(text)
  if (lang) {
    u.lang = lang.replace('_', '-')
    const v = pickVoice(lang)
    if (v) u.voice = v
  }
  u.rate = Number.isFinite(rate) && rate > 0 ? Math.min(2, Math.max(0.5, rate)) : 1
  synth.speak(u)
}

export function stopSpeaking(): void {
  if (ttsSupported()) window.speechSynthesis.cancel()
}
