import type { Member } from '../types'

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