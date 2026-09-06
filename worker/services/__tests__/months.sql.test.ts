import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { getPlatformProxy, unstable_splitSqlQuery } from 'wrangler'
import type { PlatformProxy } from 'wrangler'
import { MonthHasNoMembersError, MonthNotEditableError, MonthNotPublishableError } from '../../errors/months'
import * as monthsRepository from '../../repositories/months'
import type { Month } from '../../types'
import { calculatePerMemberAmount, createDraftMonth, excludeMemberFromMonth, publishMonthAmount } from '../months'

describe('month publication (local D1)', () => {
  let platform: PlatformProxy<{ DB: D1Database }>
  let db: D1Database

  beforeAll(async () => {
    platform = await getPlatformProxy<{ DB: D1Database }>({
      configPath: fileURLToPath(new URL('../../../wrangler.jsonc', import.meta.url)),
      persist: false,
      remoteBindings: false,
    })
    db = platform.env.DB

    const migrations = new URL('../../../migrations/', import.meta.url)
    for (const filename of readdirSync(migrations).filter((name) => name.endsWith('.sql')).sort()) {
      const sql = readFileSync(new URL(filename, migrations), 'utf8')
      await db.batch(unstable_splitSqlQuery(sql).map((statement) => db.prepare(statement)))
    }
  }, 30_000)

  afterAll(async () => {
    await platform?.dispose()
  })

  beforeEach(async () => {
    await db.batch([
      db.prepare('DELETE FROM months'),
      db.prepare('DELETE FROM members'),
    ])
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  async function seedMonth(memberCount: number, billAmountEuros = 32) {
    for (let id = 1; id <= memberCount; id++) {
      await db.prepare('INSERT INTO members (id, name, email) VALUES (?, ?, ?)')
        .bind(id, `Member ${id}`, `member${id}@example.com`)
        .run()
    }

    return createDraftMonth(db, { year: 2026, month: 9, billAmountEuros })
  }

  async function storedMonth(monthId: number) {
    return db.prepare('SELECT * FROM months WHERE id = ?').bind(monthId).first<Month>()
  }

  it('uses the updated count when an exclusion commits after the publication precheck', async () => {
    const month = await seedMonth(4)
    const publish = monthsRepository.publishMonth

    // Interleave real SQL writes at the old read/write gap; no query results are mocked.
    vi.spyOn(monthsRepository, 'publishMonth').mockImplementationOnce(async (...args) => {
      await excludeMemberFromMonth(db, month.id, 4)
      return publish(...args)
    })

    await expect(publishMonthAmount(db, month.id)).resolves.toBe(5067)
    expect(await monthsRepository.getMonthCalculationData(db, month.id)).toMatchObject({ member_count: 3 })
    expect(await storedMonth(month.id)).toMatchObject({
      status: 'PUBLISHED',
      per_member_amount_cents: 5067,
      published_at: expect.any(String),
    })
  })

  it('rejects publication when the last member is excluded after the publication precheck', async () => {
    const month = await seedMonth(1)
    const publish = monthsRepository.publishMonth

    vi.spyOn(monthsRepository, 'publishMonth').mockImplementationOnce(async (...args) => {
      await excludeMemberFromMonth(db, month.id, 1)
      return publish(...args)
    })

    await expect(publishMonthAmount(db, month.id)).rejects.toBeInstanceOf(MonthHasNoMembersError)
    expect(await monthsRepository.getMonthCalculationData(db, month.id)).toMatchObject({ member_count: 0 })
    expect(await storedMonth(month.id)).toMatchObject({
      status: 'DRAFT',
      per_member_amount_cents: null,
      published_at: null,
    })
  })

  it('uses the updated count when a member is added after the publication precheck', async () => {
    const month = await seedMonth(3)
    await db.prepare("INSERT INTO members (id, name, email) VALUES (4, 'Added member', 'added@example.com')").run()
    const publish = monthsRepository.publishMonth

    vi.spyOn(monthsRepository, 'publishMonth').mockImplementationOnce(async (...args) => {
      await expect(monthsRepository.addMemberToDraftMonth(db, month.id, 4)).resolves.toBe(true)
      return publish(...args)
    })

    await expect(publishMonthAmount(db, month.id)).resolves.toBe(3800)
    expect(await monthsRepository.getMonthCalculationData(db, month.id)).toMatchObject({ member_count: 4 })
    expect(await storedMonth(month.id)).toMatchObject({
      status: 'PUBLISHED',
      per_member_amount_cents: 3800,
    })
  })

  it('rejects an exclusion when publication commits after the exclusion prechecks', async () => {
    const month = await seedMonth(3)
    const remove = monthsRepository.removeMemberFromDraftMonth

    vi.spyOn(monthsRepository, 'removeMemberFromDraftMonth').mockImplementationOnce(async (...args) => {
      await expect(publishMonthAmount(db, month.id)).resolves.toBe(5067)
      return remove(...args)
    })

    await expect(excludeMemberFromMonth(db, month.id, 3)).rejects.toBeInstanceOf(MonthNotEditableError)
    expect(await monthsRepository.isMemberInMonth(db, month.id, 3)).toBe(true)
    expect(await monthsRepository.getMonthCalculationData(db, month.id)).toMatchObject({ member_count: 3 })
    expect(await storedMonth(month.id)).toMatchObject({
      status: 'PUBLISHED',
      per_member_amount_cents: 5067,
    })
  })

  it('allows only one publisher to succeed after both have read DRAFT', async () => {
    const month = await seedMonth(3)
    const publish = monthsRepository.publishMonth

    vi.spyOn(monthsRepository, 'publishMonth').mockImplementationOnce(async (...args) => {
      await expect(publishMonthAmount(db, month.id)).resolves.toBe(5067)
      return publish(...args)
    })

    await expect(publishMonthAmount(db, month.id)).rejects.toBeInstanceOf(MonthNotPublishableError)
    expect(await storedMonth(month.id)).toMatchObject({
      status: 'PUBLISHED',
      per_member_amount_cents: 5067,
    })
  })

  it('guards against zero members in SQL without service prechecks', async () => {
    const month = await seedMonth(0)

    await expect(monthsRepository.publishMonth(db, month.id)).resolves.toBeNull()
    expect(await storedMonth(month.id)).toMatchObject({
      status: 'DRAFT',
      per_member_amount_cents: null,
      published_at: null,
    })
  })

  it.each(['PUBLISHED', 'CLOSED'] as const)('guards against publishing %s in SQL', async (status) => {
    const month = await seedMonth(3)
    await db.prepare('UPDATE months SET status = ? WHERE id = ?').bind(status, month.id).run()
    const before = await storedMonth(month.id)

    await expect(monthsRepository.publishMonth(db, month.id)).resolves.toBeNull()
    expect(await storedMonth(month.id)).toEqual(before)
  })

  it('uses only the target month membership, not current active members', async () => {
    const month = await seedMonth(3)
    await db.prepare('UPDATE members SET is_active = 0 WHERE id = 3').run()
    await db.prepare(`
      INSERT INTO members (name, email)
      VALUES ('Later member', 'later@example.com'), ('Another member', 'another@example.com')
    `).run()
    await createDraftMonth(db, { year: 2026, month: 10, billAmountEuros: 0 })

    await expect(publishMonthAmount(db, month.id)).resolves.toBe(5067)
    expect(await storedMonth(month.id)).toMatchObject({ per_member_amount_cents: 5067 })
  })

  it.each([
    { fixed: 12000, bill: 3200, members: 3 },
    { fixed: 12000, bill: 3200, members: 4 },
    { fixed: 12000, bill: 0, members: 1 },
    { fixed: 0, bill: 0, members: 3 },
    { fixed: 1, bill: 0, members: 3 },
    { fixed: 12000, bill: 9007199254740800, members: 3 },
  ])('persists Math.ceil for $fixed + $bill cents / $members members', async ({ fixed, bill, members }) => {
    const month = await seedMonth(members, bill / 100)
    await db.prepare('UPDATE months SET fixed_amount_cents = ? WHERE id = ?').bind(fixed, month.id).run()
    const expected = calculatePerMemberAmount(fixed, bill, members)

    await expect(publishMonthAmount(db, month.id)).resolves.toBe(expected)
    expect(await storedMonth(month.id)).toMatchObject({
      status: 'PUBLISHED',
      per_member_amount_cents: expected,
      published_at: expect.any(String),
    })
    expect(await db.prepare('SELECT typeof(per_member_amount_cents) AS type FROM months WHERE id = ?')
      .bind(month.id).first('type')).toBe('integer')
  })
})
