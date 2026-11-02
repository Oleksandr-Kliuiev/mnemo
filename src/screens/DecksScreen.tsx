import { useEffect, useState } from 'react'
import { ChevronDown, Download, Flame, Layers, Plus, Share, ShieldCheck, Sparkles, X } from 'lucide-react'
import { Screen, Section } from '../ui/Screen'
import { Counts, DeckBadge, EmptyState } from '../ui/controls'
import { useDialogs } from '../ui/Dialogs'
import { useToast } from '../ui/Toast'
import { estimateMinutes, flattenTree, useOverview, type DeckNode } from '../data/overview'
import { createDeck, leafName, updateDeck } from '../db/repo'
import { getMeta, setMeta } from '../db/settings'
import { createDemoDecks } from '../data/demo'
import { href, navigate } from '../lib/router'
import { CARDS, count, DAYS, plural } from '../lib/format'
import { isIOS, isStandalone } from '../lib/platform'
import { db, requestPersistentStorage } from '../db/db'
import { useLiveQuery } from 'dexie-react-hooks'

export function useNewDeckFlow() {
  const dialogs = useDialogs()
  const toast = useToast()
  return async (parent?: string) => {
    const name = await dialogs.prompt({
      title: parent ? 'Новая подколода' : 'Новая колода',
      message: parent ? `Внутри «${leafName(parent)}»` : 'Для вложенной колоды используйте «::», например «Языки::Английский».',
      label: 'Название колоды',
      placeholder: 'Например, «Английский»',
      ok: 'Создать',
      validate: (v) => (v.replace(/:/g, '').trim() ? null : 'Введите название'),
    })
    if (!name) return null
    const id = await createDeck(parent ? `${parent}::${name}` : name)
    void requestPersistentStorage()
    toast.show(`Колода «${leafName(name)}» создана`)
    return id
  }
}

function InstallBanner() {
  const [hidden, setHidden] = useState(true)
  useEffect(() => {
    if (!isIOS() || isStandalone()) return
    void getMeta('installBannerHidden', false).then((h) => setHidden(h))
  }, [])
  if (hidden) return null
  return (
    <div className="banner" role="region" aria-label="Установка приложения">
      <span className="banner__icon" aria-hidden>
        <Download size={20} />
      </span>
      <div className="banner__body">
        <span className="banner__title">Установите Mnemo на экран «Домой»</span>
        Нажмите <Share size={16} className="inline-icon" aria-label="Поделиться" /> внизу Safari и выберите «На экран „Домой“». Приложение откроется на весь экран и будет работать без интернета.
        <div className="banner__actions">
          <a className="btn btn--small btn--tinted" href={href('/install')}>
            Подробнее
          </a>
        </div>
      </div>
      <button
        type="button"
        className="icon-btn"
        aria-label="Скрыть подсказку об установке"
        onClick={() => {
          setHidden(true)
          void setMeta('installBannerHidden', true)
        }}
      >
        <X size={20} aria-hidden />
      </button>
    </div>
  )
}

function BackupBanner({ lastBackupAt, totalCards }: { lastBackupAt: number; totalCards: number }) {
  const [snoozed, setSnoozed] = useState(true)
  // Remind only once there is progress worth keeping: reviews on at least two days.
  const firstReview = useLiveQuery(async () => (await db.revlog.orderBy('time').first())?.time ?? null, [])
  useEffect(() => {
    void getMeta('backupSnoozeUntil', 0).then((t) => setSnoozed(Date.now() < t))
  }, [])
  const days = lastBackupAt ? Math.floor((Date.now() - lastBackupAt) / 86_400_000) : null
  const hasHistory = firstReview != null && Date.now() - firstReview > 2 * 86_400_000
  const due = totalCards >= 20 && hasHistory && (days === null || days >= 14)
  if (!due || snoozed) return null
  return (
    <div className="banner banner--warning" role="region" aria-label="Резервная копия" style={{ marginTop: 'var(--s-6)' }}>
      <span className="banner__icon" aria-hidden>
        <ShieldCheck size={20} />
      </span>
      <div className="banner__body">
        <span className="banner__title">{days === null ? 'Сделайте первую резервную копию' : `Последняя копия — ${count(days, DAYS)} назад`}</span>
        Карточки хранятся только на этом устройстве. Копия займёт пару секунд.
        <div className="banner__actions">
          <a className="btn btn--small" href={href('/settings?focus=backup')}>
            Сохранить копию
          </a>
          <button
            type="button"
            className="btn btn--small btn--plain"
            onClick={() => {
              setSnoozed(true)
              void setMeta('backupSnoozeUntil', Date.now() + 3 * 86_400_000)
            }}
          >
            Напомнить позже
          </button>
        </div>
      </div>
    </div>
  )
}

