import { useEffect, useState } from 'react'
import { Archive, Brain, Download, FileUp, HardDrive, Info, Layers, Smartphone, Trash2, Upload } from 'lucide-react'
import { Screen, Section } from '../ui/Screen'
import { ButtonRow, LinkRow, Segmented, StaticRow, Stepper, SwitchRow } from '../ui/controls'
import { useDialogs } from '../ui/Dialogs'
import { useToast } from '../ui/Toast'
import { db, requestPersistentStorage } from '../db/db'
import { DEFAULT_SETTINGS, setSetting, useSettings } from '../db/settings'
import { ensureBuiltins } from '../db/repo'
import type { Settings } from '../db/types'
import { parseSteps, parseWeights } from '../sched/fsrs'
import { backupFileName, exportBackup, inspectBackup, restoreBackup } from '../import/backup'
import { formatBytes, formatDateTime, formatPercent, count, DAYS, CARDS } from '../lib/format'
import { pickFile, shareOrDownload } from '../lib/platform'
import { useRoute } from '../lib/router'
import { autoBackup, autoBackupStatus, isNative, saveBackupToFiles, type AutoBackupStatus } from '../lib/native'

function TextSetting({
  id,
  label,
  value,
  hint,
  validate,
  onSave,
  mono,
}: {
  id: string
  label: string
  value: string
  hint: string
  validate: (v: string) => string | null
  onSave: (v: string) => void
  mono?: boolean
}) {
  const [v, setV] = useState(value)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => setV(value), [value])
  const commit = () => {
    const e = validate(v)
    setErr(e)
    if (!e && v.trim() !== value) onSave(v.trim())
  }
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className={`input${mono ? ' input--mono' : ''}`}
        value={v}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        aria-invalid={!!err}
        aria-describedby={`${id}-hint`}
        onChange={(e) => {
          setV(e.target.value)
          if (err) setErr(validate(e.target.value))
        }}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
      {err ? (
        <p className="field__error" id={`${id}-hint`} role="alert">
          {err}
        </p>
      ) : (
        <p className="field__hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
    </div>
  )
}

const stepsError = (v: string) => (parseSteps(v) === null ? 'Формат: «1m 10m» — минуты (m), часы (h) или дни (d) через пробел' : null)

