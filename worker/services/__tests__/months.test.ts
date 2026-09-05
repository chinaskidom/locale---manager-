import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MonthNotPublishableError, MonthHasNoMembersError, MonthNotFoundError, } from '../../errors/months'
import {
  calculatePerMemberAmount,
  publishMonthAmount,
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
    ).mockResolvedValue(false)

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