-- Migration number: 0004 	 2026-09-05T17:40:46.359Z
CREATE TRIGGER add_active_members_to_new_month
AFTER INSERT ON months
BEGIN
  INSERT INTO month_members (
    month_id,
    member_id
  )
  SELECT
    NEW.id,
    id
  FROM members
  WHERE is_active = 1;
END;

INSERT OR IGNORE INTO month_members (
  month_id,
  member_id
)
SELECT
  m.id,
  mb.id
FROM months m
CROSS JOIN members mb
WHERE m.status = 'DRAFT'
  AND mb.is_active = 1;