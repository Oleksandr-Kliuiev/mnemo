import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Trash2 } from 'lucide-react'
import { Screen, Section } from '../ui/Screen'
import { ButtonRow, DeckBadge, Loading, Segmented, Stepper, SwitchRow } from '../ui/controls'
import { useDialogs } from '../ui/Dialogs'
import { useToast } from '../ui/Toast'
import { db } from '../db/db'
import { DECK_COLORS, DECK_COLOR_NAMES } from '../db/builtins'
import { deleteDeck, isInSubtree, leafName, renameDeck, updateDeck } from '../db/repo'
import { useSettings } from '../db/settings'
import type { Deck, DeckConfig } from '../db/types'
import { navigate } from '../lib/router'
import { CARDS, count, DECKS, formatPercent } from '../lib/format'
import { TTS_LANGUAGES, ttsSupported } from '../lib/tts'

export default function DeckOptionsScreen({ deckId }: { deckId: number }) {
  const deck = useLiveQuery(() => db.decks.get(deckId), [deckId])
  if (deck === undefined) return <Loading />
  if (!deck) {
    return (
      <Screen title="Колода не найдена" back={{ label: 'Колоды', fallback: '/' }}>
        <p className="muted">Колода удалена.</p>
      </Screen>
    )
  }
  return <Options deck={deck} />
}

