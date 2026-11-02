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

/** Field HTML written by the editor: a smaller, predictable subset. */
export function sanitizeFieldHtml(html: string): string {
  ensureHooks()
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      'b', 'strong', 'i', 'em', 'u', 's', 'sub', 'sup', 'br', 'div', 'p', 'span', 'ul', 'ol', 'li',
      'img', 'a', 'code', 'pre', 'blockquote', 'h1', 'h2', 'h3', 'hr', 'table', 'thead', 'tbody',
      'tr', 'td', 'th', 'ruby', 'rb', 'rt', 'rp', 'font', 'mark',
    ],
    ALLOWED_ATTR: ['src', 'href', 'alt', 'title', 'class', 'style', 'color', 'colspan', 'rowspan', 'data-media'],
  })
}
