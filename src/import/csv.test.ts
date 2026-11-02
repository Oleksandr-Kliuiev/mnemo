import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../db/db'
import { builtinTypeId, createDeck, ensureBuiltins } from '../db/repo'
import { importRows, parseDelimited, parseTextFile } from './csv'

beforeEach(async () => {
  await db.delete()
  await db.open()
  await ensureBuiltins()
})

describe('csv parsing', () => {
  it('handles quotes, escaped quotes and multi-line cells', () => {
    const rows = parseDelimited('a,"b, c","he said ""hi"""\n"line1\nline2",x,y\n', ',')
    expect(rows).toEqual([
      ['a', 'b, c', 'he said "hi"'],
      ['line1\nline2', 'x', 'y'],
    ])
  })
  it('detects the delimiter and Anki headers', () => {
    const p = parseTextFile('#separator:tab\n#html:true\n#tags column:3\ncat\t<b>кошка</b>\tanimals\ndog\tсобака\tanimals\n')
    expect(p.delimiter).toBe('\t')
    expect(p.html).toBe(true)
    expect(p.tagsColumn).toBe(2)
    expect(p.rows).toHaveLength(2)
    expect(parseTextFile('a;b\nc;d\n').delimiter).toBe(';')
  })
})

describe('csv import', () => {
  it('imports rows, skips duplicates and empty rows, applies tags', async () => {
    const deckId = await createDeck('CSV')
    const typeId = await builtinTypeId('basic-reverse')
    const rows = [['front', 'back', 'tags'], ['cat', 'кошка', 'a b'], ['dog', 'собака', ''], ['', 'nothing', ''], ['cat', 'дубль', '']]
    const res = await importRows(rows, {
      typeId,
      deckId,
      fieldColumns: [0, 1],
      tagsColumn: 2,
      skipFirstRow: true,
      html: false,
      skipDuplicates: true,
      extraTags: ['csv'],
    })
    expect(res).toEqual({ added: 2, cards: 4, duplicates: 1, empty: 1 })
    const notes = await db.notes.toArray()
    expect(notes.find((n) => n.fields[0] === 'cat')?.tags.sort()).toEqual(['a', 'b', 'csv'])
    expect(await db.cards.where('deckId').equals(deckId).count()).toBe(4)
  })
  it('escapes plain text', async () => {
    const deckId = await createDeck('CSV')
    const typeId = await builtinTypeId('basic')
    await importRows([['a < b & c', 'x\ny']], { typeId, deckId, fieldColumns: [0, 1], tagsColumn: -1, skipFirstRow: false, html: false, skipDuplicates: false, extraTags: [] })
    const n = (await db.notes.toArray())[0]
    expect(n.fields).toEqual(['a &lt; b &amp; c', 'x<br>y'])
  })
})
