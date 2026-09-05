-- Migration number: 0003 	 2026-09-05T16:37:10.012Z
CREATE TABLE month_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  month_id INTEGER NOT NULL,
  member_id INTEGER NOT NULL,

  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  UNIQUE (month_id, member_id),

  FOREIGN KEY (month_id)
    REFERENCES months(id)
    ON DELETE CASCADE,

  FOREIGN KEY (member_id)
    REFERENCES members(id)
    ON DELETE RESTRICT
);