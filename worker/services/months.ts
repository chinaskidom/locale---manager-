import {
  createMonth as insertMonth,
  getMonthCalculationData,
  getMonthStatus,
  isMemberInMonth,
  publishMonth,
  removeMemberFromDraftMonth,
} from '../repositories/months'
import type { Month } from '../types'
import {
  InvalidMonthInputError,
  MemberNotInMonthError,
  MonthAlreadyExistsError,
  MonthHasNoMembersError,
  MonthNotEditableError,
  MonthNotFoundError,
  MonthNotPublishableError,
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

  // Preserve validation, but let the publishing SQL calculate the persisted amount.
  calculatePerMemberAmount(
    month.fixed_amount_cents,
    month.bill_amount_cents,
    month.member_count,
  )

  const perMemberAmountCents = await publishMonth(db, monthId)

  if (perMemberAmountCents === null) {
    const currentMonth = await getMonthCalculationData(db, monthId)

    if (currentMonth?.status === 'DRAFT' && currentMonth.member_count === 0) {
      throw new MonthHasNoMembersError()
    }

    throw new MonthNotPublishableError()
  }

  return perMemberAmountCents
}

export interface CreateDraftMonthInput {
  year: number
  month: number
  billAmountEuros: number
}

export async function createDraftMonth(
  db: D1Database,
  input: CreateDraftMonthInput,
): Promise<Month> {
  if (!Number.isSafeInteger(input.year) || input.year <= 0) {
    throw new InvalidMonthInputError(
      'year must be a positive integer',
    )
  }

  if (
    !Number.isSafeInteger(input.month) ||
    input.month < 1 ||
    input.month > 12
  ) {
    throw new InvalidMonthInputError(
      'month must be an integer between 1 and 12',
    )
  }

  if (
    !Number.isSafeInteger(input.billAmountEuros) ||
    input.billAmountEuros < 0
  ) {
    throw new InvalidMonthInputError(
      'billAmountEuros must be a non-negative integer',
    )
  }

  const billAmountCents = input.billAmountEuros * 100

  if (!Number.isSafeInteger(billAmountCents)) {
    throw new InvalidMonthInputError(
      'bill amount is too large',
    )
  }

  const dueDate =
    `${input.year}-${String(input.month).padStart(2, '0')}-21`

  const month = await insertMonth(db, {
    year: input.year,
    month: input.month,
    billAmountCents,
    dueDate,
  })

  if (!month) {
    throw new MonthAlreadyExistsError()
  }

  return month
}

export async function excludeMemberFromMonth(
  db: D1Database,
  monthId: number,
  memberId: number,
): Promise<void> {
  const status = await getMonthStatus(db, monthId)

  if (status === null) {
    throw new MonthNotFoundError()
  }

  if (status !== 'DRAFT') {
    throw new MonthNotEditableError()
  }

  const memberIsIncluded = await isMemberInMonth(
    db,
    monthId,
    memberId,
  )

  if (!memberIsIncluded) {
    throw new MemberNotInMonthError()
  }

  const removed = await removeMemberFromDraftMonth(
    db,
    monthId,
    memberId,
  )

  if (removed) {
    return
  }

  // Qualcosa può essere cambiato tra i controlli sopra e la DELETE.
  // Rileggiamo lo stato per dare un errore semanticamente corretto.
  const currentStatus = await getMonthStatus(db, monthId)

  if (currentStatus === null) {
    throw new MonthNotFoundError()
  }

  if (currentStatus !== 'DRAFT') {
    throw new MonthNotEditableError()
  }

  const memberStillIncluded = await isMemberInMonth(
    db,
    monthId,
    memberId,
  )

  if (!memberStillIncluded) {
    throw new MemberNotInMonthError()
  }

  throw new Error('failed to exclude member from month')
}
