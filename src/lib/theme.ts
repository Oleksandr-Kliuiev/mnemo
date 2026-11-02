import { useEffect, useState } from 'react'

function read(): boolean {
  return document.documentElement.getAttribute('data-theme') === 'dark'
}

/** Effective dark mode as applied by App (data-theme on <html>). */
export function useIsDark(): boolean {
  const [dark, setDark] = useState(read)
  useEffect(() => {
    const mo = new MutationObserver(() => setDark(read()))
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    setDark(read())
    return () => mo.disconnect()
  }, [])
  return dark
}
