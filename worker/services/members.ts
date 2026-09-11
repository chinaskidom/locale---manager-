import { MemberNotFoundError } from '../errors/months'
import { InvalidMemberInputError, MemberAlreadyExistsError } from '../errors/members'
import { getAllMembers, insertMember, updateMemberActiveStatus } from '../repositories/members'

export async function createMember(db: D1Database, input: { name: string; email: string }) {
  const name = input.name.trim()
  const email = input.email.trim().toLowerCase()

  if (!name || !/^[^\s@]+@[^\s@]+$/.test(email)) {
    throw new InvalidMemberInputError()
  }

  // Existing SQL-seeded rows may not be canonical; match authentication's JS normalization.
  // Do not use identity resolution here: ambiguous matches also mean the email is taken.
  const members = await getAllMembers(db)
  if (members.some((member) => member.email.trim().toLowerCase() === email)) {
    throw new MemberAlreadyExistsError()
  }

  const member = await insertMember(db, name, email)
  if (!member) {
    throw new MemberAlreadyExistsError()
  }

  return member
}

export async function setMemberActiveStatus(
  db: D1Database,
  memberId: number,
  isActive: boolean,
): Promise<void> {
  if (!await updateMemberActiveStatus(db, memberId, isActive)) {
    throw new MemberNotFoundError()
  }
}
