import type { Month, MonthStatus } from '../types'

export interface MonthCalculationData {
  id: number
  fixed_amount_cents: number
  bill_amount_cents: number
  member_count: number
  status: 'DRAFT' | 'PUBLISHED' | 'CLOSED'
}

export async function getMonthCalculationData(
  db: D1Database,
  monthId: number,
): Promise<MonthCalculationData | null> {
  const result = await db
    .prepare(`
      SELECT
        m.id,
        m.fixed_amount_cents,
        m.bill_amount_cents,
        m.status,
        COUNT(mm.member_id) AS member_count
      FROM months m
      LEFT JOIN month_members mm
        ON mm.month_id = m.id
      WHERE m.id = ?
      GROUP BY
        m.id,
        m.fixed_amount_cents,
        m.bill_amount_cents,
        m.status
    `)
    .bind(monthId)
    .first<MonthCalculationData>()

  return result ?? null
}

export async function publishMonth(
  db: D1Database,
  monthId: number,
  perMemberAmountCents: number,
): Promise<boolean> {
  const result = await db
    .prepare(`
      UPDATE months
      SET
        per_member_amount_cents = ?,
        status = 'PUBLISHED',
        published_at = CURRENT_TIMESTAMP
      WHERE id = ?
        AND status = 'DRAFT'
    `)
    .bind(perMemberAmountCents, monthId)
    .run()

  return result.meta.changes === 1
}

export interface CreateMonthData {
  year: number
  month: number
  billAmountCents: number
  dueDate: string
}

export async function createMonth(
  db: D1Database,
  data: CreateMonthData,
): Promise<Month | null> {
  const result = await db
    .prepare(`
      INSERT INTO months (
        year,
        month,
        bill_amount_cents,
        due_date
      )
      VALUES (?, ?, ?, ?)
      ON CONFLICT(year, month) DO NOTHING
      RETURNING
        id,
        year,
        month,
        bill_amount_cents,
        fixed_amount_cents,
        per_member_amount_cents,
        status,
        due_date,
        created_at,
        published_at,
        closed_at
    `)
    .bind(
      data.year,
      data.month,
      data.billAmountCents,
      data.dueDate,
    )
    .first<Month>()

  return result ?? null
}

export async function removeMemberFromDraftMonth(
  db: D1Database,
  monthId: number,
  memberId: number,
): Promise<boolean> {
  const result = await db
    .prepare(`
      DELETE FROM month_members
      WHERE month_id = ?
        AND member_id = ?
        AND EXISTS (
          SELECT 1
          FROM months
          WHERE id = ?
            AND status = 'DRAFT'
        )
    `)
    .bind(
      monthId,
      memberId,
      monthId,
    )
    .run()

  return result.meta.changes === 1
}

export async function getMonthStatus(
  db: D1Database,
  monthId: number,
): Promise<MonthStatus | null> {
  const result = await db
    .prepare(`
      SELECT status
      FROM months
      WHERE id = ?
    `)
    .bind(monthId)
    .first<{ status: MonthStatus }>()

  return result?.status ?? null
}

export async function isMemberInMonth(
  db: D1Database,
  monthId: number,
  memberId: number,
): Promise<boolean> {
  const result = await db
    .prepare(`
      SELECT 1 AS found
      FROM month_members
      WHERE month_id = ?
        AND member_id = ?
      LIMIT 1
    `)
    .bind(
      monthId,
      memberId,
    )
    .first<{ found: number }>()

  return result !== null
}

export async function addMemberToDraftMonth(
  db: D1Database,
  monthId: number,
  memberId: number,
): Promise<boolean> {
  const result = await db
    .prepare(`
      INSERT OR IGNORE INTO month_members (
        month_id,
        member_id
      )
      SELECT ?, ?
      WHERE EXISTS (
        SELECT 1
        FROM months
        WHERE id = ?
          AND status = 'DRAFT'
      )
      AND EXISTS (
        SELECT 1
        FROM members
        WHERE id = ?
          AND is_active = 1
      )
    `)
    .bind(
      monthId,
      memberId,
      monthId,
      memberId,
    )
    .run()

  return result.meta.changes === 1
}