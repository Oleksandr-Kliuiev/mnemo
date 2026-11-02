import { BarChart3, Layers, Search, Settings } from 'lucide-react'
import { href } from '../lib/router'

const TABS = [
  { to: '/', label: 'Колоды', icon: Layers, match: (p: string) => p === '/' || p.startsWith('/deck') },
  { to: '/browse', label: 'Карточки', icon: Search, match: (p: string) => p.startsWith('/browse') },
  { to: '/stats', label: 'Статистика', icon: BarChart3, match: (p: string) => p.startsWith('/stats') },
  { to: '/settings', label: 'Настройки', icon: Settings, match: (p: string) => p.startsWith('/settings') || p.startsWith('/import') },
]

export function TabBar({ path }: { path: string }) {
  return (
    <nav className="tabbar" aria-label="Разделы">
      <div className="tabbar__inner">
        {TABS.map((t) => {
          const active = t.match(path)
          const Icon = t.icon
          return (
            <a key={t.to} className="tab" href={href(t.to)} aria-current={active ? 'page' : undefined}>
              <Icon size={24} strokeWidth={active ? 2.4 : 1.9} aria-hidden />
              <span>{t.label}</span>
            </a>
          )
        })}
      </div>
    </nav>
  )
}
