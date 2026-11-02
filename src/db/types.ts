/** FSRS card states, same numbering as ts-fsrs `State`. */
export const CardState = {
  New: 0,
  Learning: 1,
  Review: 2,
  Relearning: 3,
} as const
export type CardState = (typeof CardState)[keyof typeof CardState]

/** Answer buttons, same numbering as ts-fsrs `Rating` (without Manual). */
export type Grade = 1 | 2 | 3 | 4

export type NewOrder = 'added' | 'random'

export interface DeckConfig {
  newPerDay: number
  reviewsPerDay: number
  newOrder: NewOrder
  /** Overrides the global desired retention when set. */
  desiredRetention: number | null
  /** BCP-47 language for text-to-speech of the question / answer side ('' = off). */
  ttsFront: string
  ttsBack: string
  autoTts: boolean
}

export interface Deck {
  id: number
  /** Full path, levels separated by "::" (Anki convention). */
  name: string
  color: string
  emoji: string
  description: string
  config: DeckConfig
  collapsed: boolean
  createdAt: number
}

export interface NoteField {
  name: string
  /** Keep the value after adding a note (handy for source/extra fields). */
  sticky?: boolean
}

export interface NoteTemplate {
  name: string
  qfmt: string
  afmt: string
}

export type NoteKind = 'standard' | 'cloze'

export interface NoteType {
  id: number
  name: string
  kind: NoteKind
  fields: NoteField[]
  templates: NoteTemplate[]
  css: string
  sortField: number
  /** Key of a built-in type ('basic', 'cloze', ...); imported types have none. */
  builtin?: string
  /** Anki notetype id when imported, used to match on re-import. */
  ankiId?: number
  createdAt: number
  updatedAt: number
}

export interface Note {
  id: number
  typeId: number
  guid: string
  fields: string[]
  tags: string[]
  /** Lower-cased plain text of all fields, used for search. */
  searchText: string
  createdAt: number
  updatedAt: number
}

export interface Card {
  id: number
  noteId: number
  deckId: number
  /** Template index for standard notes, cloze number − 1 for cloze notes. */
  ord: number
  state: CardState
  /** Epoch ms. New cards: ordering key. Others: when the card is due. */
  due: number
  stability: number
  difficulty: number
  scheduledDays: number
  learningSteps: number
  reps: number
  lapses: number
  lastReview: number | null
  suspended: 0 | 1
  /** Study day the card is buried for (hidden until the next day), 0 = not buried. */
  buriedDay: number
  /** 0 = none, 1..7 = colour flag. */
  flag: number
  createdAt: number
  modifiedAt: number
}

export interface ReviewEntry {
  id?: number
  cardId: number
  deckId: number
  /** Epoch ms of the answer. */
  time: number
  /** Study day (see sched/day.ts) of the answer. */
  day: number
  rating: Grade
  /** State before the answer. */
  state: CardState
  /** Memory state after the answer. */
  stability: number
  difficulty: number
  /** Interval given by this answer, days (0 for learning steps). */
  scheduledDays: number
  /** Days since the previous review. */
  elapsedDays: number
  durationMs: number
}

export interface MediaFile {
  name: string
  blob: Blob
  type: string
  size: number
  createdAt: number
}

export interface SettingRow {
  key: string
  value: unknown
}

export type ReviewOrder = 'mix' | 'newFirst' | 'reviewsFirst'
export type ThemeSetting = 'system' | 'light' | 'dark'
export type LeechAction = 'tag' | 'suspend'

export interface Settings {
  desiredRetention: number
  maxInterval: number
  learningSteps: string
  relearningSteps: string
  /** Hour (0–23) at which a new study day starts. */
  dayCutoff: number
  learnAheadMin: number
  reviewOrder: ReviewOrder
  burySiblings: boolean
  twoButtons: boolean
  showIntervals: boolean
  leechThreshold: number
  leechAction: LeechAction
  theme: ThemeSetting
  cardFontScale: number
  autoplayAudio: boolean
  /** Custom FSRS weights, comma separated. Empty = defaults. */
  weights: string
  lastBackupAt: number
  onboarded: boolean
}
