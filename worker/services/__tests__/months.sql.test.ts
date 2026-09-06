import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { getPlatformProxy, unstable_splitSqlQuery } from 'wrangler'
import type { PlatformProxy } from 'wrangler'
import {
  MemberAlreadyInMonthError,
  MemberNotActiveError,
  MemberNotFoundError,
  MonthHasNoMembersError,
  MonthNotEditableError,
  MonthNotFoundError,
  MonthNotPublishableError,
} from '../../errors/months'
import worker from '../../index'
import * as monthsRepository from '../../repositories/months'
import type { Month } from '../../types'
import { calculatePerMemberAmount, createDraftMonth, excludeMemberFromMonth, includeMemberInMonth, publishMonthAmount } from '../months'

describe('months (local D1)', () => {
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
      await includeMemberInMonth(db, month.id, 4)
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

  it('includes and re-includes a later active member only in the requested draft', async () => {
    const month = await seedMonth(1)
    const otherMonth = await createDraftMonth(db, { year: 2026, month: 10, billAmountEuros: 0 })
    await db.prepare("INSERT INTO members (id, name, email) VALUES (2, 'Later member', 'later@example.com')").run()

    await expect(includeMemberInMonth(db, month.id, 2)).resolves.toBeUndefined()
    expect(await monthsRepository.isMemberInMonth(db, month.id, 2)).toBe(true)
    expect(await monthsRepository.isMemberInMonth(db, otherMonth.id, 2)).toBe(false)

    await excludeMemberFromMonth(db, month.id, 2)
    await expect(includeMemberInMonth(db, month.id, 2)).resolves.toBeUndefined()
    expect(await monthsRepository.getMonthCalculationData(db, month.id)).toMatchObject({ member_count: 2 })
    expect(await storedMonth(month.id)).toEqual(month)
  })

  it('does not duplicate or replace an existing membership', async () => {
    const month = await seedMonth(1)
    const query = db.prepare('SELECT * FROM month_members WHERE month_id = ?').bind(month.id)
    const before = (await query.all()).results

    await expect(monthsRepository.addMemberToDraftMonth(db, month.id, 1)).resolves.toBe(false)
    await expect(includeMemberInMonth(db, month.id, 1)).rejects.toBeInstanceOf(MemberAlreadyInMonthError)
    expect((await query.all()).results).toEqual(before)
    expect(before).toHaveLength(1)
  })

  it.each(['PUBLISHED', 'CLOSED'] as const)('guards %s membership against insertion and deletion in SQL', async (status) => {
    const month = await seedMonth(2)
    await excludeMemberFromMonth(db, month.id, 2)
    await publishMonthAmount(db, month.id)
    await db.prepare('UPDATE months SET status = ? WHERE id = ?').bind(status, month.id).run()
    const before = await storedMonth(month.id)

    await expect(monthsRepository.addMemberToDraftMonth(db, month.id, 2)).resolves.toBe(false)
    await expect(monthsRepository.removeMemberFromDraftMonth(db, month.id, 1)).resolves.toBe(false)
    await expect(includeMemberInMonth(db, month.id, 2)).rejects.toBeInstanceOf(MonthNotEditableError)
    expect(await monthsRepository.isMemberInMonth(db, month.id, 1)).toBe(true)
    expect(await monthsRepository.isMemberInMonth(db, month.id, 2)).toBe(false)
    expect(await storedMonth(month.id)).toEqual(before)
  })

  it('guards against a missing month in SQL and reports it from the service', async () => {
    const month = await seedMonth(1)
    await db.prepare('DELETE FROM months WHERE id = ?').bind(month.id).run()

    await expect(monthsRepository.addMemberToDraftMonth(db, month.id, 1)).resolves.toBe(false)
    await expect(includeMemberInMonth(db, month.id, 1)).rejects.toBeInstanceOf(MonthNotFoundError)
    expect(await monthsRepository.isMemberInMonth(db, month.id, 1)).toBe(false)
  })

  it('guards against a missing member in SQL and reports it from the service', async () => {
    const month = await seedMonth(0)

    await expect(monthsRepository.addMemberToDraftMonth(db, month.id, 1)).resolves.toBe(false)
    await expect(includeMemberInMonth(db, month.id, 1)).rejects.toBeInstanceOf(MemberNotFoundError)
    expect(await monthsRepository.isMemberInMonth(db, month.id, 1)).toBe(false)
  })

  it('requires current global activation even for a previously included member', async () => {
    const month = await seedMonth(1)
    await excludeMemberFromMonth(db, month.id, 1)
    await db.prepare('UPDATE members SET is_active = 0 WHERE id = 1').run()

    await expect(monthsRepository.addMemberToDraftMonth(db, month.id, 1)).resolves.toBe(false)
    await expect(includeMemberInMonth(db, month.id, 1)).rejects.toBeInstanceOf(MemberNotActiveError)
    expect(await monthsRepository.isMemberInMonth(db, month.id, 1)).toBe(false)

    await db.prepare('UPDATE members SET is_active = 1 WHERE id = 1').run()
    await expect(includeMemberInMonth(db, month.id, 1)).resolves.toBeUndefined()
    expect(await monthsRepository.isMemberInMonth(db, month.id, 1)).toBe(true)
  })

  it('rejects inclusion when publication wins the SQL write ordering', async () => {
    const month = await seedMonth(2)
    await excludeMemberFromMonth(db, month.id, 2)
    const add = monthsRepository.addMemberToDraftMonth

    vi.spyOn(monthsRepository, 'addMemberToDraftMonth').mockImplementationOnce(async (...args) => {
      await expect(publishMonthAmount(db, month.id)).resolves.toBe(15200)
      return add(...args)
    })

    await expect(includeMemberInMonth(db, month.id, 2)).rejects.toBeInstanceOf(MonthNotEditableError)
    expect(await monthsRepository.isMemberInMonth(db, month.id, 2)).toBe(false)
    expect(await storedMonth(month.id)).toMatchObject({ status: 'PUBLISHED', per_member_amount_cents: 15200 })
  })

  it('rejects inclusion when the member is deactivated before the SQL write', async () => {
    const month = await seedMonth(1)
    await excludeMemberFromMonth(db, month.id, 1)
    const add = monthsRepository.addMemberToDraftMonth

    vi.spyOn(monthsRepository, 'addMemberToDraftMonth').mockImplementationOnce(async (...args) => {
      await db.prepare('UPDATE members SET is_active = 0 WHERE id = 1').run()
      return add(...args)
    })

    await expect(includeMemberInMonth(db, month.id, 1)).rejects.toBeInstanceOf(MemberNotActiveError)
    expect(await monthsRepository.isMemberInMonth(db, month.id, 1)).toBe(false)
  })

  it('allows only one competing inclusion to insert the membership', async () => {
    const month = await seedMonth(1)
    await excludeMemberFromMonth(db, month.id, 1)
    const add = monthsRepository.addMemberToDraftMonth

    vi.spyOn(monthsRepository, 'addMemberToDraftMonth').mockImplementationOnce(async (...args) => {
      await expect(includeMemberInMonth(db, month.id, 1)).resolves.toBeUndefined()
      return add(...args)
    })

    await expect(includeMemberInMonth(db, month.id, 1)).rejects.toBeInstanceOf(MemberAlreadyInMonthError)
    expect(await monthsRepository.getMonthCalculationData(db, month.id)).toMatchObject({ member_count: 1 })
  })

  it('returns HTTP 204 for inclusion, exclusion, and re-inclusion, then 409 for a duplicate', async () => {
    const month = await seedMonth(0)
    await db.prepare("INSERT INTO members (id, name, email) VALUES (1, 'Member', 'member@example.com')").run()
    const url = `https://example.com/api/months/${month.id}/members/1`

    for (const method of ['POST', 'DELETE', 'POST']) {
      const response = await worker.fetch(new Request(url, { method }), { DB: db })
      expect(response.status).toBe(204)
      expect(await response.text()).toBe('')
      expect(await monthsRepository.isMemberInMonth(db, month.id, 1)).toBe(method === 'POST')
    }

    const duplicate = await worker.fetch(new Request(url, { method: 'POST' }), { DB: db })
    expect(duplicate.status).toBe(409)
    expect(await duplicate.json()).toEqual({ error: 'member is already included in month' })
  })

  it.each([
    { state: 'missing month', status: 404, error: 'month not found' },
    { state: 'missing member', status: 404, error: 'member not found' },
    { state: 'inactive', status: 409, error: 'member is not active' },
    { state: 'PUBLISHED', status: 409, error: 'month is not editable' },
    { state: 'CLOSED', status: 409, error: 'month is not editable' },
  ])('maps $state inclusion to HTTP $status', async ({ state, status, error }) => {
    const month = await seedMonth(1)
    await excludeMemberFromMonth(db, month.id, 1)

    if (state === 'missing month') {
      await db.prepare('DELETE FROM months WHERE id = ?').bind(month.id).run()
    } else if (state === 'missing member') {
      await db.prepare('DELETE FROM members WHERE id = 1').run()
    } else if (state === 'inactive') {
      await db.prepare('UPDATE members SET is_active = 0 WHERE id = 1').run()
    } else {
      await db.prepare('UPDATE months SET status = ? WHERE id = ?').bind(state, month.id).run()
    }

    const response = await worker.fetch(new Request(
      `https://example.com/api/months/${month.id}/members/1`, { method: 'POST' },
    ), { DB: db })

    expect(response.status).toBe(status)
    expect(await response.json()).toEqual({ error })
    expect(await monthsRepository.isMemberInMonth(db, month.id, 1)).toBe(false)
  })

  it.each([
    '0/members/1',
    '1/members/0',
    '9007199254740992/members/1',
    '1/members/9007199254740992',
  ])('rejects invalid HTTP inclusion IDs: %s', async (path) => {
    const add = vi.spyOn(monthsRepository, 'addMemberToDraftMonth')
    const response = await worker.fetch(new Request(
      `https://example.com/api/months/${path}`, { method: 'POST' },
    ), { DB: db })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid id' })
    expect(add).not.toHaveBeenCalled()
  })

  it('returns an HTTP domain conflict if a concurrent exclusion obscures a duplicate no-op', async () => {
    const month = await seedMonth(1)
    const add = monthsRepository.addMemberToDraftMonth

    vi.spyOn(monthsRepository, 'addMemberToDraftMonth').mockImplementationOnce(async (...args) => {
      const added = await add(...args)
      expect(added).toBe(false)
      await excludeMemberFromMonth(db, month.id, 1)
      return added
    })

    const response = await worker.fetch(new Request(
      `https://example.com/api/months/${month.id}/members/1`, { method: 'POST' },
    ), { DB: db })

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'month membership conflicted with another change' })
    expect(await monthsRepository.isMemberInMonth(db, month.id, 1)).toBe(false)
  })

  it('returns an HTTP domain conflict if re-inclusion obscures a failed exclusion', async () => {
    const month = await seedMonth(1)
    const remove = monthsRepository.removeMemberFromDraftMonth

    vi.spyOn(monthsRepository, 'removeMemberFromDraftMonth').mockImplementationOnce(async (...args) => {
      await excludeMemberFromMonth(db, month.id, 1)
      const removed = await remove(...args)
      expect(removed).toBe(false)
      await includeMemberInMonth(db, month.id, 1)
      return removed
    })

    const response = await worker.fetch(new Request(
      `https://example.com/api/months/${month.id}/members/1`, { method: 'DELETE' },
    ), { DB: db })

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'month membership conflicted with another change' })
    expect(await monthsRepository.isMemberInMonth(db, month.id, 1)).toBe(true)
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
