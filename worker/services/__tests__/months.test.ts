import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MemberAlreadyInMonthError,
  MemberNotActiveError,
  MemberNotFoundError,
  MemberNotInMonthError,
  MonthHasNoMembersError,
  MonthMembershipConflictError,
  MonthNotEditableError,
  MonthNotFoundError,
  MonthNotPublishableError,
} from '../../errors/months'
import {
  calculatePerMemberAmount,
  publishMonthAmount,
  createDraftMonth,
  excludeMemberFromMonth,
  getMonthDetail,
  includeMemberInMonth,
  markMemberPaymentPaid,
} from '../months'
import * as membersRepository from '../../repositories/members'
import * as monthsRepository from '../../repositories/months'

describe('getMonthDetail', () => {
  const db = {} as D1Database

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('throws MonthNotFoundError when the repository returns no month', async () => {
    vi.spyOn(monthsRepository, 'getMonthDetail').mockResolvedValue(null)

    await expect(getMonthDetail(db, 999)).rejects.toBeInstanceOf(MonthNotFoundError)
  })

  it('propagates database failures rather than reporting a missing month', async () => {
    const error = new Error('database unavailable')
    vi.spyOn(monthsRepository, 'getMonthDetail').mockRejectedValue(error)

    await expect(getMonthDetail(db, 1)).rejects.toBe(error)
  })
})

describe('calculatePerMemberAmount', () => {
  it('rounds the per-member amount up to the next cent', () => {
    const result = calculatePerMemberAmount(
      12000,
      3200,
      3,
    )

    expect(result).toBe(5067)
  })

  it('throws if memberCount is zero', () => {
    expect(() =>
      calculatePerMemberAmount(
        12000,
        3200,
        0,
      ),
    ).toThrow('memberCount must be a positive integer')
  })

  it('throws if memberCount is not an integer', () => {
    expect(() =>
      calculatePerMemberAmount(
        12000,
        3200,
        2.5,
      ),
    ).toThrow('memberCount must be a positive integer')
  })

  it('throws if an amount is negative', () => {
    expect(() =>
      calculatePerMemberAmount(
        -12000,
        3200,
        3,
      ),
    ).toThrow('amounts must be non-negative integers')
  })

  it('throws if an amount is not an integer', () => {
    expect(() =>
      calculatePerMemberAmount(
        12000.5,
        3200,
        3,
      ),
    ).toThrow('amounts must be non-negative integers')
  })
})

