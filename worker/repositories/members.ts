import type { Member } from '../types'

export async function getMemberIdentityByEmail(db: D1Database, email: string): Promise<Pick<Member, 'id' | 'name'> | null> {
  const { results } = await db.prepare('SELECT id, name, email FROM members').all<Pick<Member, 'id' | 'name' | 'email'>>()
  // Normalize both sides in JS: SQLite LOWER/TRIM have narrower case/whitespace rules.
  const matches = results.filter((member) => member.email.trim().toLowerCase() === email.trim().toLowerCase())
  return matches.length === 1 ? { id: matches[0].id, name: matches[0].name } : null
}

export async function updateMemberActiveStatus(
  db: D1Database,
  memberId: number,
  isActive: boolean,
): Promise<boolean> {
  const result = await db
    .prepare(`
      UPDATE members
      SET is_active = ?
      WHERE id = ?
    `)
    .bind(isActive ? 1 : 0, memberId)
    .run()

  return result.meta.changes === 1
}

export async function getMemberActiveStatus(
  db: D1Database,
  memberId: number,
): Promise<number | null> {
  return db
    .prepare(`
      SELECT is_active
      FROM members
      WHERE id = ?
    `)
    .bind(memberId)
    .first<number>('is_active')
}

export async function getAllMembers(
  db: D1Database,
): Promise<Member[]> {
  const result = await db
    .prepare(`
      SELECT
        id,
        name,
        email,
        is_active,
        created_at
      FROM members
      ORDER BY name ASC
    `)
    .all<Member>()

  return result.results
}
