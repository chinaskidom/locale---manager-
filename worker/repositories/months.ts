import type { Month, MonthDetail, MonthParticipant, MonthStatus, PaymentStatus } from '../types'

export async function getAllMonths(db: D1Database): Promise<Month[]> {
  const result = await db.prepare(`
    SELECT
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
    FROM months
    ORDER BY year DESC, month DESC
  `).all<Month>()

  return result.results
}

export async function getMonthDetail(
  db: D1Database,
  monthId: number,
): Promise<MonthDetail | null> {
  // A single batch keeps the month and participation reads in the same transaction.
  const [months, participants] = await db.batch([
    db.prepare(`
      SELECT
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
      FROM months
      WHERE id = ?
    `).bind(monthId),
    db.prepare(`
      SELECT mm.member_id, m.name, mm.payment_status, mm.paid_at
      FROM month_members mm
      JOIN members m ON m.id = mm.member_id
      WHERE mm.month_id = ?
      ORDER BY m.name, mm.member_id
    `).bind(monthId),
  ]) as [D1Result<Month>, D1Result<MonthParticipant>]

  const month = months.results[0]

  return month ? { ...month, participants: participants.results } : null
}

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
): Promise<number | null> {
  // Count and calculate in the publishing write, rounding up with integer division.
  const result = await db
    .prepare(`
      WITH membership AS (
        SELECT COUNT(*) AS member_count
        FROM month_members
        WHERE month_id = ?
      )
      UPDATE months
      SET
        per_member_amount_cents = (
          SELECT (fixed_amount_cents + bill_amount_cents + member_count - 1) / member_count
          FROM membership
        ),
        status = 'PUBLISHED',
        published_at = CURRENT_TIMESTAMP
      WHERE id = ?
        AND status = 'DRAFT'
        AND (SELECT member_count FROM membership) > 0
      RETURNING per_member_amount_cents
    `)
    .bind(monthId, monthId)
    .all<{ per_member_amount_cents: number }>()

  return result.meta.changes === 1
    ? result.results[0].per_member_amount_cents
    : null
}

interface MonthPaymentState {
  status: MonthStatus
  payment_status: PaymentStatus | null
}

export async function markMemberPaid(
  db: D1Database,
  monthId: number,
  memberId: number,
): Promise<MonthPaymentState | null> {
  // Keep the guarded transition and its outcome read in the same transaction.
  const [, result] = await db.batch<MonthPaymentState>([
    db.prepare(`
      UPDATE month_members
      SET payment_status = 'PAID', paid_at = CURRENT_TIMESTAMP
      WHERE month_id = ? AND member_id = ?
        AND payment_status = 'UNPAID'
        AND EXISTS (
          SELECT 1 FROM months WHERE id = ? AND status = 'PUBLISHED'
        )
    `).bind(monthId, memberId, monthId),
    db.prepare(`
      SELECT m.status, mm.payment_status
      FROM months m
      LEFT JOIN month_members mm ON mm.month_id = m.id AND mm.member_id = ?
      WHERE m.id = ?
    `).bind(memberId, monthId),
  ])

  return result.results[0] ?? null
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

export async function updateDraftMonthBill(
  db: D1Database,
  monthId: number,
  billAmountCents: number,
): Promise<boolean> {
  const result = await db.prepare(`
    UPDATE months
    SET bill_amount_cents = ?
    WHERE id = ? AND status = 'DRAFT'
  `).bind(billAmountCents, monthId).run()

  return result.meta.changes === 1
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
