import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MonthNotPublishableError, MonthHasNoMembersError, MonthNotFoundError, MonthNotEditableError, MemberNotInMonthError } from '../../errors/months'
import {
  calculatePerMemberAmount,
  publishMonthAmount,
  createDraftMonth,
  excludeMemberFromMonth,
} from '../months'
import * as monthsRepository from '../../repositories/months'

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

describe('excludeMemberFromMonth', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
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