describe('publishMonthAmount', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('throws MonthNotPublishableError when the conditional update affects no rows', async () => {
    vi.spyOn(
      monthsRepository,
      'getMonthCalculationData',
    ).mockResolvedValue({
      id: 1,
      fixed_amount_cents: 12000,
      bill_amount_cents: 3200,
      member_count: 3,
      status: 'DRAFT',
    })

    vi.spyOn(
      monthsRepository,
      'publishMonth',
    ).mockResolvedValue(null)

    await expect(
      publishMonthAmount(
        {} as D1Database,
        1,
      ),
    ).rejects.toBeInstanceOf(
      MonthNotPublishableError,
    )
  })

  it('does not call publishMonth when the month is already published', async () => {
    vi.spyOn(
      monthsRepository,
      'getMonthCalculationData',
    ).mockResolvedValue({
      id: 1,
      fixed_amount_cents: 12000,
      bill_amount_cents: 3200,
      member_count: 3,
      status: 'PUBLISHED',
    })

    const publishSpy = vi.spyOn(
      monthsRepository,
      'publishMonth',
    )

    await expect(
      publishMonthAmount(
        {} as D1Database,
        1,
      ),
    ).rejects.toBeInstanceOf(
      MonthNotPublishableError,
    )

    expect(publishSpy).not.toHaveBeenCalled()
  })

  it.each([7600, 0])('returns the persisted amount %i rather than the precheck calculation', async (amount) => {
    vi.spyOn(monthsRepository, 'getMonthCalculationData').mockResolvedValue({
      id: 1,
      fixed_amount_cents: 12000,
      bill_amount_cents: 3200,
      member_count: 3,
      status: 'DRAFT',
    })
    const publishSpy = vi.spyOn(monthsRepository, 'publishMonth').mockResolvedValue(amount)
    const db = {} as D1Database

    await expect(publishMonthAmount(db, 1)).resolves.toBe(amount)
    expect(publishSpy).toHaveBeenCalledWith(db, 1)
  })

  it.each([
    { fixed_amount_cents: 12000.5, bill_amount_cents: 3200 },
    { fixed_amount_cents: 12000, bill_amount_cents: 3200.5 },
  ])('preserves validation of stored cents: %o', async (amounts) => {
    vi.spyOn(monthsRepository, 'getMonthCalculationData').mockResolvedValue({
      id: 1,
      ...amounts,
      member_count: 3,
      status: 'DRAFT',
    })
    const publishSpy = vi.spyOn(monthsRepository, 'publishMonth')

    await expect(publishMonthAmount({} as D1Database, 1)).rejects.toThrow('amounts must be non-negative integers')
    expect(publishSpy).not.toHaveBeenCalled()
  })

  it.each(['DRAFT', 'PUBLISHED'] as const)('rechecks an empty %s month after the SQL publication guard fails', async (status) => {
    vi.spyOn(monthsRepository, 'getMonthCalculationData')
      .mockResolvedValueOnce({
        id: 1,
        fixed_amount_cents: 12000,
        bill_amount_cents: 3200,
        member_count: 1,
        status: 'DRAFT',
      })
      .mockResolvedValueOnce({
        id: 1,
        fixed_amount_cents: 12000,
        bill_amount_cents: 3200,
        member_count: 0,
        status,
      })
    vi.spyOn(monthsRepository, 'publishMonth').mockResolvedValue(null)

    await expect(publishMonthAmount({} as D1Database, 1)).rejects.toBeInstanceOf(
      status === 'DRAFT' ? MonthHasNoMembersError : MonthNotPublishableError,
    )
  })

  it('throws MonthNotFoundError when the month does not exist', async () => {
    vi.spyOn(
      monthsRepository,
      'getMonthCalculationData',
    ).mockResolvedValue(null)

    const publishSpy = vi.spyOn(
      monthsRepository,
      'publishMonth',
    )

    await expect(
      publishMonthAmount(
        {} as D1Database,
        999,
      ),
    ).rejects.toBeInstanceOf(
      MonthNotFoundError,
    )

    expect(publishSpy).not.toHaveBeenCalled()
  })

  it('throws MonthHasNoMembersError when the month has no members', async () => {
    vi.spyOn(
      monthsRepository,
      'getMonthCalculationData',
    ).mockResolvedValue({
      id: 1,
      fixed_amount_cents: 12000,
      bill_amount_cents: 3200,
      member_count: 0,
      status: 'DRAFT',
    })

    const publishSpy = vi.spyOn(
      monthsRepository,
      'publishMonth',
    )

    await expect(
      publishMonthAmount(
        {} as D1Database,
        1,
      ),
    ).rejects.toBeInstanceOf(
      MonthHasNoMembersError,
    )

    expect(publishSpy).not.toHaveBeenCalled()
  })
})

describe('markMemberPaymentPaid', () => {
  const db = {} as D1Database

  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(monthsRepository, 'markMemberPaid').mockResolvedValue({
      status: 'PUBLISHED', payment_status: 'PAID',
    })
  })

  it('accepts a successful transition and repeated marking', async () => {
    await expect(markMemberPaymentPaid(db, 2, 4)).resolves.toBeUndefined()
    await expect(markMemberPaymentPaid(db, 2, 4)).resolves.toBeUndefined()
    expect(monthsRepository.markMemberPaid).toHaveBeenCalledWith(db, 2, 4)
    expect(monthsRepository.markMemberPaid).toHaveBeenCalledTimes(2)
  })

  it.each([
    { result: null, error: MonthNotFoundError },
    { result: { status: 'DRAFT', payment_status: 'UNPAID' }, error: MonthNotEditableError },
    { result: { status: 'CLOSED', payment_status: 'PAID' }, error: MonthNotEditableError },
    { result: { status: 'PUBLISHED', payment_status: null }, error: MemberNotInMonthError },
  ] as const)('maps the transactional result $result to $error.name', async ({ result, error }) => {
    vi.mocked(monthsRepository.markMemberPaid).mockResolvedValue(result)

    await expect(markMemberPaymentPaid(db, 2, 4)).rejects.toBeInstanceOf(error)
    expect(monthsRepository.markMemberPaid).toHaveBeenCalledExactlyOnceWith(db, 2, 4)
  })

  it('propagates database failures instead of returning success or a domain error', async () => {
    const error = new Error('database unavailable')
    vi.mocked(monthsRepository.markMemberPaid).mockRejectedValue(error)

    await expect(markMemberPaymentPaid(db, 2, 4)).rejects.toBe(error)
  })
})

