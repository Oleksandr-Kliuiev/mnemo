import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { CheckCircle2, ExternalLink, FileUp } from 'lucide-react'
import { Screen, Section } from '../ui/Screen'
import { useDialogs } from '../ui/Dialogs'
import { useToast } from '../ui/Toast'
import { StaticRow, SwitchRow } from '../ui/controls'
import { db, requestPersistentStorage } from '../db/db'
import { createDeck, leafName } from '../db/repo'
import { setSetting } from '../db/settings'
import type { ApkgImportResult, ApkgInfo } from '../import/apkg'
import { inspectBackup, isBackupZip, restoreBackup, type BackupInfo } from '../import/backup'
import { importRows, parseTextFile, type CsvResult, type Delimiter, type ParsedText } from '../import/csv'
import { navigate } from '../lib/router'
import { CARDS, count, DECKS, FILES, formatDateTime, formatNumber, NOTES } from '../lib/format'
import { pickFile } from '../lib/platform'

type Stage =
  | { k: 'pick' }
  | { k: 'reading'; name: string }
  | { k: 'apkg'; file: File; info: ApkgInfo }
  | { k: 'backup'; file: File; info: BackupInfo }
  | { k: 'csv'; file: File; text: string; parsed: ParsedText }
  | { k: 'working'; label: string; progress: number }
  | { k: 'doneApkg'; res: ApkgImportResult }
  | { k: 'doneCsv'; res: CsvResult; deckId: number }
  | { k: 'doneBackup'; info: BackupInfo }

const ROWS: [string, string, string] = ['строка', 'строки', 'строк']
const ACCEPT = '.apkg,.colpkg,.zip,.csv,.tsv,.txt,text/plain,text/csv,application/zip'

export default function ImportScreen() {
  const [stage, setStage] = useState<Stage>({ k: 'pick' })
  const [error, setError] = useState<string | null>(null)
  const [over, setOver] = useState(false)

  const open = async (file: File) => {
    setError(null)
    setStage({ k: 'reading', name: file.name })
    const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
    try {
      if (ext === 'apkg' || ext === 'colpkg') {
        const { inspectApkg } = await import('../import/apkg')
        setStage({ k: 'apkg', file, info: await inspectApkg(file) })
      } else if (ext === 'zip') {
        if (await isBackupZip(file)) setStage({ k: 'backup', file, info: await inspectBackup(file) })
        else {
          const { inspectApkg } = await import('../import/apkg')
          setStage({ k: 'apkg', file, info: await inspectApkg(file) })
        }
      } else if (['csv', 'tsv', 'txt'].includes(ext) || file.type.startsWith('text/')) {
        const text = await file.text()
        const parsed = parseTextFile(text)
        if (!parsed.rows.length) throw new Error('В файле нет строк для импорта')
        setStage({ k: 'csv', file, text, parsed })
      } else {
        throw new Error('Этот формат не поддерживается. Подойдут .apkg, .colpkg, резервная копия .zip, .csv и .txt')
      }
    } catch (e) {
      setError((e as Error).message || 'Не удалось прочитать файл')
      setStage({ k: 'pick' })
    }
  }

  const choose = async () => {
    const f = await pickFile(ACCEPT)
    if (f) await open(f)
  }

  return (
    <Screen title="Импорт" large={false} back={{ label: 'Назад', fallback: '/settings' }}>
      {stage.k === 'pick' && (
        <>
          <div
            className={`drop${over ? ' drop--over' : ''}`}
            role="button"
            tabIndex={0}
            onClick={() => void choose()}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), void choose())}
            onDragOver={(e) => {
              e.preventDefault()
              setOver(true)
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault()
              setOver(false)
              const f = e.dataTransfer.files[0]
              if (f) void open(f)
            }}
            aria-describedby="drop-hint"
          >
            <FileUp size={36} aria-hidden />
            <span className="drop__title">Выбрать файл</span>
            <span id="drop-hint">Колода Anki (.apkg), коллекция (.colpkg), резервная копия Mnemo (.zip), таблица (.csv, .txt)</span>
          </div>
          {error && (
            <p className="field__error" role="alert" style={{ marginTop: 'var(--s-3)' }}>
              {error}
            </p>
          )}
          <Section title="Где взять колоды" footer="На iPhone скачанный файл попадает в «Файлы → Загрузки». Нажмите «Выбрать файл» и найдите его там.">
            <div className="group">
              <a className="row" href="https://ankiweb.net/shared/decks" target="_blank" rel="noopener noreferrer">
                <span className="row__body">
                  <span className="row__title">Общие колоды AnkiWeb</span>
                  <span className="row__sub">Тысячи готовых колод: языки, медицина, география…</span>
                </span>
                <ExternalLink size={18} className="row__chev" aria-hidden />
              </a>
              <StaticRow title="Своя коллекция из Anki" sub="В Anki на компьютере: Файл → Экспорт → «Колода Anki (.apkg)» с расписанием." />
            </div>
          </Section>
        </>
      )}

      {stage.k === 'reading' && <Progress label={`Читаю «${stage.name}»…`} />}
      {stage.k === 'working' && <Progress label={stage.label} value={stage.progress} />}
      {stage.k === 'apkg' && <ApkgStep file={stage.file} info={stage.info} setStage={setStage} setError={setError} />}
      {stage.k === 'backup' && <BackupStep file={stage.file} info={stage.info} setStage={setStage} setError={setError} />}
      {stage.k === 'csv' && <CsvStep stage={stage} setStage={setStage} setError={setError} />}
      {stage.k === 'doneApkg' && <DoneApkg res={stage.res} />}
      {stage.k === 'doneCsv' && <DoneCsv res={stage.res} deckId={stage.deckId} />}
      {stage.k === 'doneBackup' && (
        <Done title="Данные восстановлены" lines={[count(stage.info.decks, DECKS), count(stage.info.cards, CARDS), `${formatNumber(stage.info.reviews)} ответов в истории`]} />
      )}
    </Screen>
  )
}

