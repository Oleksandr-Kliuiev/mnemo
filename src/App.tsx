import { lazy, Suspense, useEffect, useState } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { useRoute, type Route } from './lib/router'
import { useSettings } from './db/settings'
import { ensureBuiltins } from './db/repo'
import type { ThemeSetting } from './db/types'
import { TabBar } from './ui/TabBar'
import { DialogProvider } from './ui/Dialogs'
import { ToastProvider, useToast } from './ui/Toast'
import { Loading } from './ui/controls'
import { Screen } from './ui/Screen'
import DecksScreen from './screens/DecksScreen'
import DeckScreen from './screens/DeckScreen'

const DeckOptionsScreen = lazy(() => import('./screens/DeckOptionsScreen'))
const StudyScreen = lazy(() => import('./screens/StudyScreen'))
const EditorScreen = lazy(() => import('./screens/EditorScreen'))
const BrowseScreen = lazy(() => import('./screens/BrowseScreen'))
const StatsScreen = lazy(() => import('./screens/StatsScreen'))
const SettingsScreen = lazy(() => import('./screens/SettingsScreen'))
const ImportScreen = lazy(() => import('./screens/ImportScreen'))
const NoteTypesScreen = lazy(() => import('./screens/NoteTypesScreen'))
const NoteTypeScreen = lazy(() => import('./screens/NoteTypeScreen'))
const InstallScreen = lazy(() => import('./screens/InstallScreen'))

const FULLSCREEN = new Set(['study', 'add', 'note'])

function useEffectiveTheme(setting: ThemeSetting): 'light' | 'dark' {
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const on = () => setSystemDark(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  const theme = setting === 'system' ? (systemDark ? 'dark' : 'light') : setting
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || (theme === 'dark' ? '#000' : '#f2f2f7')
    document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', bg))
  }, [theme])
  return theme
}

function screenFor(r: Route) {
  const [a, b, c] = r.parts
  const id = Number(b)
  switch (a) {
    case undefined:
      return <DecksScreen />
    case 'deck':
      if (!Number.isFinite(id)) break
      return c === 'options' ? <DeckOptionsScreen deckId={id} /> : <DeckScreen key={id} deckId={id} />
    case 'study':
      return (
        <StudyScreen
          key={r.path + r.query.toString()}
          deckId={b === 'all' || !b ? null : id}
          extraNew={Number(r.query.get('extraNew') ?? 0)}
          reviewAhead={Number(r.query.get('ahead') ?? 0)}
        />
      )
    case 'add':
      return <EditorScreen key="add" deckId={Number(r.query.get('deck')) || undefined} />
    case 'note':
      if (!Number.isFinite(id)) break
      return <EditorScreen key={id} noteId={id} />
    case 'browse':
      return <BrowseScreen deckId={Number(r.query.get('deck')) || undefined} initialQuery={r.query.get('q') ?? ''} />
    case 'stats':
      return <StatsScreen deckId={Number(r.query.get('deck')) || undefined} />
    case 'settings':
      if (b === 'notetypes') return <NoteTypesScreen />
      if (b === 'notetype' && Number.isFinite(Number(c))) return <NoteTypeScreen key={c} typeId={Number(c)} />
      return <SettingsScreen />
    case 'import':
      return <ImportScreen />
    case 'install':
      return <InstallScreen />
  }
  return (
    <Screen title="Страница не найдена" back={{ label: 'Колоды', fallback: '/' }}>
      <p className="muted">Такого раздела нет. Вернитесь к колодам.</p>
    </Screen>
  )
}

function UpdatePrompt() {
  const toast = useToast()
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, reg) {
      if (!reg) return
      // Look for a new version whenever the app comes back to the foreground.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void reg.update().catch(() => {})
      })
    },
  })
  useEffect(() => {
    if (!needRefresh) return
    toast.show('Доступна новая версия Mnemo', {
      action: { label: 'Обновить', run: () => void updateServiceWorker(true) },
      duration: 1e9,
    })
  }, [needRefresh, toast, updateServiceWorker])
  return null
}

export function App() {
  const route = useRoute()
  const settings = useSettings()
  useEffectiveTheme(settings.theme)

  useEffect(() => {
    void ensureBuiltins()
  }, [])

  const fullscreen = FULLSCREEN.has(route.parts[0] ?? '')
  useEffect(() => {
    const offset = route.parts[0] === 'study' ? '112px' : fullscreen ? '0px' : 'var(--tab-h)'
    document.documentElement.style.setProperty('--toast-offset', offset)
  }, [route.parts, fullscreen])

  return (
    <DialogProvider>
      <ToastProvider>
        <div className={`app${fullscreen ? '' : ' app--tabs'}`}>
          <Suspense fallback={<Loading />}>{screenFor(route)}</Suspense>
          {!fullscreen && <TabBar path={route.path} />}
        </div>
        <UpdatePrompt />
      </ToastProvider>
    </DialogProvider>
  )
}
