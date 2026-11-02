const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  laquo: '«',
  raquo: '»',
  shy: '',
  zwnj: '',
  zwj: '',
}

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m
    }
    const v = ENTITIES[e.toLowerCase()]
    return v ?? m
  })
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/** HTML → plain text (keeps line structure loosely, drops sound tags). */
export function stripHtml(html: string): string {
  return decodeEntities(
    html
      .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(div|p|li|tr|h[1-6])>/gi, '\n')
      .replace(/<[^>]*>/g, '')
      .replace(/\[sound:[^\]]*\]/g, ''),
  )
}

/** Single-line plain text, whitespace collapsed. */
export function plainText(html: string): string {
  return stripHtml(html).replace(/\s+/g, ' ').trim()
}

const MEDIA_TAG = /<(img|audio|video|svg|math|object)\b/i

/** Anki's notion of an empty field: nothing but whitespace and empty markup. */
export function isFieldEmpty(html: string | undefined): boolean {
  if (!html) return true
  if (MEDIA_TAG.test(html) || /\[sound:/.test(html)) return false
  return stripHtml(html).replace(/[\s ​]+/g, '') === ''
}