function Hero({ ov }: { ov: NonNullable<ReturnType<typeof useOverview>> }) {
  const { totals } = ov
  const due = totals.new + totals.learn + totals.review
  const minutes = estimateMinutes(totals, ov.avgAnswerMs)
  if (ov.totalCards === 0) {
    return (
      <section className="hero" aria-labelledby="hero-label">
        <h2 className="hero__label" id="hero-label">
          Колода готова
        </h2>
        <p className="hero__done">Добавьте первые карточки — и можно начинать учить.</p>
        <a className="btn hero__btn" href={href(ov.decks.length === 1 ? `/add?deck=${ov.decks[0].id}` : '/add')}>
          Добавить карточку
        </a>
      </section>
    )
  }
  return (
    <section className="hero" aria-labelledby="hero-label">
      <div className="hero__top">
        <div>
          <h2 className="hero__label" id="hero-label">
            {due ? 'Сегодня к изучению' : 'На сегодня всё'}
          </h2>
          <div className="hero__big">
            {due}
            <span className="hero__unit">{plural(due, CARDS)}</span>
          </div>
        </div>
        {ov.streak > 0 && (
          <span className="hero__streak" title="Дней подряд с занятиями">
            <Flame size={18} aria-hidden />
            {ov.streak}
            <span className="sr-only">{plural(ov.streak, DAYS)} подряд</span>
          </span>
        )}
      </div>
      {due > 0 ? (
        <>
          <div className="hero__meta">
            <span>
              <i className="hero__dot" style={{ color: '#9ecbff' }} aria-hidden />
              {totals.new} {plural(totals.new, ['новая', 'новые', 'новых'])}
            </span>
            <span>
              <i className="hero__dot" style={{ color: '#ffc58a' }} aria-hidden />
              {totals.learn} в изучении
            </span>
            <span>
              <i className="hero__dot" style={{ color: '#9ff0b8' }} aria-hidden />
              {totals.review} повторить
            </span>
            <span>≈ {minutes} мин</span>
          </div>
          <a className="btn hero__btn" href={href('/study/all')}>
            Начать занятие
          </a>
        </>
      ) : (
        <p className="hero__done">
          {ov.reviewsToday > 0 ? `Отлично поработали: ${ov.reviewsToday} ${plural(ov.reviewsToday, ['ответ', 'ответа', 'ответов'])} сегодня. ` : ''}
          {ov.dueTomorrow > 0 ? `Завтра ждут ${count(ov.dueTomorrow, CARDS)}.` : 'Добавьте новые карточки или загляните завтра.'}
        </p>
      )}
    </section>
  )
}

