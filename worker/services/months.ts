import { getMonthCalculationData, publishMonth } from '../repositories/months'
import {
    MonthHasNoMembersError,
    MonthNotFoundError,
    MonthNotPublishableError
} from '../errors/months'


export function calculatePerMemberAmount(
    fixedAmountCents: number,
    billAmountCents: number,
    memberCount: number,
): number {
    if (!Number.isInteger(memberCount) || memberCount <= 0) {
        throw new Error('memberCount must be a positive integer')
    }

    if (
        !Number.isInteger(fixedAmountCents) ||
        !Number.isInteger(billAmountCents) ||
        fixedAmountCents < 0 ||
        billAmountCents < 0
    ) {
        throw new Error('amounts must be non-negative integers')
    }

    const totalCents = fixedAmountCents + billAmountCents

    return Math.ceil(totalCents / memberCount)
}

export async function calculateMonthAmount(
    db: D1Database,
    monthId: number,
): Promise<number> {
    const month = await getMonthCalculationData(db, monthId)

    if (!month) {
        throw new MonthNotFoundError()
    }

    if (month.member_count === 0) {
        throw new MonthHasNoMembersError()
    }

    return calculatePerMemberAmount(
        month.fixed_amount_cents,
        month.bill_amount_cents,
        month.member_count,
    )
}

export async function publishMonthAmount(
  db: D1Database,
  monthId: number,
): Promise<number> {
  const month = await getMonthCalculationData(db, monthId)

  if (!month) {
    throw new MonthNotFoundError()
  }

  if (month.status !== 'DRAFT') {
    throw new MonthNotPublishableError()
  }

  if (month.member_count === 0) {
    throw new MonthHasNoMembersError()
  }

  const perMemberAmountCents = calculatePerMemberAmount(
    month.fixed_amount_cents,
    month.bill_amount_cents,
    month.member_count,
  )

  const published = await publishMonth(
    db,
    monthId,
    perMemberAmountCents,
  )

  if (!published) {
    throw new MonthNotPublishableError()
  }

  return perMemberAmountCents
}