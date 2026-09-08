import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemberNotFoundError } from '../../errors/months'
import * as membersRepository from '../../repositories/members'
import { setMemberActiveStatus } from '../members'

describe('setMemberActiveStatus', () => {
  const db = {} as D1Database

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each([true, false])('passes the explicit desired state %s to the write, including retries', async (isActive) => {
    const update = vi.spyOn(membersRepository, 'updateMemberActiveStatus').mockResolvedValue(true)
    const read = vi.spyOn(membersRepository, 'getMemberActiveStatus')

    await expect(setMemberActiveStatus(db, 4, isActive)).resolves.toBeUndefined()
    await expect(setMemberActiveStatus(db, 4, isActive)).resolves.toBeUndefined()

    expect(update).toHaveBeenNthCalledWith(1, db, 4, isActive)
    expect(update).toHaveBeenNthCalledWith(2, db, 4, isActive)
    expect(update).toHaveBeenCalledTimes(2)
    expect(read).not.toHaveBeenCalled()
  })

  it.each([true, false])('reports a missing member for desired state %s', async (isActive) => {
    const update = vi.spyOn(membersRepository, 'updateMemberActiveStatus').mockResolvedValue(false)

    await expect(setMemberActiveStatus(db, 999, isActive)).rejects.toBeInstanceOf(MemberNotFoundError)
    expect(update).toHaveBeenCalledExactlyOnceWith(db, 999, isActive)
  })

  it('propagates database failures instead of returning success or a missing-member error', async () => {
    const error = new Error('database unavailable')
    vi.spyOn(membersRepository, 'updateMemberActiveStatus').mockRejectedValue(error)

    await expect(setMemberActiveStatus(db, 4, false)).rejects.toBe(error)
  })
})