function DeckRow({ node }: { node: DeckNode }) {
  const { deck, counts, children, depth } = node
  const hasKids = children.length > 0
  return (
    <div className="deck-item" style={{ ['--indent' as string]: `${depth * 20}px` }}>
      {hasKids ? (
        <button
          type="button"
          className="collapse-btn"
          aria-expanded={!deck.collapsed}
          aria-label={`${deck.collapsed ? 'Развернуть' : 'Свернуть'} «${leafName(deck.name)}»`}
          onClick={() => void updateDeck(deck.id, { collapsed: !deck.collapsed })}
        >
          <ChevronDown size={18} strokeWidth={2.4} aria-hidden />
        </button>
      ) : (
        <span className="collapse-spacer" aria-hidden />
      )}
      <a className="row deck-row" href={href(`/deck/${deck.id}`)}>
        <DeckBadge color={deck.color} emoji={deck.emoji} name={leafName(deck.name)} />
        <span className="row__body">
          <span className="row__title">{leafName(deck.name)}</span>
          <span className="row__sub">{count(node.total, CARDS)}</span>
        </span>
        <Counts n={counts.new} l={counts.learn} r={counts.review} />
      </a>
    </div>
  )
}

export default function DecksScreen() {
  const ov = useOverview()
  const dialogs = useDialogs()
  const toast = useToast()
  const newDeck = useNewDeckFlow()
  const [busy, setBusy] = useState(false)

  const openAdd = async () => {
    const choice = await dialogs.choose({
      title: 'Добавить',
      options: [
        { label: 'Новая карточка', value: 'card' },
        { label: 'Новая колода', value: 'deck' },
        { label: 'Импорт из Anki или файла', value: 'import' },
      ],
    })
    if (choice === 'card') navigate('/add')
    if (choice === 'deck') await newDeck()
    if (choice === 'import') navigate('/import')
  }

  const addDemo = async () => {
    setBusy(true)
    try {
      await createDemoDecks()
      void requestPersistentStorage()
      toast.show('Демо-колоды добавлены')
    } finally {
      setBusy(false)
    }
  }

  const actions = (
    <button type="button" className="icon-btn icon-btn--filled" aria-label="Добавить карточку, колоду или импорт" onClick={() => void openAdd()}>
      <Plus size={22} strokeWidth={2.4} aria-hidden />
    </button>
  )

  if (!ov) {
    return (
      <Screen title="Колоды" actions={actions}>
        <div className="stack" aria-busy="true" aria-label="Загрузка колод">
          <div className="skeleton" style={{ height: 180 }} />
          <div className="skeleton" />
          <div className="skeleton" />
        </div>
      </Screen>
    )
  }

  const rows = flattenTree(ov.roots)
  return (
    <Screen title="Колоды" actions={actions}>
      <InstallBanner />
      {ov.decks.length === 0 ? (
        <EmptyState
          icon={<Layers size={44} />}
          title="Добро пожаловать в Mnemo"
          text="Создайте колоду и добавьте карточки, загрузите готовые колоды Anki или начните с демо-колод."
        >
          <button
            type="button"
            className="btn"
            onClick={async () => {
              const id = await newDeck()
              if (id != null) navigate(`/deck/${id}`)
            }}
          >
            <Plus size={20} aria-hidden /> Создать колоду
          </button>
          <a className="btn btn--tinted" href={href('/import')}>
            <Download size={20} aria-hidden /> Импорт из Anki
          </a>
          <button type="button" className="btn btn--plain" onClick={() => void addDemo()} disabled={busy}>
            <Sparkles size={20} aria-hidden /> {busy ? 'Добавляю…' : 'Попробовать демо-колоды'}
          </button>
        </EmptyState>
      ) : (
        <>
          <Hero ov={ov} />
          <Section
            title="Мои колоды"
            big
            id="decks-title"
            action={
              <button type="button" className="section__action" onClick={() => void newDeck()}>
                Новая колода
              </button>
            }
          >
            <div className="group deck-list">
              {rows.map((n) => (
                <DeckRow key={n.deck.id} node={n} />
              ))}
            </div>
            <p className="section__foot legend-inline">
              <span className="count--new">Новые</span> · <span className="count--learn">В изучении</span> · <span className="count--review">Повторить</span>
            </p>
          </Section>
          <BackupBanner lastBackupAt={ov.settings.lastBackupAt} totalCards={ov.totalCards} />
        </>
      )}
    </Screen>
  )
}