describe('createDraftMonth', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('converts whole euros to cents and sets the due date to the 21st', async () => {
    const createMonthSpy = vi
      .spyOn(monthsRepository, 'createMonth')
      .mockResolvedValue({
        id: 2,
        year: 2026,
        month: 10,
        bill_amount_cents: 3400,
        fixed_amount_cents: 12000,
        per_member_amount_cents: null,
        status: 'DRAFT',
        due_date: '2026-10-21',
        created_at: '2026-09-05 19:00:00',
        published_at: null,
        closed_at: null,
      })

    await createDraftMonth(
      {} as D1Database,
      {
        year: 2026,
        month: 10,
        billAmountEuros: 34,
      },
    )

    expect(createMonthSpy).toHaveBeenCalledWith(
      expect.anything(),
      {
        year: 2026,
        month: 10,
        billAmountCents: 3400,
        dueDate: '2026-10-21',
      },
    )
  })

  it('rejects an invalid month', async () => {
    const createMonthSpy = vi.spyOn(
      monthsRepository,
      'createMonth',
    )

    await expect(
      createDraftMonth(
        {} as D1Database,
        {
          year: 2026,
          month: 13,
          billAmountEuros: 34,
        },
      ),
    ).rejects.toThrow(
      'month must be an integer between 1 and 12',
    )

    expect(createMonthSpy).not.toHaveBeenCalled()
  })

  it('rejects a bill amount with decimals', async () => {
    const createMonthSpy = vi.spyOn(
      monthsRepository,
      'createMonth',
    )

    await expect(
      createDraftMonth(
        {} as D1Database,
        {
          year: 2026,
          month: 10,
          billAmountEuros: 34.5,
        },
      ),
    ).rejects.toThrow(
      'billAmountEuros must be a non-negative integer',
    )

    expect(createMonthSpy).not.toHaveBeenCalled()
  })

  it('rejects an invalid year', async () => {
    const createMonthSpy = vi.spyOn(
      monthsRepository,
      'createMonth',
    )

    await expect(
      createDraftMonth(
        {} as D1Database,
        {
          year: 0,
          month: 10,
          billAmountEuros: 34,
        },
      ),
    ).rejects.toThrow(
      'year must be a positive integer',
    )

    expect(createMonthSpy).not.toHaveBeenCalled()
  })
})

describe('includeMemberInMonth', () => {
  const db = {} as D1Database

  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(monthsRepository, 'addMemberToDraftMonth').mockResolvedValue(false)
    vi.spyOn(monthsRepository, 'getMonthStatus').mockResolvedValue('DRAFT')
    vi.spyOn(membersRepository, 'getMemberActiveStatus').mockResolvedValue(1)
    vi.spyOn(monthsRepository, 'isMemberInMonth').mockResolvedValue(false)
  })

  it('succeeds only when the guarded insertion reports a changed row', async () => {
    vi.mocked(monthsRepository.addMemberToDraftMonth).mockResolvedValue(true)

    await expect(includeMemberInMonth(db, 2, 4)).resolves.toBeUndefined()
    expect(monthsRepository.addMemberToDraftMonth).toHaveBeenCalledExactlyOnceWith(db, 2, 4)
    expect(monthsRepository.getMonthStatus).not.toHaveBeenCalled()
    expect(membersRepository.getMemberActiveStatus).not.toHaveBeenCalled()
    expect(monthsRepository.isMemberInMonth).not.toHaveBeenCalled()
  })

  it.each([
    { status: null, error: MonthNotFoundError },
    { status: 'PUBLISHED', error: MonthNotEditableError },
    { status: 'CLOSED', error: MonthNotEditableError },
  ] as const)('diagnoses a no-op for month status $status', async ({ status, error }) => {
    vi.mocked(monthsRepository.getMonthStatus).mockResolvedValue(status)

    await expect(includeMemberInMonth(db, 2, 4)).rejects.toBeInstanceOf(error)
    expect(monthsRepository.getMonthStatus).toHaveBeenCalledExactlyOnceWith(db, 2)
    expect(membersRepository.getMemberActiveStatus).not.toHaveBeenCalled()
    expect(monthsRepository.addMemberToDraftMonth).toHaveBeenCalledTimes(1)
  })

  it.each([
    { activeStatus: null, error: MemberNotFoundError },
    { activeStatus: 0, error: MemberNotActiveError },
  ])('diagnoses a missing or inactive member: $error.name', async ({ activeStatus, error }) => {
    vi.mocked(membersRepository.getMemberActiveStatus).mockResolvedValue(activeStatus)

    await expect(includeMemberInMonth(db, 2, 4)).rejects.toBeInstanceOf(error)
    expect(membersRepository.getMemberActiveStatus).toHaveBeenCalledExactlyOnceWith(db, 4)
    expect(monthsRepository.isMemberInMonth).not.toHaveBeenCalled()
  })

  it('reports an already-included member without retrying the insertion', async () => {
    vi.mocked(monthsRepository.isMemberInMonth).mockResolvedValue(true)

    await expect(includeMemberInMonth(db, 2, 4)).rejects.toBeInstanceOf(MemberAlreadyInMonthError)
    expect(monthsRepository.isMemberInMonth).toHaveBeenCalledExactlyOnceWith(db, 2, 4)
    expect(monthsRepository.addMemberToDraftMonth).toHaveBeenCalledTimes(1)
  })

  it('reports a domain conflict if current state no longer explains the no-op', async () => {
    await expect(includeMemberInMonth(db, 2, 4)).rejects.toBeInstanceOf(MonthMembershipConflictError)
    expect(monthsRepository.addMemberToDraftMonth).toHaveBeenCalledTimes(1)
  })

  it('propagates unexpected database failures instead of classifying their messages', async () => {
    const error = new Error('member not found')
    vi.mocked(monthsRepository.addMemberToDraftMonth).mockRejectedValue(error)

    await expect(includeMemberInMonth(db, 2, 4)).rejects.toBe(error)
    expect(monthsRepository.getMonthStatus).not.toHaveBeenCalled()
  })
})

