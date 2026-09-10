import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { getPlatformProxy, unstable_splitSqlQuery } from 'wrangler'
import type { PlatformProxy } from 'wrangler'
import { authConfig, createAuthFixture } from '../../__tests__/auth-fixture'
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
import * as membersRepository from '../../repositories/members'
import * as monthsRepository from '../../repositories/months'
import type { Member, Month, MonthMember } from '../../types'
import { setMemberActiveStatus } from '../members'
import { calculatePerMemberAmount, createDraftMonth, excludeMemberFromMonth, includeMemberInMonth, publishMonthAmount, updateMonthBill } from '../months'

describe('months (local D1)', () => {
  let platform: PlatformProxy<{ DB: D1Database }>
  let db: D1Database
  let auth: Awaited<ReturnType<typeof createAuthFixture>>

  beforeAll(async () => {
    auth = await createAuthFixture()
    platform = await getPlatformProxy<{ DB: D1Database }>({
      configPath: fileURLToPath(new URL('../../../wrangler.jsonc', import.meta.url)),
      envFiles: [fileURLToPath(new URL('../../__tests__/test.env', import.meta.url))],
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
      // Authentication requires a member row; inactivity keeps domain snapshots unchanged.
      db.prepare("INSERT INTO members (id, name, email, is_active) VALUES (1000, 'Admin', ?, 0)")
        .bind(authConfig.ADMIN_EMAIL),
    ])
    auth.mockJwks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  async function adminFetch(request: Request, env: Pick<Env, 'DB'>) {
    const headers = new Headers(request.headers)
    headers.set('Cf-Access-Jwt-Assertion', await auth.sign())
    headers.set('Origin', authConfig.APP_ORIGIN)
    return worker.fetch(new Request(request, { headers }), { ...authConfig, ...env })
  }

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

  describe('global member activation', () => {
    function setActive(memberId: number | string, body: unknown) {
      return adminFetch(new Request(
        `https://example.com/api/admin/members/${memberId}/active`,
        { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      ), { DB: db })
    }

    it('persists only the requested member state, preserving all snapshots, payments, and month fields on changes and retries', async () => {
      const draft = await seedMonth(3)
      await excludeMemberFromMonth(db, draft.id, 3)
      for (const monthNumber of [10, 11]) {
        const month = await createDraftMonth(db, { year: 2026, month: monthNumber, billAmountEuros: 0 })
        await publishMonthAmount(db, month.id)
        // Distinct stored values expose accidental quota recalculation or timestamp replacement.
        await db.prepare(`
          UPDATE months SET status = ?, per_member_amount_cents = 4321,
            published_at = '2000-01-01 12:00:00', closed_at = ? WHERE id = ?
        `).bind(monthNumber === 10 ? 'PUBLISHED' : 'CLOSED', monthNumber === 10 ? null : '2000-02-01 12:00:00', month.id).run()
        await db.prepare("UPDATE month_members SET payment_status = 'PAID', paid_at = '2000-01-21 12:00:00' WHERE month_id = ? AND member_id = 1")
          .bind(month.id).run()
      }
      const members = db.prepare('SELECT * FROM members ORDER BY name')
      const months = db.prepare('SELECT * FROM months ORDER BY id')
      const participants = db.prepare('SELECT * FROM month_members ORDER BY id')
      const beforeMembers = (await members.all<Member>()).results
      const beforeMonths = (await months.all<Month>()).results
      const beforeParticipants = (await participants.all<MonthMember>()).results

      for (const isActive of [true, false, false, true, true]) {
        const response = await setActive(1, { isActive })

        expect(response.status).toBe(204)
        expect(await response.text()).toBe('')
        const expectedMembers = beforeMembers.map((member) =>
          member.id === 1 ? { ...member, is_active: isActive ? 1 : 0 } : member,
        )
        expect((await members.all<Member>()).results).toEqual(expectedMembers)
        expect((await months.all<Month>()).results).toEqual(beforeMonths)
        expect((await participants.all<MonthMember>()).results).toEqual(beforeParticipants)

        const listing = await adminFetch(new Request('https://example.com/api/members'), { DB: db })
        expect(listing.status).toBe(200)
        expect(await listing.json()).toEqual(expectedMembers)
      }
    })

    it.each([true, false])('accepts concurrent requests for the same desired state %s', async (isActive) => {
      await seedMonth(1)
      await setMemberActiveStatus(db, 1, !isActive)

      const responses = await Promise.all([setActive(1, { isActive }), setActive(1, { isActive })])

      expect(responses.map((response) => response.status)).toEqual([204, 204])
      expect(await membersRepository.getMemberActiveStatus(db, 1)).toBe(isActive ? 1 : 0)
    })

    it('snapshots only currently active members in new months and never backfills older drafts on reactivation', async () => {
      const original = await seedMonth(2)
      await excludeMemberFromMonth(db, original.id, 1)
      const participants = db.prepare('SELECT * FROM month_members ORDER BY id')
      let before = (await participants.all<MonthMember>()).results

      for (const [monthNumber, isActive, memberIds] of [[10, false, [2]], [11, true, [1, 2]]] as const) {
        expect((await setActive(1, { isActive })).status).toBe(204)
        expect((await participants.all<MonthMember>()).results).toEqual(before)
        const response = await adminFetch(new Request('https://example.com/api/months', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ year: 2026, month: monthNumber, billAmountEuros: 0 }),
        }), { DB: db })

        expect(response.status).toBe(201)
        const month = await response.json() as Month
        const after = (await participants.all<MonthMember>()).results
        expect(after.filter((participant) => participant.month_id !== month.id)).toEqual(before)
        expect(after.filter((participant) => participant.month_id === month.id).map((participant) => ({
          member_id: participant.member_id, payment_status: participant.payment_status, paid_at: participant.paid_at,
        }))).toEqual(memberIds.map((member_id) => ({ member_id, payment_status: 'UNPAID', paid_at: null })))
        before = after
      }
      expect(await monthsRepository.isMemberInMonth(db, original.id, 1)).toBe(false)
    })

    it.each([true, false])('returns HTTP 404 for a missing member with desired state %s without inserting or changing data', async (isActive) => {
      const month = await seedMonth(1)
      const members = (await db.prepare('SELECT * FROM members').all<Member>()).results
      const participants = (await db.prepare('SELECT * FROM month_members').all<MonthMember>()).results

      const response = await setActive(999, { isActive })

      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ error: 'member not found' })
      expect((await db.prepare('SELECT * FROM members').all<Member>()).results).toEqual(members)
      expect((await db.prepare('SELECT * FROM month_members').all<MonthMember>()).results).toEqual(participants)
      expect(await storedMonth(month.id)).toEqual(month)
    })

    it.each(['0', '-1', '1.5', 'abc', '9007199254740992', '1e2', '0x1', '%20'])('rejects invalid member ID %s without writing', async (id) => {
      const update = vi.spyOn(membersRepository, 'updateMemberActiveStatus')

      const response = await setActive(id, { isActive: false })

      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: 'invalid member id' })
      expect(update).not.toHaveBeenCalled()
    })

    it.each([
      { isActive: 0 }, { isActive: 1 }, { isActive: 'true' }, { isActive: 'false' },
      { isActive: null }, { isActive: [] }, { isActive: {} },
      {}, null, [], [false], true, false, 0, 'false',
      { is_active: false }, { isActive: false, name: 'Changed' },
    ])('rejects invalid or additional activation input %j without writing', async (body) => {
      const update = vi.spyOn(membersRepository, 'updateMemberActiveStatus')

      const response = await setActive(1, body)

      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: 'expected only isActive as a boolean' })
      expect(update).not.toHaveBeenCalled()
    })

    it.each(['{', ''])('rejects malformed or empty JSON %j without writing', async (body) => {
      const update = vi.spyOn(membersRepository, 'updateMemberActiveStatus')
      const response = await adminFetch(new Request(
        'https://example.com/api/admin/members/1/active', { method: 'PATCH', body },
      ), { DB: db })

      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: 'invalid JSON body' })
      expect(update).not.toHaveBeenCalled()
    })

    it('does not expose activation through other HTTP methods', async () => {
      const update = vi.spyOn(membersRepository, 'updateMemberActiveStatus')
      for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
        const response = await adminFetch(new Request(
          'https://example.com/api/admin/members/1/active', { method },
        ), { DB: db })
        expect(response.status).toBe(404)
      }
      expect(update).not.toHaveBeenCalled()
    })

    it('returns generic HTTP 500 for activation D1 failures instead of success or 404', async () => {
      const update = vi.spyOn(membersRepository, 'updateMemberActiveStatus')
      const failingDb = {
        prepare: (sql: string) => db.prepare(/UPDATE\s+members\b/.test(sql)
          ? 'UPDATE missing_members_table SET is_active = ? WHERE id = ?'
          : sql),
      } as unknown as D1Database

      const response = await adminFetch(new Request('https://example.com/api/admin/members/1/active', {
        method: 'PATCH', body: '{"isActive":false}',
      }), { DB: failingDb })

      expect(update).toHaveBeenCalledWith(failingDb, 1, false)
      expect(response.status).toBe(500)
      expect(await response.json()).toEqual({ error: 'internal server error' })
      expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    })
  })

  it('returns HTTP 200 with an empty month list', async () => {
    const response = await adminFetch(new Request('https://example.com/api/months'), { DB: db })

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

    const response = await adminFetch(new Request('https://example.com/api/months'), { DB: db })

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

  it('returns generic HTTP 500 for month listing D1 failures rather than an empty list', async () => {
    const read = vi.spyOn(monthsRepository, 'getAllMonths')
    const failingDb = {
      prepare: (sql: string) => db.prepare(/FROM\s+months\b/.test(sql)
        ? 'SELECT * FROM missing_months_table'
        : sql),
    } as unknown as D1Database

    const response = await adminFetch(new Request('https://example.com/api/months'), { DB: failingDb })

    expect(read).toHaveBeenCalledWith(failingDb)
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'internal server error' })
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it.each([0, 2])('returns HTTP detail for a DRAFT with %i participants and no official quota', async (memberCount) => {
    const month = await seedMonth(memberCount)
    const response = await adminFetch(new Request(
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

    const response = await adminFetch(new Request(
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
    const response = await adminFetch(new Request(
      'https://example.com/api/months/999',
    ), { DB: db })

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'month not found' })
  })

  it.each(['0', '-1', '1.5', 'abc', '9007199254740992', '1e2', '0x1', '%20'])('rejects invalid HTTP detail ID %s before reading the month', async (id) => {
    const read = vi.spyOn(monthsRepository, 'getMonthDetail')
    const response = await adminFetch(new Request(
      `https://example.com/api/months/${id}`,
    ), { DB: db })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid month id' })
    expect(read).not.toHaveBeenCalled()
  })

  it('backfills existing participants without changing membership or month amounts', async () => {
    const legacy = await getPlatformProxy<{ DB: D1Database }>({
      configPath: fileURLToPath(new URL('../../../wrangler.jsonc', import.meta.url)),
      envFiles: [fileURLToPath(new URL('../../__tests__/test.env', import.meta.url))],
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

  describe('draft bill editing', () => {
    function editBill(monthId: number, body: unknown) {
      return adminFetch(new Request(
        `https://example.com/api/admin/months/${monthId}/bill`,
        { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      ), { DB: db })
    }

    it.each([
      { euros: 34, preview: 5134 },
      { euros: 0, preview: 4000 },
      { euros: 32, preview: 5067 },
    ])('edits a DRAFT to $euros euros without changing other fields and previews $preview cents', async ({ euros, preview }) => {
      const month = await seedMonth(4)
      await excludeMemberFromMonth(db, month.id, 4)
      const otherMonth = await createDraftMonth(db, { year: 2026, month: 10, billAmountEuros: 0 })
      await db.prepare('UPDATE members SET is_active = 0 WHERE id = 2').run()
      // A distinct payment fixture detects unintended resets of participation fields.
      await db.prepare("UPDATE month_members SET payment_status = 'PAID', paid_at = '2000-01-01 12:00:00' WHERE month_id = ? AND member_id = 1")
        .bind(month.id).run()
      const participants = db.prepare('SELECT * FROM month_members ORDER BY id')
      const beforeMembers = (await participants.all<MonthMember>()).results

      const response = await editBill(month.id, { billAmountEuros: euros })

      expect(response.status).toBe(204)
      expect(await response.text()).toBe('')
      expect(await storedMonth(month.id)).toEqual({ ...month, bill_amount_cents: euros * 100 })
      expect(await storedMonth(otherMonth.id)).toEqual(otherMonth)
      expect((await participants.all<MonthMember>()).results).toEqual(beforeMembers)
      expect(await db.prepare('SELECT typeof(bill_amount_cents) AS type FROM months WHERE id = ?')
        .bind(month.id).first('type')).toBe('integer')

      const calculation = await adminFetch(new Request(
        `https://example.com/api/months/${month.id}/calculation`,
      ), { DB: db })
      expect(calculation.status).toBe(200)
      expect(await calculation.json()).toEqual({ perMemberAmountCents: preview })
      expect(await storedMonth(month.id)).toEqual({ ...month, bill_amount_cents: euros * 100 })
    })

    it('persists the largest whole-euro bill whose cents are a safe integer', async () => {
      const month = await seedMonth(0)

      expect((await editBill(month.id, { billAmountEuros: 90071992547409 })).status).toBe(204)
      expect(await storedMonth(month.id)).toEqual({ ...month, bill_amount_cents: 9007199254740900 })
      expect(await db.prepare('SELECT typeof(bill_amount_cents) AS type FROM months WHERE id = ?')
        .bind(month.id).first('type')).toBe('integer')
    })

    it.each([
      { billAmountEuros: -1 },
      { billAmountEuros: 34.5 },
      { billAmountEuros: Number.MAX_SAFE_INTEGER + 1 },
      { billAmountEuros: Number.MAX_SAFE_INTEGER },
      { billAmountEuros: 90071992547410 },
      { billAmountEuros: '34' },
      { billAmountEuros: null },
      { billAmountEuros: true },
      {}, null, [],
      { billAmountEuros: 34, fixedAmountCents: 0 },
      { billAmountEuros: 34, per_member_amount_cents: 1 },
    ])('rejects invalid or additional bill input %j without writing', async (body) => {
      const month = await seedMonth(0)
      const update = vi.spyOn(monthsRepository, 'updateDraftMonthBill')

      const response = await editBill(month.id, body)

      expect(response.status).toBe(400)
      expect(await response.json()).toHaveProperty('error')
      expect(update).not.toHaveBeenCalled()
      expect(await storedMonth(month.id)).toEqual(month)
    })

    it('rejects malformed JSON without writing', async () => {
      const update = vi.spyOn(monthsRepository, 'updateDraftMonthBill')
      const response = await adminFetch(new Request(
        'https://example.com/api/admin/months/1/bill', { method: 'PATCH', body: '{' },
      ), { DB: db })

      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: 'invalid JSON body' })
      expect(update).not.toHaveBeenCalled()
    })

    it.each(['0', '-1', '1.5', 'abc', '9007199254740992', '1e2', '0x1', '%20'])('rejects invalid bill route ID %s without writing', async (id) => {
      const update = vi.spyOn(monthsRepository, 'updateDraftMonthBill')
      const response = await adminFetch(new Request(
        `https://example.com/api/admin/months/${id}/bill`,
        { method: 'PATCH', body: '{"billAmountEuros":34}' },
      ), { DB: db })

      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: 'invalid month id' })
      expect(update).not.toHaveBeenCalled()
    })

    it('returns HTTP 404 for a missing month without creating it or editing another month', async () => {
      const month = await seedMonth(0)

      const response = await editBill(month.id + 1, { billAmountEuros: 34 })

      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ error: 'month not found' })
      expect(await storedMonth(month.id + 1)).toBeNull()
      expect(await storedMonth(month.id)).toEqual(month)
    })

    it.each(['PUBLISHED', 'CLOSED'] as const)('guards %s bills in SQL and returns HTTP 409 without changing the official quota or other data', async (status) => {
      const month = await seedMonth(2)
      await publishMonthAmount(db, month.id)
      await db.prepare('UPDATE months SET status = ? WHERE id = ?').bind(status, month.id).run()
      const beforeMonth = await storedMonth(month.id)
      const participants = db.prepare('SELECT * FROM month_members ORDER BY id')
      const beforeMembers = (await participants.all<MonthMember>()).results

      await expect(monthsRepository.updateDraftMonthBill(db, month.id, 3400)).resolves.toBe(false)
      expect(await storedMonth(month.id)).toEqual(beforeMonth)
      const response = await editBill(month.id, { billAmountEuros: 34 })

      expect(response.status).toBe(409)
      expect(await response.json()).toEqual({ error: 'month is not editable' })
      expect(await storedMonth(month.id)).toEqual(beforeMonth)
      expect((await participants.all<MonthMember>()).results).toEqual(beforeMembers)
    })

    it('rejects an in-flight bill edit when publication wins before the guarded write', async () => {
      const month = await seedMonth(3)
      const update = monthsRepository.updateDraftMonthBill
      let published: Month | null = null
      vi.spyOn(monthsRepository, 'updateDraftMonthBill').mockImplementationOnce(async (...args) => {
        await expect(publishMonthAmount(db, month.id)).resolves.toBe(5067)
        published = await storedMonth(month.id)
        return update(...args)
      })

      const response = await editBill(month.id, { billAmountEuros: 100 })

      expect(response.status).toBe(409)
      expect(await response.json()).toEqual({ error: 'month is not editable' })
      expect(await storedMonth(month.id)).toEqual(published)
    })

    it('publishes the new bill if editing wins after the publication precheck', async () => {
      const month = await seedMonth(3)
      const publish = monthsRepository.publishMonth
      vi.spyOn(monthsRepository, 'publishMonth').mockImplementationOnce(async (...args) => {
        await updateMonthBill(db, month.id, 100)
        expect(await storedMonth(month.id)).toEqual({ ...month, bill_amount_cents: 10000 })
        return publish(...args)
      })

      await expect(publishMonthAmount(db, month.id)).resolves.toBe(7334)
      expect(await storedMonth(month.id)).toMatchObject({
        bill_amount_cents: 10000, per_member_amount_cents: 7334, status: 'PUBLISHED',
      })
    })
  })

  describe('manual payment marking', () => {
    function markPaid(monthId: number, memberId = 1) {
      return adminFetch(new Request(
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

      const detail = await adminFetch(new Request(`https://example.com/api/months/${month.id}`), { DB: db })
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

    it.each(['0', '-1', '1.5', 'abc', '9007199254740992', '1e2', '0x1', '%20'])('rejects invalid month/member ID %s without writing', async (id) => {
      const mark = vi.spyOn(monthsRepository, 'markMemberPaid')
      for (const path of [`${id}/members/1`, `1/members/${id}`]) {
        const response = await adminFetch(new Request(
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

      const response = await adminFetch(request, { DB: db })

      expect(response.status).toBe(204)
      expect(await db.prepare('SELECT * FROM month_members WHERE month_id = ?').bind(month.id).first<MonthMember>())
        .toMatchObject({ payment_status: 'PAID', paid_at: expect.any(String) })
    })

    it.each(['{"paid_at":"2000-01-01 12:00:00"}', '{"payment_status":"UNPAID"}', '{'])('rejects request body %s without writing', async (body) => {
      const month = await seedMonth(1)
      await publishMonthAmount(db, month.id)
      const mark = vi.spyOn(monthsRepository, 'markMemberPaid')
      const response = await adminFetch(new Request(
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
        const response = await adminFetch(new Request(
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
    await setMemberActiveStatus(db, 3, false)
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
    await setMemberActiveStatus(db, 1, false)
    const url = `https://example.com/api/months/${month.id}/members/1`

    await expect(monthsRepository.addMemberToDraftMonth(db, month.id, 1)).resolves.toBe(false)
    await expect(includeMemberInMonth(db, month.id, 1)).rejects.toBeInstanceOf(MemberNotActiveError)
    const rejected = await adminFetch(new Request(url, { method: 'POST' }), { DB: db })
    expect(rejected.status).toBe(409)
    expect(await rejected.json()).toEqual({ error: 'member is not active' })
    expect(await monthsRepository.isMemberInMonth(db, month.id, 1)).toBe(false)

    await setMemberActiveStatus(db, 1, true)
    expect(await monthsRepository.isMemberInMonth(db, month.id, 1)).toBe(false)
    expect((await adminFetch(new Request(url, { method: 'POST' }), { DB: db })).status).toBe(204)
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
      await setMemberActiveStatus(db, 1, false)
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
      const response = await adminFetch(new Request(url, { method }), { DB: db })
      expect(response.status).toBe(204)
      expect(await response.text()).toBe('')
      expect(await monthsRepository.isMemberInMonth(db, month.id, 1)).toBe(method === 'POST')
    }

    const duplicate = await adminFetch(new Request(url, { method: 'POST' }), { DB: db })
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

    const response = await adminFetch(new Request(
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
    const response = await adminFetch(new Request(
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

    const response = await adminFetch(new Request(
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

    const response = await adminFetch(new Request(
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
