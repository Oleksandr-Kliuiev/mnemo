import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CheckCircle2, Clock, EyeOff, Flag, MoreHorizontal, Pause, Pencil, Trash2, Undo2, Volume2, X } from 'lucide-react'
import { useDocTitle } from '../ui/Screen'
import { CardView, answerOnlyText } from '../ui/CardView'
import { Sheet } from '../ui/Sheet'
import { useDialogs } from '../ui/Dialogs'
import { useToast } from '../ui/Toast'
import { Loading } from '../ui/controls'
import { db } from '../db/db'
import { deleteNotes, leafName, setFlag } from '../db/repo'
import { useSettings } from '../db/settings'
import type { Card, Deck, Grade, Note, NoteType } from '../db/types'
import { renderCard, type RenderedCard } from '../render/card'
import { plainText } from '../render/html'
import { StudySession, type QueueKind } from '../sched/session'
import type { AnswerPreview } from '../sched/fsrs'
import { dayIndex } from '../sched/day'
import { goBack, navigate } from '../lib/router'
import { playSounds, stopSounds, unlockAudio } from '../lib/audio'
import { speak, stopSpeaking } from '../lib/tts'
import { useIsDark } from '../lib/theme'
import { CARDS, count, formatDuration, formatPercent, plural } from '../lib/format'
import { isApplePlatform } from '../lib/platform'
import { NoteEditorSheet } from './EditorScreen'

interface Current {
  card: Card
  kind: QueueKind
  note: Note
  type: NoteType
  deck: Deck | undefined
}

type Status = { s: 'loading' } | { s: 'card' } | { s: 'wait'; until: number; count: number } | { s: 'done' } | { s: 'error'; message: string }

const GRADE_LABELS: Record<Grade, string> = { 1: 'Снова', 2: 'Трудно', 3: 'Хорошо', 4: 'Легко' }

export const FLAG_COLORS = ['', '#FF453A', '#FF9F0A', '#30D158', '#0A84FF', '#FF6FAE', '#30B0C7', '#BF5AF2']
export const FLAG_NAMES = ['Без флага', 'Красный', 'Оранжевый', 'Зелёный', 'Синий', 'Розовый', 'Бирюзовый', 'Фиолетовый']

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  if (!el) return false
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)
}

