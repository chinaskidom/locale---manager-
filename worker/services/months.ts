import {
  addMemberToDraftMonth,
  createMonth as insertMonth,
  getAllMonths,
  getMonthCalculationData,
  getMonthDetail as selectMonthDetail,
  getMonthStatus,
  isMemberInMonth,
  markMemberPaid,
  publishMonth,
  removeMemberFromDraftMonth,
  updateDraftMonthBill,
} from '../repositories/months'
import { getMemberActiveStatus } from '../repositories/members'
import type { Month, MonthDetail } from '../types'
import {
  InvalidMonthInputError,
  MemberAlreadyInMonthError,
  MemberNotActiveError,
  MemberNotFoundError,
  MemberNotInMonthError,
  MonthAlreadyExistsError,
  MonthHasNoMembersError,
  MonthMembershipConflictError,
  MonthNotEditableError,
  MonthNotFoundError,
  MonthNotPublishableError,
} from '../errors/months'

export function listMonths(db: D1Database): Promise<Month[]> {
  return getAllMonths(db)
}

export async function getMonthDetail(
  db: D1Database,
  monthId: number,
): Promise<MonthDetail> {
  const month = await selectMonthDetail(db, monthId)

  if (!month) {
    throw new MonthNotFoundError()
  }

  return month
}

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

export async function markMemberPaymentPaid(
  db: D1Database,
  monthId: number,
  memberId: number,
): Promise<void> {
  const payment = await markMemberPaid(db, monthId, memberId)

  if (!payment) {
    throw new MonthNotFoundError()
  }

  if (payment.status !== 'PUBLISHED') {
    throw new MonthNotEditableError()
  }

  if (payment.payment_status === null) {
    throw new MemberNotInMonthError()
  }
}

export interface CreateDraftMonthInput {
  year: number
  month: number
  billAmountEuros: number
}

function billEurosToCents(billAmountEuros: number): number {
  if (!Number.isSafeInteger(billAmountEuros) || billAmountEuros < 0) {
    throw new InvalidMonthInputError(
      'billAmountEuros must be a non-negative integer',
    )
  }

  const billAmountCents = billAmountEuros * 100

  if (!Number.isSafeInteger(billAmountCents)) {
    throw new InvalidMonthInputError('bill amount is too large')
  }

  return billAmountCents
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

  const billAmountCents = billEurosToCents(input.billAmountEuros)

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

export async function updateMonthBill(
  db: D1Database,
  monthId: number,
  billAmountEuros: number,
): Promise<void> {
  const billAmountCents = billEurosToCents(billAmountEuros)

  if (await updateDraftMonthBill(db, monthId, billAmountCents)) {
    return
  }

  if (await getMonthStatus(db, monthId) === null) {
    throw new MonthNotFoundError()
  }

  throw new MonthNotEditableError()
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

  throw new MonthMembershipConflictError()
}

export async function includeMemberInMonth(
  db: D1Database,
  monthId: number,
  memberId: number,
): Promise<void> {
  if (await addMemberToDraftMonth(db, monthId, memberId)) {
    return
  }

  // The guarded SQL write is authoritative; diagnose a no-op from current state.
  const status = await getMonthStatus(db, monthId)

  if (status === null) {
    throw new MonthNotFoundError()
  }

  if (status !== 'DRAFT') {
    throw new MonthNotEditableError()
  }

  const activeStatus = await getMemberActiveStatus(db, memberId)

  if (activeStatus === null) {
    throw new MemberNotFoundError()
  }

  if (activeStatus !== 1) {
    throw new MemberNotActiveError()
  }

  if (await isMemberInMonth(db, monthId, memberId)) {
    throw new MemberAlreadyInMonthError()
  }

  // ponytail: diagnosis can race after the write; use transactional write/diagnosis for exact attribution.
  throw new MonthMembershipConflictError()
}
