import { addNote, builtinTypeId, createDeck } from '../db/repo'
import { db } from '../db/db'

const INTRO: { type: string; fields: string[] }[] = [
  {
    type: 'basic',
    fields: [
      'Как отвечать на карточку?',
      'Вспомните ответ, нажмите «Показать ответ» и честно оцените себя:<br><b>Снова</b> — не вспомнили, <b>Трудно</b> — с трудом, <b>Хорошо</b> — вспомнили, <b>Легко</b> — сразу.',
    ],
  },
  {
    type: 'basic',
    fields: [
      'Что делает алгоритм FSRS?',
      'Подбирает интервал так, чтобы вы вспомнили карточку с вероятностью около 90&nbsp;%. Чем лучше вы знаете карточку, тем реже она появляется.',
    ],
  },
  {
    type: 'cloze',
    fields: [
      'Пропуск делают так: {{c1::выделите слово}} и нажмите на панели редактора кнопку {{c2::«c1»}}.',
      'Каждый номер пропуска — отдельная карточка.',
    ],
  },
  { type: 'basic-type', fields: ['Напечатайте ответ: столица Норвегии', 'Осло'] },
  {
    type: 'basic',
    fields: ['Где хранятся мои карточки?', 'Только на этом устройстве. Сохраняйте резервную копию: «Настройки → Резервная копия».'],
  },
]

const CAPITALS: [string, string][] = [
  ['Франции', 'Париж'],
  ['Германии', 'Берлин'],
  ['Италии', 'Рим'],
  ['Испании', 'Мадрид'],
  ['Португалии', 'Лиссабон'],
  ['Норвегии', 'Осло'],
  ['Швеции', 'Стокгольм'],
  ['Финляндии', 'Хельсинки'],
  ['Польши', 'Варшава'],
  ['Чехии', 'Прага'],
  ['Австрии', 'Вена'],
  ['Швейцарии', 'Берн'],
  ['Нидерландов', 'Амстердам'],
  ['Канады', 'Оттава'],
  ['Австралии', 'Канберра'],
  ['Бразилии', 'Бразилиа'],
  ['Египта', 'Каир'],
  ['Японии', 'Токио'],
  ['Турции', 'Анкара'],
  ['Мексики', 'Мехико'],
]

const WORDS: [string, string][] = [
  ['apple', 'яблоко'],
  ['to remember', 'помнить, запоминать'],
  ['knowledge', 'знание'],
  ['to forget', 'забывать'],
  ['repetition', 'повторение'],
  ['curious', 'любопытный'],
  ['reliable', 'надёжный'],
  ['to improve', 'улучшать'],
  ['opportunity', 'возможность'],
  ['achievement', 'достижение'],
]

export async function createDemoDecks(): Promise<number> {
  const introId = await createDeck('Знакомство с Mnemo', { emoji: '👋', color: '#5E5CE6', description: 'Короткий тур по приложению.' })
  for (const n of INTRO) await addNote(await builtinTypeId(n.type), introId, n.fields, ['демо'])

  const capId = await createDeck('Столицы мира', { emoji: '🌍', color: '#0A84FF' })
  const basic = await builtinTypeId('basic')
  for (const [country, city] of CAPITALS) await addNote(basic, capId, [`Столица ${country}`, city], ['география'])

  const enId = await createDeck('Английский::Базовые слова', {
    emoji: '🇬🇧',
    color: '#FF375F',
    config: { ttsFront: 'en-US', autoTts: true },
  })
  const parent = await db.decks.where('name').equals('Английский').first()
  if (parent) await db.decks.update(parent.id, { emoji: '🔤', color: '#FF6B3D' })
  for (const [en, ru] of WORDS) await addNote(basic, enId, [en, ru], ['английский'])
  return introId
}