describe('excludeMemberFromMonth', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('reports a domain conflict when re-inclusion obscures a failed deletion', async () => {
    vi.spyOn(monthsRepository, 'getMonthStatus').mockResolvedValue('DRAFT')
    vi.spyOn(monthsRepository, 'isMemberInMonth').mockResolvedValue(true)
    vi.spyOn(monthsRepository, 'removeMemberFromDraftMonth').mockResolvedValue(false)

    await expect(excludeMemberFromMonth({} as D1Database, 2, 4)).rejects.toBeInstanceOf(MonthMembershipConflictError)
    expect(monthsRepository.removeMemberFromDraftMonth).toHaveBeenCalledTimes(1)
  })

  it('removes an included member from a draft month', async () => {
    vi.spyOn(
      monthsRepository,
      'getMonthStatus',
    ).mockResolvedValue('DRAFT')

    vi.spyOn(
      monthsRepository,
      'isMemberInMonth',
    ).mockResolvedValue(true)

    const removeSpy = vi
      .spyOn(
        monthsRepository,
        'removeMemberFromDraftMonth',
      )
      .mockResolvedValue(true)

    await expect(
      excludeMemberFromMonth(
        {} as D1Database,
        2,
        4,
      ),
    ).resolves.toBeUndefined()

    expect(removeSpy).toHaveBeenCalledWith(
      expect.anything(),
      2,
      4,
    )
  })
  it('does not remove a member from a published month', async () => {
    vi.spyOn(
      monthsRepository,
      'getMonthStatus',
    ).mockResolvedValue('PUBLISHED')

    const isMemberSpy = vi.spyOn(
      monthsRepository,
      'isMemberInMonth',
    )

    const removeSpy = vi.spyOn(
      monthsRepository,
      'removeMemberFromDraftMonth',
    )

    await expect(
      excludeMemberFromMonth(
        {} as D1Database,
        1,
        4,
      ),
    ).rejects.toBeInstanceOf(
      MonthNotEditableError,
    )

    expect(isMemberSpy).not.toHaveBeenCalled()
    expect(removeSpy).not.toHaveBeenCalled()
  })
  it('does not remove a member who is not included in the month', async () => {
    vi.spyOn(
      monthsRepository,
      'getMonthStatus',
    ).mockResolvedValue('DRAFT')

    vi.spyOn(
      monthsRepository,
      'isMemberInMonth',
    ).mockResolvedValue(false)

    const removeSpy = vi.spyOn(
      monthsRepository,
      'removeMemberFromDraftMonth',
    )

    await expect(
      excludeMemberFromMonth(
        {} as D1Database,
        2,
        4,
      ),
    ).rejects.toBeInstanceOf(
      MemberNotInMonthError,
    )

    expect(removeSpy).not.toHaveBeenCalled()
  })
  it('throws MonthNotEditableError if the month becomes published before deletion', async () => {
    vi.spyOn(
      monthsRepository,
      'getMonthStatus',
    )
      .mockResolvedValueOnce('DRAFT')
      .mockResolvedValueOnce('PUBLISHED')

    vi.spyOn(
      monthsRepository,
      'isMemberInMonth',
    )
      .mockResolvedValueOnce(true)

    vi.spyOn(
      monthsRepository,
      'removeMemberFromDraftMonth',
    )
      .mockResolvedValue(false)

    await expect(
      excludeMemberFromMonth(
        {} as D1Database,
        2,
        4,
      ),
    ).rejects.toBeInstanceOf(
      MonthNotEditableError,
    )
  })
  it('throws MemberNotInMonthError if the member is removed concurrently', async () => {
    vi.spyOn(
      monthsRepository,
      'getMonthStatus',
    )
      .mockResolvedValueOnce('DRAFT')
      .mockResolvedValueOnce('DRAFT')

    vi.spyOn(
      monthsRepository,
      'isMemberInMonth',
    )
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)

    vi.spyOn(
      monthsRepository,
      'removeMemberFromDraftMonth',
    )
      .mockResolvedValue(false)

    await expect(
      excludeMemberFromMonth(
        {} as D1Database,
        2,
        4,
      ),
    ).rejects.toBeInstanceOf(
      MemberNotInMonthError,
    )
  })
})