export default function StudyScreen({ deckId, extraNew, reviewAhead }: { deckId: number | null; extraNew: number; reviewAhead: number }) {
  const settings = useSettings()
  const dark = useIsDark()
  const dialogs = useDialogs()
  const toast = useToast()
  const session = useRef<StudySession | null>(null)
  const [status, setStatus] = useState<Status>({ s: 'loading' })
  const [cur, setCur] = useState<Current | null>(null)
  const [phase, setPhase] = useState<'question' | 'answer'>('question')
  const [preview, setPreview] = useState<AnswerPreview | null>(null)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [, setTick] = useState(0)
  const shownAt = useRef(Date.now())
  const rootDeck = useRef<Deck | undefined>(undefined)
  const [title, setTitle] = useState('Обучение')
  useDocTitle(`Занятие · ${title}`)

  const rerender = () => setTick((t) => t + 1)

  const showNext = useCallback(async (opts: { early?: boolean } = {}) => {
    const s = session.current
    if (!s) return
    stopSounds()
    stopSpeaking()
    const now = Date.now()
    // Past the day cutoff (04:00 by default) the queues and limits belong to a new day.
    if (s.isStale(now)) await s.reload(now)
    let r = s.next(now)
    if (opts.early && r.type === 'wait') r = s.next(r.until + 1)
    if (r.type === 'done') {
      setCur(null)
      setStatus({ s: 'done' })
      return
    }
    if (r.type === 'wait') {
      setCur(null)
      setStatus({ s: 'wait', until: r.until, count: r.count })
      return
    }
    const note = await db.notes.get(r.card.noteId)
    const type = note ? await db.noteTypes.get(note.typeId) : undefined
    if (!note || !type) {
      // Orphan card (note deleted elsewhere): drop it and continue.
      s.forget(r.card.id)
      return showNext()
    }
    setCur({ card: r.card, kind: r.kind, note, type, deck: s.decks.get(r.card.deckId) })
    setPhase('question')
    setPreview(null)
    setTyped('')
    setStatus({ s: 'card' })
    shownAt.current = Date.now()
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const s = await StudySession.load({ rootDeckId: deckId, extraNew, reviewAheadDays: reviewAhead })
        if (cancelled) return
        session.current = s
        rootDeck.current = deckId != null ? s.decks.get(deckId) : undefined
        setTitle(rootDeck.current ? leafName(rootDeck.current.name) : 'Все колоды')
        await showNext()
      } catch (e) {
        setStatus({ s: 'error', message: (e as Error).message })
      }
    })()
    return () => {
      cancelled = true
      stopSounds()
      stopSpeaking()
    }
  }, [deckId, extraNew, reviewAhead, showNext])

  // Wake up when learning cards become due.
  useEffect(() => {
    if (status.s !== 'wait') return
    const ms = Math.max(500, status.until - Date.now())
    const t = window.setTimeout(() => void showNext(), Math.min(ms, 2_147_000_000))
    const i = window.setInterval(rerender, 15_000)
    return () => {
      clearTimeout(t)
      clearInterval(i)
    }
  }, [status, showNext])

  const rendered: RenderedCard | null = useMemo(() => {
    if (!cur) return null
    return renderCard(cur.type, cur.note, cur.card, cur.deck?.name ?? '', phase === 'answer' ? typed : null)
    // `typed` only matters once the answer is shown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur, phase])

  // Autoplay sounds of the side that just appeared.
  useEffect(() => {
    if (!rendered || !settings.autoplayAudio) return
    const list = phase === 'question' ? rendered.questionSounds : rendered.answerSounds
    if (list.length) playSounds(list)
  }, [rendered, phase, settings.autoplayAudio])

  const onRendered = useCallback(
    (root: ShadowRoot) => {
      const cfg = cur?.deck?.config
      if (!cfg?.autoTts) return
      if (phase === 'question' && cfg.ttsFront && rendered && !rendered.questionSounds.length) {
        speak(plainText(rendered.question).replace(/\[\.\.\.\]/g, '…'), cfg.ttsFront)
      } else if (phase === 'answer' && cfg.ttsBack) {
        speak(answerOnlyText(root), cfg.ttsBack)
      }
    },
    [cur, phase, rendered],
  )

  const reveal = useCallback(() => {
    const s = session.current
    if (!s || !cur || phase !== 'question') return
    unlockAudio()
    setPreview(s.preview(cur.card, Date.now()))
    setPhase('answer')
  }, [cur, phase])

  const answer = useCallback(
    async (grade: Grade) => {
      const s = session.current
      if (!s || !cur || !preview || busy) return
      unlockAudio()
      setBusy(true)
      try {
        const { leech } = await s.answer(cur.card, preview[grade], Date.now() - shownAt.current)
        if (leech) {
          const noteId = cur.note.id
          toast.show(
            settings.leechAction === 'suspend'
              ? 'Карточку часто забывают — она приостановлена и помечена «leech». Попробуйте переформулировать её.'
              : 'Эту карточку часто забывают (метка «leech»). Попробуйте переформулировать её.',
            { action: { label: 'Изменить', run: () => navigate(`/note/${noteId}`) } },
          )
        }
        await showNext()
      } catch (e) {
        toast.show(`Не удалось сохранить ответ: ${(e as Error).message}`)
      } finally {
        setBusy(false)
      }
    },
    [cur, preview, busy, showNext, toast, settings.leechAction],
  )

  const undo = useCallback(async () => {
    const s = session.current
    if (!s?.canUndo || busy) return
    setBusy(true)
    try {
      await s.undo()
      await showNext()
      toast.show('Последний ответ отменён')
    } finally {
      setBusy(false)
    }
  }, [busy, showNext, toast])

  const bury = async () => {
    const s = session.current
    if (!s || !cur || busy) return
    setMenuOpen(false)
    await s.bury(cur.card)
    toast.show('Карточка скрыта до завтра', { action: { label: 'Отменить', run: () => void undo() } })
    await showNext()
  }

  const suspend = async () => {
    const s = session.current
    if (!s || !cur || busy) return
    setMenuOpen(false)
    await s.suspend(cur.card)
    toast.show('Карточка приостановлена', { action: { label: 'Отменить', run: () => void undo() } })
    await showNext()
  }

  const flag = async (f: number) => {
    if (!cur || busy) return
    await setFlag([cur.card.id], f)
    setCur({ ...cur, card: { ...cur.card, flag: f } })
    session.current?.refreshCard({ ...cur.card, flag: f })
    setMenuOpen(false)
  }

  const removeNote = async () => {
    if (!cur) return
    setMenuOpen(false)
    const siblings = await db.cards.where('noteId').equals(cur.note.id).count()
    const ok = await dialogs.confirm({
      title: 'Удалить запись?',
      message: `Будет удалена запись и ${count(siblings, CARDS)} с её историей ответов. Отменить нельзя.`,
      ok: 'Удалить',
      cancel: 'Оставить',
      danger: true,
    })
    if (!ok) return
    await deleteNotes([cur.note.id])
    session.current?.forgetNote(cur.note.id)
    toast.show('Запись удалена')
    await showNext()
  }

  const closeEditor = async () => {
    setEditing(false)
    const s = session.current
    if (!cur || !s) return
    const note = await db.notes.get(cur.note.id)
    const card = await db.cards.get(cur.card.id)
    if (!note || !card) {
      // Deleted in the editor.
      s.forgetNote(cur.note.id)
      await showNext()
      return
    }
    const type = await db.noteTypes.get(note.typeId)
    if (!type) return
    if (card.suspended || !s.deckIds.has(card.deckId) || card.state !== cur.card.state || card.reps !== cur.card.reps) {
      // Suspended, moved out of this session or reset in the editor: continue with the next card.
      s.forget(card.id)
      if (!card.suspended && s.deckIds.has(card.deckId)) await s.reload()
      await showNext()
      return
    }
    s.refreshCard(card)
    setCur({ ...cur, note, type, card, deck: s.decks.get(card.deckId) })
    if (phase === 'answer') setPreview(s.preview(card, Date.now()))
  }

  const close = () => goBack(deckId != null ? `/deck/${deckId}` : '/')

  // Keyboard shortcuts (iPad with keyboard, Mac): Space/Enter, 1–4, Z, E, -, @
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || document.querySelector('dialog[open]')) return
      if (e.key === 'Escape') {
        close()
        return
      }
      if ((e.key === 'z' || e.key === 'Z' || e.key === 'я') && !e.altKey) {
        e.preventDefault()
        void undo()
        return
      }
      if (status.s !== 'card') return
      if (phase === 'question' && (e.key === ' ' || e.key === 'Enter')) {
        e.preventDefault()
        reveal()
      } else if (phase === 'answer') {
        const n = Number(e.key)
        if (n >= 1 && n <= 4) {
          e.preventDefault()
          if (!settings.twoButtons || n === 1 || n === 3) void answer(n as Grade)
        } else if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault()
          void answer(3)
        }
      }
      if (e.key === 'e' || e.key === 'у') setEditing(true)
      if (e.key === '-') void bury()
      if (e.key === '@') void suspend()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const s = session.current
  const counts = s?.counts() ?? { new: 0, learn: 0, review: 0 }
  const progress = s?.progress() ?? { done: 0, total: 0 }
  const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0
  const grades: Grade[] = settings.twoButtons ? [1, 3] : [1, 2, 3, 4]
  const mod = isApplePlatform() ? '⌘' : 'Ctrl'

  return (
    <div className="study">
      <h1 className="sr-only">Обучение: {title}</h1>
      <div className="study__top">
        <button type="button" className="icon-btn" onClick={close} aria-label="Закончить занятие">
          <X size={24} strokeWidth={2.2} aria-hidden />
        </button>
        <div className="study__counts" aria-label={`Осталось: новых ${counts.new}, в изучении ${counts.learn}, повторить ${counts.review}`} role="status">
          <span className={`count count--new${cur?.kind === 'new' ? ' count--current' : ''}`} aria-hidden>
            {counts.new}
          </span>
          <span className={`count count--learn${cur?.kind === 'learn' ? ' count--current' : ''}`} aria-hidden>
            {counts.learn}
          </span>
          <span className={`count count--review${cur?.kind === 'review' ? ' count--current' : ''}`} aria-hidden>
            {counts.review}
          </span>
        </div>
        <div className="study__actions">
          <button type="button" className="icon-btn" onClick={() => void undo()} disabled={!s?.canUndo || busy} aria-label="Отменить последний ответ" title={`Отменить (Z)`}>
            <Undo2 size={22} aria-hidden />
          </button>
          <button type="button" className="icon-btn" onClick={() => setMenuOpen(true)} disabled={!cur} aria-label="Действия с карточкой">
            <MoreHorizontal size={24} aria-hidden />
          </button>
        </div>
      </div>
      <div className="progress" role="progressbar" aria-label="Прогресс занятия" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <div className="progress__bar" style={{ width: `${pct}%` }} />
      </div>

      {status.s === 'loading' && <Loading />}
      {status.s === 'error' && (
        <div className="finish">
          <h2 className="finish__title">Не удалось начать</h2>
          <p className="finish__text">{status.message}</p>
          <button type="button" className="btn btn--block" onClick={close}>
            Назад
          </button>
        </div>
      )}
      {status.s === 'done' && <Finish session={s} deckId={deckId} onClose={close} />}
      {status.s === 'wait' && (
        <div className="finish">
          <div className="finish__art" style={{ background: 'var(--hard-tint)', color: 'var(--hard)' }} aria-hidden>
            <Clock size={44} />
          </div>
          <h2 className="finish__title">Перерыв</h2>
          <p className="finish__text">
            {count(status.count, CARDS)} в изучении. Следующая будет готова через {formatDuration(Math.max(60_000, status.until - Date.now()))}.
            Можно отдохнуть — экран обновится сам.
          </p>
          <div className="finish__actions">
            <button type="button" className="btn btn--block" onClick={() => void showNext({ early: true })}>
              Показать сейчас
            </button>
            <button type="button" className="btn btn--block btn--tinted" onClick={close}>
              Закончить
            </button>
          </div>
        </div>
      )}

      {status.s === 'card' && cur && rendered && (
        <>
          <div className="study__scroll">
            <div className="study__card">
              <div
                className={`card-surface${phase === 'answer' ? ' card-surface--answer' : ' card-surface--tappable'}`}
                key={`${cur.card.id}-${cur.card.reps}`}
                onClick={(e) => {
                  // Tap anywhere on the question to reveal, except on controls inside the card.
                  if (phase !== 'question') return
                  const path = e.nativeEvent.composedPath() as Element[]
                  if (path.some((el) => el instanceof Element && el.matches?.('button, a, input, summary, details, audio, video'))) return
                  reveal()
                }}
              >
                <CardView
                  html={phase === 'question' ? rendered.question : rendered.answer}
                  css={rendered.css}
                  dark={dark}
                  zoom={settings.cardFontScale}
                  label={phase === 'question' ? 'Вопрос' : 'Ответ'}
                  onRendered={onRendered}
                  onTypedChange={setTyped}
                  onTypeEnter={reveal}
                  focusTypeInput={phase === 'question'}
                  scrollToAnswer={phase === 'answer'}
                />
              </div>
              <div className="study__meta">
                {cur.card.flag > 0 && (
                  <span>
                    <i className="flag-dot" style={{ ['--flag' as string]: FLAG_COLORS[cur.card.flag] }} aria-hidden /> {FLAG_NAMES[cur.card.flag]} флаг
                  </span>
                )}
                {deckId == null || cur.card.deckId !== deckId ? <span>{cur.deck ? leafName(cur.deck.name) : ''}</span> : null}
                <span>{cur.kind === 'new' ? 'Новая' : cur.kind === 'learn' ? 'В изучении' : 'Повторение'}</span>
              </div>
            </div>
          </div>
          <div className="study__bottom">
            {phase === 'question' ? (
              <>
                <button type="button" className="btn show-btn" onClick={reveal}>
                  Показать ответ
                </button>
                <p className="study__hint hide-touch">
                  <span className="kbd">Пробел</span> — ответ · <span className="kbd">Z</span> — отменить
                </p>
              </>
            ) : (
              <>
                <div className="answers" role="group" aria-label="Насколько легко вы вспомнили?">
                  {grades.map((g) => (
                    <button
                      key={g}
                      type="button"
                      className={`answer-btn answer-btn--${g}`}
                      onClick={() => void answer(g)}
                      disabled={busy}
                      aria-label={`${GRADE_LABELS[g]}${settings.showIntervals && preview ? `, следующий показ через ${preview[g].label}` : ''}`}
                    >
                      {settings.showIntervals && preview && <span className="answer-btn__ivl">{preview[g].label}</span>}
                      <span className="answer-btn__label">{GRADE_LABELS[g]}</span>
                    </button>
                  ))}
                </div>
                <p className="study__hint hide-touch">
                  {settings.twoButtons ? (
                    <>
                      <span className="kbd">1</span> снова · <span className="kbd">3</span> или <span className="kbd">Пробел</span> хорошо
                    </>
                  ) : (
                    <>
                      <span className="kbd">1</span>–<span className="kbd">4</span> оценка · <span className="kbd">Пробел</span> хорошо
                    </>
                  )}
                </p>
              </>
            )}
          </div>
        </>
      )}

      <Sheet open={menuOpen} onClose={() => setMenuOpen(false)} title="Карточка">
        <div className="stack">
          <div className="group">
            <button type="button" className="row row--icon" onClick={() => (setMenuOpen(false), setEditing(true))}>
              <span className="row__icon" style={{ background: '#0A84FF' }} aria-hidden>
                <Pencil size={18} />
              </span>
              <span className="row__body">
                <span className="row__title">Изменить</span>
              </span>
              <span className="kbd hide-touch">E</span>
            </button>
            {cur?.deck?.config.ttsFront || cur?.deck?.config.ttsBack ? (
              <button
                type="button"
                className="row row--icon"
                onClick={() => {
                  setMenuOpen(false)
                  if (!rendered || !cur?.deck) return
                  const cfg = cur.deck.config
                  if (phase === 'question') speak(plainText(rendered.question), cfg.ttsFront || cfg.ttsBack)
                  else speak(plainText(rendered.answer), cfg.ttsBack || cfg.ttsFront)
                }}
              >
                <span className="row__icon" style={{ background: '#30B0C7' }} aria-hidden>
                  <Volume2 size={18} />
                </span>
                <span className="row__body">
                  <span className="row__title">Озвучить</span>
                </span>
              </button>
            ) : null}
            <button type="button" className="row row--icon" onClick={() => void bury()}>
              <span className="row__icon" style={{ background: '#8E8E93' }} aria-hidden>
                <EyeOff size={18} />
              </span>
              <span className="row__body">
                <span className="row__title">Скрыть до завтра</span>
              </span>
              <span className="kbd hide-touch">-</span>
            </button>
            <button type="button" className="row row--icon" onClick={() => void suspend()}>
              <span className="row__icon" style={{ background: '#FF9F0A' }} aria-hidden>
                <Pause size={18} />
              </span>
              <span className="row__body">
                <span className="row__title">Приостановить</span>
                <span className="row__sub">Не показывать, пока не возобновите</span>
              </span>
              <span className="kbd hide-touch">@</span>
            </button>
          </div>
          <div>
            <p className="field__label" id="flag-label">
              <span>
                <Flag size={14} className="inline-icon" aria-hidden /> Флаг
              </span>
            </p>
            <div className="flag-row" role="group" aria-labelledby="flag-label">
              {FLAG_COLORS.map((c, i) => (
                <button
                  key={i}
                  type="button"
                  className="flag-btn"
                  aria-pressed={cur?.card.flag === i}
                  aria-label={FLAG_NAMES[i]}
                  style={{ ['--flag' as string]: c || 'transparent' }}
                  onClick={() => void flag(i)}
                >
                  {i === 0 ? <X size={18} aria-hidden /> : null}
                </button>
              ))}
            </div>
          </div>
          <div className="group">
            <button type="button" className="row row--icon row--danger" onClick={() => void removeNote()}>
              <span className="row__icon" style={{ background: 'var(--danger)' }} aria-hidden>
                <Trash2 size={18} />
              </span>
              <span className="row__body">
                <span className="row__title">Удалить запись</span>
              </span>
            </button>
          </div>
          <p className="section__foot hide-touch">
            Сочетания: <span className="kbd">Пробел</span> ответ, <span className="kbd">1–4</span> оценка, <span className="kbd">Z</span> или <span className="kbd">{mod} Z</span> отмена, <span className="kbd">Esc</span> выход.
          </p>
        </div>
      </Sheet>

      {editing && cur && <NoteEditorSheet noteId={cur.note.id} onClose={() => void closeEditor()} />}
    </div>
  )
}

