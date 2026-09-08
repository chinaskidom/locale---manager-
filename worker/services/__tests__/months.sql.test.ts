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
import type { Month, MonthMember } from '../../types'
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

  it('returns HTTP 200 with an empty month list', async () => {
    const response = await worker.fetch(new Request('https://example.com/api/months'), { DB: db })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await response.json()).toEqual([])
  })

  it('lists only persisted month fields over HTTP, newest year/month first', async () => {
    const september = await seedMonth(2)
    const january = await createDraftMonth(db, { year: 2027, month: 1, billAmountEuros: 0 })
    const december = await createDraftMonth(db, { year: 2026, month: 12, billAmountEuros: 100 })

    // Stored quotas deliberately differ from fresh allocations to detect recalculation.
    await db.batch([
      db.prepare(`
        UPDATE months
        SET status = 'PUBLISHED', per_member_amount_cents = 4321, published_at = '2026-12-02 10:00:00'
        WHERE id = ?
      `).bind(december.id),
      db.prepare(`
        UPDATE months
        SET status = 'CLOSED', per_member_amount_cents = 1234,
          published_at = '2026-09-02 10:00:00', closed_at = '2026-09-30 18:00:00'
        WHERE id = ?
      `).bind(september.id),
    ])

    const response = await worker.fetch(new Request('https://example.com/api/months'), { DB: db })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([
      january,
      { ...december, status: 'PUBLISHED', per_member_amount_cents: 4321, published_at: '2026-12-02 10:00:00' },
      {
        ...september,
        status: 'CLOSED',
        per_member_amount_cents: 1234,
        published_at: '2026-09-02 10:00:00',
        closed_at: '2026-09-30 18:00:00',
      },
    ])
  })

  it('propagates D1 failures from month listing rather than returning an empty list', async () => {
    const failingDb = {
      prepare: () => db.prepare('SELECT * FROM missing_months_table'),
    } as unknown as D1Database

    await expect(worker.fetch(new Request('https://example.com/api/months'), { DB: failingDb }))
      .rejects.toThrow('no such table: missing_months_table')
  })

  it.each([0, 2])('returns HTTP detail for a DRAFT with %i participants and no official quota', async (memberCount) => {
    const month = await seedMonth(memberCount)
    const response = await worker.fetch(new Request(
      `https://example.com/api/months/${month.id}`,
    ), { DB: db })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      ...month,
      participants: Array.from({ length: memberCount }, (_, index) => ({
        member_id: index + 1,
        name: `Member ${index + 1}`,
        payment_status: 'UNPAID',
        paid_at: null,
      })),
    })
    expect(await storedMonth(month.id)).toEqual(month)
  })

  it.each(['PUBLISHED', 'CLOSED'] as const)('returns persisted %s detail with only month-specific participant fields', async (status) => {
    const month = await seedMonth(3)
    await excludeMemberFromMonth(db, month.id, 3)
    await publishMonthAmount(db, month.id)
    const publishedAt = '2026-09-02 10:00:00'
    const closedAt = status === 'CLOSED' ? '2026-09-30 18:00:00' : null
    const paidAt = '2026-09-21 12:34:56'

    // A distinct persisted quota makes accidental recalculation observable.
    await db.prepare(`
      UPDATE months
      SET status = ?, per_member_amount_cents = 4321, published_at = ?, closed_at = ?
      WHERE id = ?
    `).bind(status, publishedAt, closedAt, month.id).run()
    await db.prepare('UPDATE members SET is_active = 0 WHERE id = 1').run()
    await db.prepare("INSERT INTO members (id, name, email) VALUES (4, 'Later member', 'later@example.com')").run()
    const otherMonth = await createDraftMonth(db, { year: 2026, month: 10, billAmountEuros: 0 })
    await db.prepare("UPDATE month_members SET payment_status = 'PAID', paid_at = ? WHERE month_id = ? AND member_id = 1")
      .bind(paidAt, month.id).run()
    await db.prepare("UPDATE month_members SET payment_status = 'PAID', paid_at = ? WHERE month_id = ? AND member_id = 2")
      .bind('2026-10-21 09:00:00', otherMonth.id).run()
    const beforeMembers = (await db.prepare('SELECT * FROM month_members ORDER BY id').all<MonthMember>()).results

    const response = await worker.fetch(new Request(
      `https://example.com/api/months/${month.id}`,
    ), { DB: db })

    const expectedMonth = {
      ...month,
      status,
      per_member_amount_cents: 4321,
      published_at: publishedAt,
      closed_at: closedAt,
    }
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      ...expectedMonth,
      participants: [
        { member_id: 1, name: 'Member 1', payment_status: 'PAID', paid_at: paidAt },
        { member_id: 2, name: 'Member 2', payment_status: 'UNPAID', paid_at: null },
      ],
    })
    expect(await storedMonth(month.id)).toEqual(expectedMonth)
    expect((await db.prepare('SELECT * FROM month_members ORDER BY id').all<MonthMember>()).results).toEqual(beforeMembers)
  })

  it('returns HTTP 404 for a missing month detail', async () => {
    const response = await worker.fetch(new Request(
      'https://example.com/api/months/999',
    ), { DB: db })

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'month not found' })
  })

  it.each(['0', '-1', '1.5', 'abc', '9007199254740992', '1e2', '0x1', '%20'])('rejects invalid HTTP detail ID %s before querying D1', async (id) => {
    const read = vi.spyOn(monthsRepository, 'getMonthDetail')
    const response = await worker.fetch(new Request(
      `https://example.com/api/months/${id}`,
    ), { DB: db })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid month id' })
    expect(read).not.toHaveBeenCalled()
  })

  it('backfills existing participants without changing membership or month amounts', async () => {
    const legacy = await getPlatformProxy<{ DB: D1Database }>({
      configPath: fileURLToPath(new URL('../../../wrangler.jsonc', import.meta.url)),
      persist: false,
      remoteBindings: false,
    })

    try {
      const legacyDb = legacy.env.DB
      const migrations = new URL('../../../migrations/', import.meta.url)
      const paymentMigration = '0005_add_month_member_payments.sql'
      for (const filename of readdirSync(migrations).filter((name) => name.endsWith('.sql') && name < paymentMigration).sort()) {
        const sql = readFileSync(new URL(filename, migrations), 'utf8')
        await legacyDb.batch(unstable_splitSqlQuery(sql).map((statement) => legacyDb.prepare(statement)))
      }

      await legacyDb.prepare(`
        INSERT INTO members (id, name, email)
        VALUES (1, 'Member 1', 'member1@example.com'), (2, 'Member 2', 'member2@example.com')
      `).run()
      for (const monthNumber of [9, 10, 11]) {
        const month = await createDraftMonth(legacyDb, { year: 2026, month: monthNumber, billAmountEuros: 32 })
        if (monthNumber === 9) {
          await excludeMemberFromMonth(legacyDb, month.id, 2)
        } else {
          await publishMonthAmount(legacyDb, month.id)
          if (monthNumber === 11) {
            await legacyDb.prepare("UPDATE months SET status = 'CLOSED' WHERE id = ?").bind(month.id).run()
          }
        }
      }
      await legacyDb.prepare('UPDATE members SET is_active = 0 WHERE id = 2').run()
      await legacyDb.prepare("INSERT INTO members (name, email) VALUES ('Later member', 'later@example.com')").run()
      const beforeMembers = (await legacyDb.prepare('SELECT * FROM month_members ORDER BY id').all()).results
      const beforeMonths = (await legacyDb.prepare('SELECT * FROM months ORDER BY id').all<Month>()).results

      const sql = readFileSync(new URL(paymentMigration, migrations), 'utf8')
      await legacyDb.batch(unstable_splitSqlQuery(sql).map((statement) => legacyDb.prepare(statement)))

      expect(beforeMembers).toHaveLength(5)
      expect((await legacyDb.prepare('SELECT * FROM month_members ORDER BY id').all<MonthMember>()).results).toEqual(
        beforeMembers.map((member) => ({ ...member, payment_status: 'UNPAID', paid_at: null })),
      )
      expect((await legacyDb.prepare('SELECT * FROM months ORDER BY id').all<Month>()).results).toEqual(beforeMonths)
    } finally {
      await legacy.dispose()
    }
  }, 30_000)

  it('defaults trigger-created participants to UNPAID with no paid timestamp', async () => {
    const month = await seedMonth(2)
    const participants = await db.prepare('SELECT * FROM month_members WHERE month_id = ?')
      .bind(month.id).all<MonthMember>()

    expect(participants.results).toHaveLength(2)
    for (const participant of participants.results) {
      expect(participant).toMatchObject({ payment_status: 'UNPAID', paid_at: null })
    }
  })

  it.each(['PARTIAL', 'paid', '', null])('rejects invalid payment status %j on insert and update', async (status) => {
    const month = await seedMonth(1)
    const query = db.prepare('SELECT * FROM month_members WHERE month_id = ?').bind(month.id)
    const before = await query.first<MonthMember>()
    const paidAt = '2026-09-21 12:34:56'

    await expect(db.prepare('UPDATE month_members SET payment_status = ?, paid_at = ? WHERE month_id = ?')
      .bind(status, paidAt, month.id).run()).rejects.toThrow(/constraint failed/)
    expect(await query.first<MonthMember>()).toEqual(before)

    await excludeMemberFromMonth(db, month.id, 1)
    await expect(db.prepare('INSERT INTO month_members (month_id, member_id, payment_status, paid_at) VALUES (?, 1, ?, ?)')
      .bind(month.id, status, paidAt).run()).rejects.toThrow(/constraint failed/)
    expect(await query.first<MonthMember>()).toBeNull()
  })

  it('requires a timestamp for PAID and preserves frozen amounts and membership', async () => {
    const month = await seedMonth(2)
    await publishMonthAmount(db, month.id)
    const beforeMonth = await storedMonth(month.id)
    const query = db.prepare('SELECT * FROM month_members WHERE month_id = ? ORDER BY member_id').bind(month.id)
    const beforeMembers = (await query.all<MonthMember>()).results
    const paidAt = '2026-09-21 12:34:56'

    await expect(db.prepare("UPDATE month_members SET payment_status = 'PAID' WHERE month_id = ? AND member_id = 1")
      .bind(month.id).run()).rejects.toThrow(/constraint failed/)
    await db.prepare("UPDATE month_members SET payment_status = 'PAID', paid_at = ? WHERE month_id = ? AND member_id = 1")
      .bind(paidAt, month.id).run()

    expect((await query.all<MonthMember>()).results).toEqual([
      { ...beforeMembers[0], payment_status: 'PAID', paid_at: paidAt },
      beforeMembers[1],
    ])
    expect(await storedMonth(month.id)).toEqual(beforeMonth)
    await expect(db.prepare('UPDATE month_members SET paid_at = NULL WHERE month_id = ? AND member_id = 1')
      .bind(month.id).run()).rejects.toThrow(/constraint failed/)

    await db.prepare("UPDATE month_members SET payment_status = 'UNPAID', paid_at = NULL WHERE month_id = ? AND member_id = 1")
      .bind(month.id).run()
    expect((await query.all<MonthMember>()).results).toEqual(beforeMembers)
    expect(await storedMonth(month.id)).toEqual(beforeMonth)
  })

  describe('manual payment marking', () => {
    function markPaid(monthId: number, memberId = 1) {
      return worker.fetch(new Request(
        `https://example.com/api/admin/months/${monthId}/members/${memberId}/paid`,
        { method: 'POST' },
      ), { DB: db })
    }

    it('persists PAID and the database timestamp without changing membership, quotas, or other participants', async () => {
      const month = await seedMonth(2)
      await createDraftMonth(db, { year: 2026, month: 10, billAmountEuros: 0 })
      await publishMonthAmount(db, month.id)
      // A distinct stored quota detects recalculation; global inactivity must not block payment.
      await db.prepare('UPDATE months SET per_member_amount_cents = 4321 WHERE id = ?').bind(month.id).run()
      await db.prepare('UPDATE members SET is_active = 0 WHERE id = 1').run()
      const months = db.prepare('SELECT * FROM months ORDER BY id')
      const participants = db.prepare('SELECT * FROM month_members ORDER BY id')
      const beforeMonths = (await months.all<Month>()).results
      const beforeMembers = (await participants.all<MonthMember>()).results
      const start = await db.prepare('SELECT unixepoch() AS now').first<number>('now')

      const response = await markPaid(month.id)

      expect(response.status).toBe(204)
      expect(await response.text()).toBe('')
      const end = await db.prepare('SELECT unixepoch() AS now').first<number>('now')
      const afterMembers = (await participants.all<MonthMember>()).results
      const paidAt = afterMembers[0].paid_at!
      expect(paidAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
      const paidSeconds = Date.parse(paidAt.replace(' ', 'T') + 'Z') / 1000
      expect(paidSeconds).toBeGreaterThanOrEqual(start!)
      expect(paidSeconds).toBeLessThanOrEqual(end!)
      expect(afterMembers).toEqual(beforeMembers.map((member) =>
        member.month_id === month.id && member.member_id === 1
          ? { ...member, payment_status: 'PAID', paid_at: paidAt }
          : member,
      ))
      expect((await months.all<Month>()).results).toEqual(beforeMonths)

      const detail = await worker.fetch(new Request(`https://example.com/api/months/${month.id}`), { DB: db })
      expect(await detail.json()).toMatchObject({
        participants: [
          { member_id: 1, payment_status: 'PAID', paid_at: paidAt },
          { member_id: 2, payment_status: 'UNPAID', paid_at: null },
        ],
      })
      expect((await markPaid(month.id)).status).toBe(204)
      expect((await participants.all<MonthMember>()).results).toEqual(afterMembers)
      expect((await months.all<Month>()).results).toEqual(beforeMonths)
    })

    it('preserves an older PAID timestamp on repeated requests, including concurrent retries', async () => {
      const month = await seedMonth(1)
      await publishMonthAmount(db, month.id)
      // An older timestamp catches replacement even when retries run in the same second.
      await db.prepare("UPDATE month_members SET payment_status = 'PAID', paid_at = '2000-01-01 12:00:00' WHERE month_id = ?")
        .bind(month.id).run()
      const query = db.prepare('SELECT * FROM month_members WHERE month_id = ?').bind(month.id)
      const before = (await query.all<MonthMember>()).results

      const responses = await Promise.all([markPaid(month.id), markPaid(month.id)])

      expect(responses.map((response) => response.status)).toEqual([204, 204])
      expect((await query.all<MonthMember>()).results).toEqual(before)
    })

    it('allows concurrent attempts to mark an UNPAID participant successfully', async () => {
      const month = await seedMonth(1)
      await publishMonthAmount(db, month.id)

      const responses = await Promise.all([markPaid(month.id), markPaid(month.id)])

      expect(responses.map((response) => response.status)).toEqual([204, 204])
      expect(await db.prepare('SELECT * FROM month_members WHERE month_id = ?').bind(month.id).first<MonthMember>())
        .toMatchObject({ payment_status: 'PAID', paid_at: expect.any(String) })
    })

    it.each([
      { status: 'DRAFT', payment_status: 'UNPAID' },
      { status: 'DRAFT', payment_status: 'PAID' },
      { status: 'CLOSED', payment_status: 'UNPAID' },
      { status: 'CLOSED', payment_status: 'PAID' },
    ] as const)('guards $status / $payment_status in SQL and returns HTTP 409', async ({ status, payment_status }) => {
      const month = await seedMonth(1)
      await db.prepare('UPDATE months SET status = ? WHERE id = ?').bind(status, month.id).run()
      if (payment_status === 'PAID') {
        await db.prepare("UPDATE month_members SET payment_status = 'PAID', paid_at = '2000-01-01 12:00:00' WHERE month_id = ?")
          .bind(month.id).run()
      }
      const query = db.prepare('SELECT * FROM month_members WHERE month_id = ?').bind(month.id)
      const beforeMembers = (await query.all<MonthMember>()).results
      const beforeMonth = await storedMonth(month.id)

      await expect(monthsRepository.markMemberPaid(db, month.id, 1)).resolves.toEqual({ status, payment_status })
      expect((await query.all<MonthMember>()).results).toEqual(beforeMembers)
      const response = await markPaid(month.id)

      expect(response.status).toBe(409)
      expect(await response.json()).toEqual({ error: 'month is not editable' })
      expect((await query.all<MonthMember>()).results).toEqual(beforeMembers)
      expect(await storedMonth(month.id)).toEqual(beforeMonth)
    })

    it.each(['missing month', 'excluded participant', 'unknown member'])('returns HTTP 404 for $0 without changing data', async (state) => {
      const month = await seedMonth(2)
      await excludeMemberFromMonth(db, month.id, 2)
      await publishMonthAmount(db, month.id)
      const query = db.prepare('SELECT * FROM month_members ORDER BY id')
      const beforeMembers = (await query.all<MonthMember>()).results
      const beforeMonth = await storedMonth(month.id)

      const response = await markPaid(
        state === 'missing month' ? month.id + 1 : month.id,
        state === 'unknown member' ? 999 : 2,
      )

      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({
        error: state === 'missing month' ? 'month not found' : 'member is not included in month',
      })
      expect((await query.all<MonthMember>()).results).toEqual(beforeMembers)
      expect(await storedMonth(month.id)).toEqual(beforeMonth)
    })

    it.each(['0', '-1', '1.5', 'abc', '9007199254740992', '1e2', '0x1', '%20'])('rejects invalid month/member ID %s before querying D1', async (id) => {
      const mark = vi.spyOn(monthsRepository, 'markMemberPaid')
      for (const path of [`${id}/members/1`, `1/members/${id}`]) {
        const response = await worker.fetch(new Request(
          `https://example.com/api/admin/months/${path}/paid`, { method: 'POST' },
        ), { DB: db })
        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({ error: 'invalid id' })
      }
      expect(mark).not.toHaveBeenCalled()
    })

    it('accepts a zero-byte POST body stream as an empty request', async () => {
      const month = await seedMonth(1)
      await publishMonthAmount(db, month.id)
      const request = new Request(
        `https://example.com/api/admin/months/${month.id}/members/1/paid`,
        { method: 'POST', headers: { 'Content-Length': '0' }, body: '' },
      )
      expect(request.body).not.toBeNull()

      const response = await worker.fetch(request, { DB: db })

      expect(response.status).toBe(204)
      expect(await db.prepare('SELECT * FROM month_members WHERE month_id = ?').bind(month.id).first<MonthMember>())
        .toMatchObject({ payment_status: 'PAID', paid_at: expect.any(String) })
    })

    it.each(['{"paid_at":"2000-01-01 12:00:00"}', '{"payment_status":"UNPAID"}', '{'])('rejects request body %s without writing', async (body) => {
      const month = await seedMonth(1)
      await publishMonthAmount(db, month.id)
      const mark = vi.spyOn(monthsRepository, 'markMemberPaid')
      const response = await worker.fetch(new Request(
        `https://example.com/api/admin/months/${month.id}/members/1/paid`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body },
      ), { DB: db })

      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: 'request body is not allowed' })
      expect(mark).not.toHaveBeenCalled()
      expect(await db.prepare('SELECT * FROM month_members WHERE month_id = ?').bind(month.id).first<MonthMember>())
        .toMatchObject({ payment_status: 'UNPAID', paid_at: null })
    })

    it('does not expose payment marking or reversal through other HTTP methods', async () => {
      const mark = vi.spyOn(monthsRepository, 'markMemberPaid')
      for (const method of ['GET', 'PATCH', 'DELETE']) {
        const response = await worker.fetch(new Request(
          'https://example.com/api/admin/months/1/members/1/paid', { method },
        ), { DB: db })
        expect(response.status).toBe(404)
      }
      expect(mark).not.toHaveBeenCalled()
    })
  })

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
    const participant = db.prepare('SELECT * FROM month_members WHERE month_id = ? AND member_id = 2').bind(month.id)
    expect(await participant.first<MonthMember>()).toMatchObject({ payment_status: 'UNPAID', paid_at: null })

    await excludeMemberFromMonth(db, month.id, 2)
    await expect(includeMemberInMonth(db, month.id, 2)).resolves.toBeUndefined()
    expect(await participant.first<MonthMember>()).toMatchObject({ payment_status: 'UNPAID', paid_at: null })
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
