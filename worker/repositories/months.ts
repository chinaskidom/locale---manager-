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