function Finish({ session, deckId, onClose }: { session: StudySession | null; deckId: number | null; onClose: () => void }) {
  const st = session?.stats ?? { answered: 0, again: 0, timeMs: 0, newSeen: 0 }
  const [tomorrow, setTomorrow] = useState<number | null>(null)
  useEffect(() => {
    if (!session) return
    void (async () => {
      const ids = [...session.deckIds]
      const cards = await db.cards.where('deckId').anyOf(ids).toArray()
      const t = session.today + 1
      setTomorrow(cards.filter((c) => !c.suspended && c.state === 2 && dayIndex(c.due, session.settings.dayCutoff) <= t).length)
    })()
  }, [session])
  const correct = st.answered ? (st.answered - st.again) / st.answered : 0
  return (
    <div className="finish">
      <div className="finish__art" aria-hidden>
        <CheckCircle2 size={48} />
      </div>
      <h2 className="finish__title">{st.answered ? 'Отличная работа!' : 'Здесь пока нечего учить'}</h2>
      <p className="finish__text">
        {st.answered
          ? `Вы ответили на ${count(st.answered, CARDS).replace('карточка', 'карточку')} за ${formatDuration(st.timeMs)}.`
          : 'На сегодня карточек нет: всё повторено или лимит новых исчерпан.'}
        {tomorrow != null && tomorrow > 0 ? ` Завтра — ${count(tomorrow, CARDS)}.` : ''}
      </p>
      {st.answered > 0 && (
        <div className="tiles">
          <div className="tile">
            <span className="tile__value">{st.answered}</span>
            <span className="tile__label">{plural(st.answered, ['ответ', 'ответа', 'ответов'])}</span>
          </div>
          <div className="tile">
            <span className="tile__value">{formatPercent(correct)}</span>
            <span className="tile__label">вспомнили</span>
          </div>
          <div className="tile">
            <span className="tile__value">{st.newSeen}</span>
            <span className="tile__label">{plural(st.newSeen, ['новая', 'новые', 'новых'])}</span>
          </div>
        </div>
      )}
      <div className="finish__actions">
        <button type="button" className="btn btn--block" onClick={onClose}>
          Готово
        </button>
        {deckId != null && (
          <button type="button" className="btn btn--block btn--tinted" onClick={() => navigate(`/deck/${deckId}`, { replace: true })}>
            Учить ещё
          </button>
        )}
      </div>
    </div>
  )
}