function Options({ deck }: { deck: Deck }) {
  const settings = useSettings()
  const dialogs = useDialogs()
  const toast = useToast()
  const [name, setName] = useState(deck.name.split('::').join(' :: '))
  const [nameError, setNameError] = useState<string | null>(null)
  const [emoji, setEmoji] = useState(deck.emoji)
  const [desc, setDesc] = useState(deck.description)
  useEffect(() => setEmoji(deck.emoji), [deck.emoji])

  const cfg = deck.config
  const patch = (p: Partial<DeckConfig>) => void updateDeck(deck.id, { config: { ...cfg, ...p } })

  const saveName = async () => {
    const v = name.trim()
    if (!v) {
      setNameError('Введите название')
      return
    }
    try {
      await renameDeck(deck.id, v)
      setNameError(null)
    } catch (e) {
      setNameError((e as Error).message)
    }
  }

  const remove = async () => {
    const all = await db.decks.toArray()
    const sub = all.filter((d) => isInSubtree(d.name, deck.name))
    const cards = await db.cards.where('deckId').anyOf(sub.map((d) => d.id)).count()
    const ok = await dialogs.confirm({
      title: `Удалить «${leafName(deck.name)}»?`,
      message: (
        <>
          Будут удалены {count(sub.length, DECKS)} и {count(cards, CARDS)}. Отменить это нельзя — сначала сохраните резервную копию, если сомневаетесь.
        </>
      ),
      ok: 'Удалить',
      cancel: 'Оставить',
      danger: true,
    })
    if (!ok) return
    const n = await deleteDeck(deck.id)
    toast.show(`Колода удалена (${count(n, CARDS)})`)
    navigate('/', { replace: true })
  }

  const retention = cfg.desiredRetention ?? settings.desiredRetention

  return (
    <Screen title="Параметры колоды" large={false} back={{ label: leafName(deck.name), fallback: `/deck/${deck.id}` }}>
      <Section title="Название">
        <div className="field">
          <label className="sr-only" htmlFor="deck-name">
            Название колоды
          </label>
          <input
            id="deck-name"
            className="input"
            value={name}
            aria-invalid={!!nameError}
            aria-describedby="deck-name-hint"
            onChange={(e) => setName(e.target.value)}
            onBlur={() => void saveName()}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
          {nameError ? (
            <p className="field__error" role="alert">
              {nameError}
            </p>
          ) : (
            <p className="field__hint" id="deck-name-hint">
              «::» делает колоду вложенной: «Языки :: Английский».
            </p>
          )}
        </div>
      </Section>

      <Section title="Оформление">
        <div className="group pad">
          <div className="deck-style">
            <DeckBadge color={deck.color} emoji={emoji} name={leafName(deck.name)} size="large" />
            <div className="field" style={{ flex: 1 }}>
              <label className="field__label" htmlFor="deck-emoji">
                Эмодзи
              </label>
              <input
                id="deck-emoji"
                className="input"
                value={emoji}
                placeholder="📚"
                maxLength={4}
                onChange={(e) => setEmoji(e.target.value)}
                onBlur={() => void updateDeck(deck.id, { emoji: [...emoji.trim()].slice(0, 2).join('') })}
              />
            </div>
          </div>
          <p className="field__label" id="color-label" style={{ marginTop: 'var(--s-4)' }}>
            Цвет
          </p>
          <div className="color-grid" role="group" aria-labelledby="color-label">
            {DECK_COLORS.map((c, i) => (
              <button
                key={c}
                type="button"
                className="color-swatch"
                style={{ ['--swatch' as string]: c }}
                aria-pressed={deck.color === c}
                aria-label={DECK_COLOR_NAMES[i]}
                onClick={() => void updateDeck(deck.id, { color: c })}
              />
            ))}
          </div>
          <div className="field" style={{ marginTop: 'var(--s-4)' }}>
            <label className="field__label" htmlFor="deck-desc">
              Описание
            </label>
            <textarea
              id="deck-desc"
              className="textarea"
              style={{ minHeight: 72 }}
              value={desc}
              placeholder="О чём эта колода"
              onChange={(e) => setDesc(e.target.value)}
              onBlur={() => void updateDeck(deck.id, { description: desc.trim() })}
            />
          </div>
        </div>
      </Section>

      <Section title="Лимиты на день" footer="Лимит родительской колоды действует и на её подколоды.">
        <div className="group">
          <div className="row">
            <span className="row__body">
              <span className="row__title">Новых карточек</span>
            </span>
            <Stepper value={cfg.newPerDay} min={0} max={9999} step={5} label="Новых карточек в день" onChange={(v) => patch({ newPerDay: v })} />
          </div>
          <div className="row">
            <span className="row__body">
              <span className="row__title">Повторений</span>
            </span>
            <Stepper value={cfg.reviewsPerDay} min={0} max={99999} step={50} label="Повторений в день" onChange={(v) => patch({ reviewsPerDay: v })} />
          </div>
        </div>
      </Section>

      <Section title="Порядок новых карточек">
        <Segmented
          label="Порядок новых карточек"
          value={cfg.newOrder}
          options={[
            { value: 'added', label: 'Как добавлены' },
            { value: 'random', label: 'Случайно' },
          ]}
          onChange={(v) => patch({ newOrder: v })}
        />
      </Section>

      <Section
        title="Запоминание"
        footer={`Сейчас: ${formatPercent(retention)}. Выше — больше повторений и надёжнее память, ниже — меньше работы.`}
      >
        <div className="group">
          <SwitchRow
            title="Своё удержание для колоды"
            sub="Иначе действует общая настройка"
            checked={cfg.desiredRetention != null}
            onChange={(on) => patch({ desiredRetention: on ? settings.desiredRetention : null })}
          />
          {cfg.desiredRetention != null && (
            <div className="row">
              <label className="row__body" htmlFor="deck-ret">
                <span className="row__title">Желаемое удержание</span>
              </label>
              <input
                id="deck-ret"
                className="range"
                type="range"
                min={0.75}
                max={0.97}
                step={0.01}
                value={cfg.desiredRetention}
                onChange={(e) => patch({ desiredRetention: Number(e.target.value) })}
              />
              <span className="row__value tabular">{formatPercent(cfg.desiredRetention)}</span>
            </div>
          )}
        </div>
      </Section>

      {ttsSupported() && (
        <Section title="Озвучка" footer="Голоса берутся из системы. На iPhone дополнительные голоса ставятся в «Настройки → Универсальный доступ → Устный контент».">
          <div className="group">
            <div className="row">
              <label className="row__body" htmlFor="tts-front">
                <span className="row__title">Вопрос</span>
              </label>
              <select id="tts-front" className="select select--inline" value={cfg.ttsFront} onChange={(e) => patch({ ttsFront: e.target.value })}>
                <option value="">Выкл.</option>
                {TTS_LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="row">
              <label className="row__body" htmlFor="tts-back">
                <span className="row__title">Ответ</span>
              </label>
              <select id="tts-back" className="select select--inline" value={cfg.ttsBack} onChange={(e) => patch({ ttsBack: e.target.value })}>
                <option value="">Выкл.</option>
                {TTS_LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.name}
                  </option>
                ))}
              </select>
            </div>
            <SwitchRow
              title="Читать автоматически"
              sub="Иначе — по кнопке «Озвучить»"
              checked={cfg.autoTts}
              onChange={(v) => patch({ autoTts: v })}
            />
          </div>
        </Section>
      )}

      <Section>
        <div className="group">
          <ButtonRow onClick={() => void remove()} tone="danger" title="Удалить колоду" icon={<Trash2 size={18} />} iconColor="var(--danger)" />
        </div>
      </Section>
    </Screen>
  )
}
