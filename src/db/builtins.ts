import type { DeckConfig, NoteType } from './types'

export const DEFAULT_DECK_CONFIG: DeckConfig = {
  newPerDay: 20,
  reviewsPerDay: 200,
  newOrder: 'added',
  desiredRetention: null,
  ttsFront: '',
  ttsBack: '',
  autoTts: false,
}

export const DECK_COLORS = ['#5E5CE6', '#0A84FF', '#30B0C7', '#34C759', '#FF9F0A', '#FF6B3D', '#FF375F', '#BF5AF2', '#8E8E93']
export const DECK_COLOR_NAMES = ['Индиго', 'Синий', 'Бирюзовый', 'Зелёный', 'Оранжевый', 'Коралловый', 'Розовый', 'Фиолетовый', 'Серый']

export const BASE_CARD_CSS = `.card {
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, "Segoe UI", Roboto, sans-serif;
  font-size: 26px;
  line-height: 1.4;
  text-align: center;
  color: var(--card-text);
}
.cloze { font-weight: 700; color: var(--card-cloze); }
.extra { margin-top: 18px; font-size: 0.78em; color: var(--card-secondary); }
`

type BuiltinDef = Omit<NoteType, 'id' | 'createdAt' | 'updatedAt'>

const answerSep = '\n\n<hr id=answer>\n\n'

export const BUILTIN_NOTE_TYPES: BuiltinDef[] = [
  {
    builtin: 'basic',
    name: 'Базовая',
    kind: 'standard',
    fields: [{ name: 'Вопрос' }, { name: 'Ответ' }],
    templates: [{ name: 'Карточка 1', qfmt: '{{Вопрос}}', afmt: `{{FrontSide}}${answerSep}{{Ответ}}` }],
    css: BASE_CARD_CSS,
    sortField: 0,
  },
  {
    builtin: 'basic-reverse',
    name: 'Базовая + обратная',
    kind: 'standard',
    fields: [{ name: 'Вопрос' }, { name: 'Ответ' }],
    templates: [
      { name: 'Прямая', qfmt: '{{Вопрос}}', afmt: `{{FrontSide}}${answerSep}{{Ответ}}` },
      { name: 'Обратная', qfmt: '{{Ответ}}', afmt: `{{FrontSide}}${answerSep}{{Вопрос}}` },
    ],
    css: BASE_CARD_CSS,
    sortField: 0,
  },
  {
    builtin: 'basic-optional-reverse',
    name: 'Базовая (обратная по желанию)',
    kind: 'standard',
    fields: [{ name: 'Вопрос' }, { name: 'Ответ' }, { name: 'Добавить обратную' }],
    templates: [
      { name: 'Прямая', qfmt: '{{Вопрос}}', afmt: `{{FrontSide}}${answerSep}{{Ответ}}` },
      {
        name: 'Обратная',
        qfmt: '{{#Добавить обратную}}{{Ответ}}{{/Добавить обратную}}',
        afmt: `{{FrontSide}}${answerSep}{{Вопрос}}`,
      },
    ],
    css: BASE_CARD_CSS,
    sortField: 0,
  },
  {
    builtin: 'basic-type',
    name: 'Ввод ответа',
    kind: 'standard',
    fields: [{ name: 'Вопрос' }, { name: 'Ответ' }],
    templates: [
      {
        name: 'Карточка 1',
        qfmt: '{{Вопрос}}\n\n{{type:Ответ}}',
        afmt: `{{Вопрос}}${answerSep}{{type:Ответ}}`,
      },
    ],
    css: BASE_CARD_CSS,
    sortField: 0,
  },
  {
    builtin: 'cloze',
    name: 'Пропуски',
    kind: 'cloze',
    fields: [{ name: 'Текст' }, { name: 'Дополнительно' }],
    templates: [
      {
        name: 'Пропуск',
        qfmt: '{{cloze:Текст}}',
        afmt: '{{cloze:Текст}}\n\n{{#Дополнительно}}<div class="extra">{{Дополнительно}}</div>{{/Дополнительно}}',
      },
    ],
    css: BASE_CARD_CSS,
    sortField: 0,
  },
]

/** Short explanations shown in the note type picker. */
export const BUILTIN_HINTS: Record<string, string> = {
  basic: 'Вопрос → ответ',
  'basic-reverse': 'Две карточки: в обе стороны',
  'basic-optional-reverse': 'Обратная — если заполнить третье поле',
  'basic-type': 'Нужно напечатать ответ',
  cloze: 'Текст с пропусками {{c1::…}}',
}