export default function SettingsScreen() {
  const s = useSettings()
  const route = useRoute()
  const dialogs = useDialogs()
  const toast = useToast()
  const [usage, setUsage] = useState<{ used: number; quota: number } | null>(null)
  const [persisted, setPersisted] = useState<boolean | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [auto, setAuto] = useState<AutoBackupStatus | null>(null)
  const native = isNative()
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => void setSetting(k, v)

  useEffect(() => {
    if (native) void autoBackupStatus().then(setAuto)
  }, [native, busy])

  useEffect(() => {
    void navigator.storage?.estimate?.().then((e) => setUsage({ used: e.usage ?? 0, quota: e.quota ?? 0 }))
    void navigator.storage?.persisted?.().then(setPersisted)
  }, [busy])

  useEffect(() => {
    if (route.query.get('focus') === 'backup') {
      setTimeout(() => document.getElementById('backup')?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 150)
    }
  }, [route.query])

  const backup = async () => {
    setBusy('backup')
    try {
      const blob = await exportBackup()
      if (native) {
        // WKWebView has no downloads: the copy goes to the app's folder in Files.
        await saveBackupToFiles(blob, backupFileName())
        await setSetting('lastBackupAt', Date.now())
        toast.show(`Сохранено (${formatBytes(blob.size)}): Файлы → На iPhone → Mnemo → Backups`)
        return
      }
      const res = await shareOrDownload(blob, backupFileName())
      if (res !== 'cancelled') {
        await setSetting('lastBackupAt', Date.now())
        toast.show(res === 'shared' ? 'Копия готова' : `Копия сохранена (${formatBytes(blob.size)})`)
      }
    } catch (e) {
      toast.show(`Не удалось создать копию: ${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  const restore = async () => {
    const file = await pickFile('.zip,application/zip')
    if (!file) return
    try {
      const info = await inspectBackup(file)
      const ok = await dialogs.confirm({
        title: 'Заменить все данные?',
        message: `Копия от ${formatDateTime(info.exportedAt)}: ${count(info.cards, CARDS)}. Текущие колоды и история будут заменены.`,
        ok: 'Заменить',
        cancel: 'Отмена',
        danger: true,
      })
      if (!ok) return
      setBusy('restore')
      await restoreBackup(file)
      toast.show('Данные восстановлены')
    } catch (e) {
      await dialogs.alert({ title: 'Не удалось восстановить', message: (e as Error).message })
    } finally {
      setBusy(null)
    }
  }

  const wipe = async () => {
    const v = await dialogs.prompt({
      title: 'Удалить все данные?',
      message: 'Колоды, карточки, история и медиафайлы будут удалены с этого устройства. Чтобы подтвердить, введите «удалить».',
      label: 'Подтверждение',
      placeholder: 'удалить',
      ok: 'Удалить всё',
      validate: (x) => (x.toLowerCase() === 'удалить' ? null : 'Введите слово «удалить»'),
    })
    if (!v) return
    await db.transaction('rw', [db.decks, db.noteTypes, db.notes, db.cards, db.revlog, db.media, db.settings], async () => {
      await Promise.all([db.decks.clear(), db.noteTypes.clear(), db.notes.clear(), db.cards.clear(), db.revlog.clear(), db.media.clear(), db.settings.clear()])
    })
    await ensureBuiltins()
    toast.show('Все данные удалены')
  }

  const daysSinceBackup = s.lastBackupAt ? Math.floor((Date.now() - s.lastBackupAt) / 86_400_000) : null

  return (
    <Screen title="Настройки">
      <Section title="Обучение" footer="Удержание — с какой вероятностью вы должны вспомнить карточку в день повторения. 90 % — хороший баланс; 95 % почти вдвое увеличивает число повторений.">
        <div className="group">
          <div className="row">
            <label className="row__body" htmlFor="set-ret">
              <span className="row__title">Желаемое удержание</span>
            </label>
            <input
              id="set-ret"
              className="range"
              type="range"
              min={0.75}
              max={0.97}
              step={0.01}
              value={s.desiredRetention}
              onChange={(e) => set('desiredRetention', Number(e.target.value))}
            />
            <span className="row__value tabular">{formatPercent(s.desiredRetention)}</span>
          </div>
          <div className="row">
            <span className="row__body">
              <span className="row__title">Порядок показа</span>
              <span className="row__sub">Что показывать первым: новые карточки или повторения</span>
            </span>
          </div>
          <div className="row row--flush">
            <Segmented
              label="Порядок показа"
              value={s.reviewOrder}
              options={[
                { value: 'mix', label: 'Вперемешку' },
                { value: 'newFirst', label: 'Новые' },
                { value: 'reviewsFirst', label: 'Повторы' },
              ]}
              onChange={(v) => set('reviewOrder', v)}
            />
          </div>
          <SwitchRow title="Скрывать связанные карточки" sub="Обратная сторона той же записи — завтра" checked={s.burySiblings} onChange={(v) => set('burySiblings', v)} />
          <SwitchRow title="Только две кнопки" sub="«Снова» и «Хорошо» — проще и так же эффективно" checked={s.twoButtons} onChange={(v) => set('twoButtons', v)} />
          <SwitchRow title="Интервалы на кнопках" checked={s.showIntervals} onChange={(v) => set('showIntervals', v)} />
        </div>
      </Section>

      <Section title="Внешний вид">
        <div className="group pad stack">
          <div className="field">
            <span className="field__label" id="theme-label">
              Тема
            </span>
            <Segmented
              label="Тема"
              value={s.theme}
              options={[
                { value: 'system', label: 'Авто' },
                { value: 'light', label: 'Светлая' },
                { value: 'dark', label: 'Тёмная' },
              ]}
              onChange={(v) => set('theme', v)}
            />
            <span className="field__hint">«Авто» — как в настройках iPhone.</span>
          </div>
          <div className="field">
            <span className="field__label">Размер текста карточек</span>
            <Segmented
              label="Размер текста карточек"
              value={s.cardFontScale}
              options={[
                { value: 0.85, label: 'S', aria: 'Мелкий' },
                { value: 1, label: 'M', aria: 'Обычный' },
                { value: 1.15, label: 'L', aria: 'Крупный' },
                { value: 1.3, label: 'XL', aria: 'Очень крупный' },
              ]}
              onChange={(v) => set('cardFontScale', v)}
            />
          </div>
        </div>
        <div className="group" style={{ marginTop: 'var(--s-3)' }}>
          <SwitchRow title="Воспроизводить звук автоматически" sub="Аудио из карточек Anki" checked={s.autoplayAudio} onChange={(v) => set('autoplayAudio', v)} />
        </div>
      </Section>

      <Section
        title="Данные"
        id="backup"
        footer={
          native
            ? 'Карточки хранятся в приложении на этом iPhone. Автокопии лежат в «Файлах»; перед каждым продлением Mac забирает их к себе.'
            : 'Карточки хранятся только на этом устройстве. Сохраняйте копию в «Файлы» или iCloud Drive — из неё можно восстановить всё на другом устройстве.'
        }
      >
        <div className="group">
          <ButtonRow
            onClick={() => void backup()}
            disabled={busy === 'backup'}
            icon={<Download size={18} />}
            iconColor="#34C759"
            title={busy === 'backup' ? 'Готовлю копию…' : 'Сохранить резервную копию'}
            sub={daysSinceBackup == null ? 'Копий ещё не было' : daysSinceBackup === 0 ? 'Последняя — сегодня' : `Последняя — ${count(daysSinceBackup, DAYS)} назад`}
          />
          <ButtonRow onClick={() => void restore()} disabled={busy === 'restore'} icon={<Upload size={18} />} iconColor="#0A84FF" title={busy === 'restore' ? 'Восстанавливаю…' : 'Восстановить из копии'} />
          <LinkRow to="/import" icon={<FileUp size={18} />} iconColor="#FF9F0A" title="Импорт колод" sub="Anki (.apkg, .colpkg), CSV, TXT" />
        </div>
        {native && (
          <div className="group" style={{ marginTop: 'var(--s-3)' }}>
            <ButtonRow
              onClick={async () => {
                setBusy('auto')
                try {
                  const name = await autoBackup(true)
                  toast.show(name ? 'Автокопия сохранена' : 'Нечего сохранять: карточек пока нет')
                } catch (e) {
                  toast.show(`Не удалось: ${(e as Error).message}`)
                } finally {
                  setBusy(null)
                }
              }}
              disabled={busy === 'auto'}
              icon={<Archive size={18} />}
              iconColor="#30B0C7"
              title={busy === 'auto' ? 'Сохраняю…' : 'Автокопии на iPhone'}
              sub={
                auto?.lastAt
                  ? `Последняя: ${formatDateTime(auto.lastAt)} · хранится ${auto.files}. Файлы → На iPhone → Mnemo → Backups`
                  : 'Раз в день, хранятся 10 последних. Файлы → На iPhone → Mnemo → Backups'
              }
              label="Сделать автокопию сейчас"
            />
          </div>
        )}
        <div className="group" style={{ marginTop: 'var(--s-3)' }}>
          <StaticRow
            icon={<HardDrive size={18} />}
            iconColor="#8E8E93"
            title="Занято на устройстве"
            value={usage ? formatBytes(usage.used) : '—'}
          />
          {!native && (
            <div className="row row--icon">
              <span className="row__icon" style={{ background: '#5E5CE6' }} aria-hidden>
                <Archive size={18} />
              </span>
              <span className="row__body">
                <span className="row__title">Защита от удаления</span>
                <span className="row__sub">
                  {persisted ? 'Включена: система не удалит данные при нехватке места' : 'Попросить систему не удалять данные при нехватке места'}
                </span>
              </span>
              {!persisted && (
                <button
                  type="button"
                  className="btn btn--small btn--tinted"
                  onClick={async () => {
                    const ok = await requestPersistentStorage()
                    setPersisted(ok)
                    toast.show(ok ? 'Защита включена' : 'Система не разрешила. На iPhone установите Mnemo на экран «Домой».')
                  }}
                >
                  Включить
                </button>
              )}
            </div>
          )}
        </div>
      </Section>

      <Section title="Расписание" footer="Параметры по умолчанию подходят большинству. Шаги задают короткие повторы в день изучения.">
        <div className="group pad stack">
          <TextSetting id="set-steps" label="Шаги изучения" value={s.learningSteps} hint="Например: 1m 10m" validate={stepsError} onSave={(v) => set('learningSteps', v)} mono />
          <TextSetting id="set-relearn" label="Шаги переобучения" value={s.relearningSteps} hint="После «Снова» у выученной карточки. Например: 10m" validate={stepsError} onSave={(v) => set('relearningSteps', v)} mono />
        </div>
        <div className="group" style={{ marginTop: 'var(--s-3)' }}>
          <div className="row">
            <span className="row__body">
              <span className="row__title">Максимальный интервал</span>
              <span className="row__sub">в днях</span>
            </span>
            <Stepper value={s.maxInterval} min={30} max={36500} step={365} label="Максимальный интервал, дней" onChange={(v) => set('maxInterval', v)} />
          </div>
          <div className="row">
            <label className="row__body" htmlFor="set-cutoff">
              <span className="row__title">Новый день начинается</span>
            </label>
            <select id="set-cutoff" className="select select--inline" value={s.dayCutoff} onChange={(e) => set('dayCutoff', Number(e.target.value))}>
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  в {String(h).padStart(2, '0')}:00
                </option>
              ))}
            </select>
          </div>
          <div className="row">
            <span className="row__body">
              <span className="row__title">Порог «трудной» карточки</span>
              <span className="row__sub">Сколько раз забыть, чтобы получить метку leech</span>
            </span>
            <Stepper value={s.leechThreshold} min={3} max={50} label="Порог трудной карточки" onChange={(v) => set('leechThreshold', v)} />
          </div>
          <div className="row row--flush">
            <Segmented
              label="Что делать с трудной карточкой"
              value={s.leechAction}
              options={[
                { value: 'tag', label: 'Только пометить' },
                { value: 'suspend', label: 'Приостановить' },
              ]}
              onChange={(v) => set('leechAction', v)}
            />
          </div>
        </div>
        <details className="advanced">
          <summary>Параметры FSRS для опытных</summary>
          <div className="stack" style={{ marginTop: 'var(--s-3)' }}>
            <TextSetting
              id="set-w"
              label="Веса модели (w)"
              value={s.weights}
              hint="Пусто — стандартные веса FSRS-6. Можно вставить веса, оптимизированные в Anki: 21 (или 19, 17) чисел через запятую."
              validate={(v) => (!v.trim() || parseWeights(v) ? null : 'Нужно 17, 19 или 21 число через запятую')}
              onSave={(v) => set('weights', v)}
              mono
            />
            {s.weights && (
              <button type="button" className="btn btn--small btn--tinted" onClick={() => set('weights', DEFAULT_SETTINGS.weights)}>
                Вернуть стандартные веса
              </button>
            )}
          </div>
        </details>
      </Section>

      <Section title="Дополнительно">
        <div className="group">
          <LinkRow to="/settings/notetypes" icon={<Layers size={18} />} iconColor="#BF5AF2" title="Типы записей" sub="Поля, шаблоны карточек и оформление" />
          {!native && <LinkRow to="/install" icon={<Smartphone size={18} />} iconColor="#0A84FF" title="Установка на iPhone" />}
          <StaticRow icon={<Brain size={18} />} iconColor="#FF375F" title="Алгоритм" value="FSRS-6" />
          <StaticRow icon={<Info size={18} />} iconColor="#8E8E93" title="Версия" value={__APP_VERSION__} />
        </div>
      </Section>

      <Section>
        <div className="group">
          <ButtonRow onClick={() => void wipe()} tone="danger" icon={<Trash2 size={18} />} iconColor="var(--danger)" title="Удалить все данные" />
        </div>
      </Section>
    </Screen>
  )
}
