import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemberNotFoundError } from '../../errors/months'
import { InvalidMemberInputError, MemberAlreadyExistsError } from '../../errors/members'
import * as membersRepository from '../../repositories/members'
import { createMember, setMemberActiveStatus } from '../members'

describe('createMember', () => {
  const db = {} as D1Database
  afterEach(() => vi.restoreAllMocks())

  it('trims input and supplies a canonical email to the insert', async () => {
    vi.spyOn(membersRepository, 'getAllMembers').mockResolvedValue([])
    const insert = vi.spyOn(membersRepository, 'insertMember').mockResolvedValue({ id: 4, name: 'New Member' })
    await expect(createMember(db, { name: ' New Member\n', email: '\tFoo@Example.com ' }))
      .resolves.toEqual({ id: 4, name: 'New Member' })
    expect(insert).toHaveBeenCalledExactlyOnceWith(db, 'New Member', 'foo@example.com')
  })

  it.each([
    { name: ' \t', email: 'valid@example.test' },
    { name: 'Name', email: ' \n' },
    { name: 'Name', email: 'invalid' },
  ])('validates domain input before querying the database: %j', async (input) => {
    const read = vi.spyOn(membersRepository, 'getAllMembers')
    const insert = vi.spyOn(membersRepository, 'insertMember')
    await expect(createMember(db, input)).rejects.toBeInstanceOf(InvalidMemberInputError)
    expect(read).not.toHaveBeenCalled()
    expect(insert).not.toHaveBeenCalled()
  })

  it('maps a database uniqueness conflict after the precheck to duplicate identity', async () => {
    vi.spyOn(membersRepository, 'getAllMembers').mockResolvedValue([])
    vi.spyOn(membersRepository, 'insertMember').mockResolvedValue(null)
    await expect(createMember(db, { name: 'Name', email: 'new@example.test' }))
      .rejects.toBeInstanceOf(MemberAlreadyExistsError)
  })

  it.each(['getAllMembers', 'insertMember'] as const)('propagates %s failures instead of reporting a duplicate', async (method) => {
    vi.spyOn(membersRepository, 'getAllMembers').mockResolvedValue([])
    const error = new Error('database unavailable')
    vi.spyOn(membersRepository, method).mockRejectedValue(error)
    await expect(createMember(db, { name: 'Name', email: 'new@example.test' })).rejects.toBe(error)
  })
})

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
