import DOMPurify from 'dompurify'

let hooked = false

function ensureHooks() {
  if (hooked) return
  hooked = true
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node instanceof Element && node.tagName === 'A' && node.hasAttribute('href')) {
      node.setAttribute('target', '_blank')
      node.setAttribute('rel', 'noopener noreferrer')
    }
  })
}

/**
 * Card HTML comes from the user or from imported decks (untrusted).
 * Scripts, event handlers, frames and forms are removed; formatting is kept.
 */
export function sanitizeCardHtml(html: string): string {
  ensureHooks()
  return DOMPurify.sanitize(html, {
    ADD_TAGS: ['ruby', 'rb', 'rt', 'rp'],
    ADD_ATTR: ['target'],
    FORBID_TAGS: ['style', 'script', 'iframe', 'frame', 'object', 'embed', 'form', 'link', 'meta', 'base'],
    ALLOW_DATA_ATTR: true,
  })
}

/**
 * Field HTML saved by the editor. Same safe profile as card rendering, so editing a note
 * imported from Anki never strips its formatting (image sizes, tables, ruby…).
 */
export function sanitizeFieldHtml(html: string): string {
  return sanitizeCardHtml(html)
}
