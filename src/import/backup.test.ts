import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../db/db'
import { addNote, builtinTypeId, createDeck, ensureBuiltins } from '../db/repo'
import { putMediaFile } from '../db/media'
import { exportBackup, inspectBackup, isBackupZip, restoreBackup } from './backup'

beforeEach(async () => {
  await db.delete()
  await db.open()
  await ensureBuiltins()
})

describe('backup', () => {
  it('round-trips all data including media', async () => {
    const deckId = await createDeck('Языки::Английский')
    const typeId = await builtinTypeId('basic')
    await addNote(typeId, deckId, ['cat <img src="cat.png">', 'кошка'], ['animals'])
    await putMediaFile('cat.png', new Uint8Array([1, 2, 3, 4]))
    await db.revlog.add({ cardId: 1, deckId, time: 1, day: 1, rating: 3, state: 0, stability: 1, difficulty: 5, scheduledDays: 0, elapsedDays: 0, durationMs: 1000 })

    const blob = await exportBackup()
    expect(await isBackupZip(blob)).toBe(true)
    const info = await inspectBackup(blob)
    expect(info).toMatchObject({ decks: 2, notes: 1, cards: 1, reviews: 1, media: 1 })

    await db.delete()
    await db.open()
    await restoreBackup(blob)
    expect(await db.decks.count()).toBe(2)
    expect((await db.notes.toArray())[0].fields[0]).toContain('cat.png')
    const media = await db.media.get('cat.png')
    expect(new Uint8Array(await media!.blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]))
    expect(await db.revlog.count()).toBe(1)
  })
  it('rejects files that are not backups', async () => {
    const blob = new Blob(['hello'])
    expect(await isBackupZip(blob)).toBe(false)
    await expect(inspectBackup(blob)).rejects.toThrow(/резервная копия|повреждён/)
  })
})