function Progress({ label, value }: { label: string; value?: number }) {
  return (
    <div className="stack import-progress" role="status" aria-live="polite">
      <p>{label}</p>
      <div className="bar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value != null ? Math.round(value * 100) : undefined}>
        <div className="bar__fill" style={{ width: value != null ? `${Math.round(value * 100)}%` : '35%' }} />
      </div>
      <p className="muted small">Не закрывайте приложение до конца импорта.</p>
    </div>
  )
}

function Done({ title, lines, children }: { title: string; lines: string[]; children?: React.ReactNode }) {
  return (
    <div className="finish">
      <div className="finish__art" aria-hidden>
        <CheckCircle2 size={48} />
      </div>
      <h2 className="finish__title">{title}</h2>
      <ul className="done-list">
        {lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
      {children}
      <div className="finish__actions">
        <button type="button" className="btn btn--block" onClick={() => navigate('/', { replace: true })}>
          К колодам
        </button>
      </div>
    </div>
  )
}

function DoneApkg({ res }: { res: ApkgImportResult }) {
  const lines = [
    `Добавлено: ${count(res.notesAdded, NOTES)}, ${count(res.cardsAdded, CARDS)}`,
    res.notesUpdated ? `Обновлено: ${count(res.notesUpdated, NOTES)}` : '',
    res.notesSkipped ? `Пропущено (уже есть): ${count(res.notesSkipped, NOTES)}` : '',
    res.media ? `Медиафайлы: ${formatNumber(res.media)}` : '',
    res.reviewsImported ? `История ответов: ${formatNumber(res.reviewsImported)}` : '',
    res.decks.length ? `Колоды: ${res.decks.map(leafName).join(', ')}` : '',
  ].filter(Boolean)
  return (
    <Done title="Колода импортирована" lines={lines}>
      {res.warnings.length > 0 && (
        <div className="banner banner--warning" style={{ width: '100%', textAlign: 'left' }}>
          <div className="banner__body">
            <span className="banner__title">Обратите внимание</span>
            <ul className="done-list done-list--left">
              {res.warnings.slice(0, 6).map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </Done>
  )
}

function DoneCsv({ res, deckId }: { res: CsvResult; deckId: number }) {
  return (
    <Done
      title="Импорт завершён"
      lines={[
        `Добавлено: ${count(res.added, NOTES)}, ${count(res.cards, CARDS)}`,
        res.duplicates ? `Пропущено дубликатов: ${formatNumber(res.duplicates)}` : '',
        res.empty ? `Пустых строк: ${formatNumber(res.empty)}` : '',
      ].filter(Boolean)}
    >
      <button type="button" className="btn btn--block btn--tinted" onClick={() => navigate(`/deck/${deckId}`, { replace: true })}>
        Открыть колоду
      </button>
    </Done>
  )
}

type SetStage = (s: Stage) => void

function ApkgStep({ file, info, setStage, setError }: { file: File; info: ApkgInfo; setStage: SetStage; setError: (e: string | null) => void }) {
  const [keep, setKeep] = useState(true)
  const toast = useToast()
  const run = async () => {
    setStage({ k: 'working', label: 'Импорт…', progress: 0 })
    try {
      const { importApkg } = await import('../import/apkg')
      const res = await importApkg(file, {
        keepScheduling: info.hasScheduling && keep,
        onProgress: (label, progress) => setStage({ k: 'working', label, progress }),
      })
      void requestPersistentStorage()
      setStage({ k: 'doneApkg', res })
    } catch (e) {
      setError((e as Error).message)
      toast.show('Импорт не удался')
      setStage({ k: 'pick' })
    }
  }
  return (
    <>
      <Section title={file.name} big>
        <div className="group">
          <StaticRow title="Записи" value={formatNumber(info.notes)} />
          <StaticRow title="Карточки" value={formatNumber(info.cards)} />
          <StaticRow title="Колоды" value={formatNumber(info.decks.length)} sub={info.decks.slice(0, 4).map(leafName).join(', ') + (info.decks.length > 4 ? '…' : '')} />
          <StaticRow title="Типы записей" value={formatNumber(info.noteTypes.length)} />
          <StaticRow title="Медиафайлы" value={formatNumber(info.mediaCount)} />
        </div>
      </Section>
      {info.hasScheduling && (
        <Section footer="Если выключить, все карточки станут новыми.">
          <div className="group">
            <SwitchRow title="Сохранить прогресс повторений" sub="Интервалы и история ответов из Anki" checked={keep} onChange={setKeep} />
          </div>
        </Section>
      )}
      <div className="spacer" />
      <button type="button" className="btn btn--block" onClick={() => void run()}>
        Импортировать {count(info.cards, CARDS)}
      </button>
      <button type="button" className="btn btn--block btn--plain" style={{ marginTop: 'var(--s-2)' }} onClick={() => setStage({ k: 'pick' })}>
        Выбрать другой файл
      </button>
    </>
  )
}

function BackupStep({ file, info, setStage, setError }: { file: File; info: BackupInfo; setStage: SetStage; setError: (e: string | null) => void }) {
  const dialogs = useDialogs()
  const run = async () => {
    const ok = await dialogs.confirm({
      title: 'Заменить все данные?',
      message: 'Текущие колоды, карточки и история будут заменены содержимым копии. Сначала можно сохранить копию текущих данных в настройках.',
      ok: 'Заменить',
      cancel: 'Отмена',
      danger: true,
    })
    if (!ok) return
    setStage({ k: 'working', label: 'Восстановление…', progress: 0.1 })
    try {
      const res = await restoreBackup(file, (p) => setStage({ k: 'working', label: 'Восстановление…', progress: p }))
      setStage({ k: 'doneBackup', info: res })
    } catch (e) {
      setError((e as Error).message)
      setStage({ k: 'pick' })
    }
  }
  return (
    <>
      <Section title="Резервная копия Mnemo">
        <div className="group">
          <StaticRow title="Создана" value={formatDateTime(info.exportedAt)} />
          <StaticRow title="Колоды" value={formatNumber(info.decks)} />
          <StaticRow title="Карточки" value={formatNumber(info.cards)} />
          <StaticRow title="Ответов в истории" value={formatNumber(info.reviews)} />
          <StaticRow title="Медиафайлы" value={count(info.media, FILES)} />
        </div>
      </Section>
      <div className="spacer" />
      <button type="button" className="btn btn--block" onClick={() => void run()}>
        Восстановить
      </button>
      <button type="button" className="btn btn--block btn--plain" style={{ marginTop: 'var(--s-2)' }} onClick={() => setStage({ k: 'pick' })}>
        Отмена
      </button>
    </>
  )
}

const DELIMS: { value: Delimiter; label: string }[] = [
  { value: '\t', label: 'Табуляция' },
  { value: ';', label: 'Точка с запятой' },
  { value: ',', label: 'Запятая' },
  { value: '|', label: 'Черта |' },
]

function CsvStep({ stage, setStage, setError }: { stage: Extract<Stage, { k: 'csv' }>; setStage: SetStage; setError: (e: string | null) => void }) {
  const types = useLiveQuery(() => db.noteTypes.toArray(), [])
  const decks = useLiveQuery(async () => (await db.decks.toArray()).sort((a, b) => a.name.localeCompare(b.name, 'ru')), [])
  const [parsed, setParsed] = useState(stage.parsed)
  const [typeId, setTypeId] = useState<number | null>(null)
  const [deckId, setDeckId] = useState<number | 'new'>('new')
  const [newDeckName, setNewDeckName] = useState(stage.file.name.replace(/\.[^.]+$/, ''))
  const [header, setHeader] = useState(false)
  const [skipDupes, setSkipDupes] = useState(true)
  const [cols, setCols] = useState<number[] | null>(null)
  const [tagsCol, setTagsCol] = useState(stage.parsed.tagsColumn)

  const type = types?.find((t) => t.id === typeId) ?? types?.find((t) => t.builtin === 'basic')
  const width = Math.max(0, ...parsed.rows.slice(0, 50).map((r) => r.length))
  const fieldCols = cols && type && cols.length === type.fields.length ? cols : (type?.fields.map((_, i) => (i < width ? i : -1)) ?? [])
  const dataRows = header ? parsed.rows.length - 1 : parsed.rows.length

  if (!types || !decks || !type) return <Progress label="Подготовка…" />

  const run = async () => {
    setStage({ k: 'working', label: 'Импорт строк…', progress: 0 })
    try {
      const target = deckId === 'new' ? await createDeck(newDeckName.trim() || 'Импорт') : deckId
      const res = await importRows(
        parsed.rows,
        {
          typeId: type.id,
          deckId: target,
          fieldColumns: fieldCols,
          tagsColumn: tagsCol,
          skipFirstRow: header,
          html: parsed.html,
          skipDuplicates: skipDupes,
          extraTags: [],
        },
        (p) => setStage({ k: 'working', label: 'Импорт строк…', progress: p }),
      )
      void setSetting('onboarded', true)
      void requestPersistentStorage()
      setStage({ k: 'doneCsv', res, deckId: target })
    } catch (e) {
      setError((e as Error).message)
      setStage({ k: 'pick' })
    }
  }

  const colLabel = (i: number) => (parsed.columns?.[i] ? `${i + 1}: ${parsed.columns[i]}` : header ? `${i + 1}: ${parsed.rows[0]?.[i] ?? ''}` : `Столбец ${i + 1}`)
  const preview = parsed.rows.slice(0, 6)

  return (
    <>
      <Section title={`${stage.file.name} · ${count(dataRows, ROWS)}`} big>
        <div className="table-scroll">
          <table className="table">
            <caption className="sr-only">Первые строки файла</caption>
            <thead>
              <tr>
                {Array.from({ length: width }, (_, i) => (
                  <th key={i} scope="col">
                    {i + 1}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {preview.map((r, i) => (
                <tr key={i} className={header && i === 0 ? 'muted' : undefined}>
                  {Array.from({ length: width }, (_, j) => (
                    <td key={j}>{(r[j] ?? '').replace(/<[^>]*>/g, ' ').slice(0, 60)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Файл">
        <div className="group">
          <div className="row">
            <label className="row__body" htmlFor="csv-delim">
              <span className="row__title">Разделитель</span>
            </label>
            <select
              id="csv-delim"
              className="select select--inline"
              value={parsed.delimiter}
              onChange={(e) => {
                setParsed(parseTextFile(stage.text, e.target.value as Delimiter))
                setCols(null)
              }}
            >
              {DELIMS.map((d) => (
                <option key={d.label} value={d.value}>
                  {d.label}
                </option>
              ))}
            </select>
          </div>
          <SwitchRow title="Первая строка — заголовки" checked={header} onChange={setHeader} />
          <SwitchRow title="Пропускать дубликаты" sub="Если первое поле уже есть в записях этого типа" checked={skipDupes} onChange={setSkipDupes} />
        </div>
      </Section>

      <Section title="Куда">
        <div className="group">
          <div className="row">
            <label className="row__body" htmlFor="csv-type">
              <span className="row__title">Тип записи</span>
            </label>
            <select
              id="csv-type"
              className="select select--inline"
              value={type.id}
              onChange={(e) => {
                setTypeId(Number(e.target.value))
                setCols(null)
              }}
            >
              {types.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
          <div className="row">
            <label className="row__body" htmlFor="csv-deck">
              <span className="row__title">Колода</span>
            </label>
            <select id="csv-deck" className="select select--inline" value={deckId} onChange={(e) => setDeckId(e.target.value === 'new' ? 'new' : Number(e.target.value))}>
              <option value="new">Новая колода…</option>
              {decks.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name.split('::').join(' › ')}
                </option>
              ))}
            </select>
          </div>
          {deckId === 'new' && (
            <div className="row">
              <label className="sr-only" htmlFor="csv-newdeck">
                Название новой колоды
              </label>
              <input id="csv-newdeck" className="input" value={newDeckName} onChange={(e) => setNewDeckName(e.target.value)} placeholder="Название новой колоды" />
            </div>
          )}
        </div>
      </Section>

      <Section title="Поля" footer={parsed.html ? 'Ячейки содержат HTML — форматирование сохранится.' : 'Текст будет импортирован как есть.'}>
        <div className="group">
          {type.fields.map((f, i) => (
            <div className="row" key={f.name}>
              <label className="row__body" htmlFor={`csv-f-${i}`}>
                <span className="row__title">{f.name}</span>
              </label>
              <select
                id={`csv-f-${i}`}
                className="select select--inline"
                value={fieldCols[i] ?? -1}
                onChange={(e) => {
                  const next = [...fieldCols]
                  next[i] = Number(e.target.value)
                  setCols(next)
                }}
              >
                <option value={-1}>Не заполнять</option>
                {Array.from({ length: width }, (_, c) => (
                  <option key={c} value={c}>
                    {colLabel(c)}
                  </option>
                ))}
              </select>
            </div>
          ))}
          <div className="row">
            <label className="row__body" htmlFor="csv-tags">
              <span className="row__title">Метки</span>
            </label>
            <select id="csv-tags" className="select select--inline" value={tagsCol} onChange={(e) => setTagsCol(Number(e.target.value))}>
              <option value={-1}>Нет</option>
              {Array.from({ length: width }, (_, c) => (
                <option key={c} value={c}>
                  {colLabel(c)}
                </option>
              ))}
            </select>
          </div>
        </div>
      </Section>

      <div className="spacer" />
      <button type="button" className="btn btn--block" onClick={() => void run()} disabled={fieldCols.every((c) => c < 0)}>
        Импортировать {count(dataRows, ['строку', 'строки', 'строк'])}
      </button>
      {fieldCols.every((c) => c < 0) && <p className="section__foot">Выберите столбец хотя бы для одного поля.</p>}
      <button type="button" className="btn btn--block btn--plain" style={{ marginTop: 'var(--s-2)' }} onClick={() => setStage({ k: 'pick' })}>
        Выбрать другой файл
      </button>
    </>
  )
}
