import { MemberNotFoundError } from '../errors/months'
import { updateMemberActiveStatus } from '../repositories/members'

export async function setMemberActiveStatus(
  db: D1Database,
  memberId: number,
  isActive: boolean,
): Promise<void> {
  if (!await updateMemberActiveStatus(db, memberId, isActive)) {
    throw new MemberNotFoundError()
  }
}
