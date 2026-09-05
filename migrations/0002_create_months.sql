CREATE TABLE months (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  year INTEGER NOT NULL,
  month INTEGER NOT NULL
    CHECK (month BETWEEN 1 AND 12),

  bill_amount_cents INTEGER NOT NULL
    CHECK (
      bill_amount_cents >= 0
      AND bill_amount_cents % 100 = 0
    ),

  fixed_amount_cents INTEGER NOT NULL DEFAULT 12000
    CHECK (fixed_amount_cents >= 0),

  per_member_amount_cents INTEGER
    CHECK (
      per_member_amount_cents IS NULL
      OR per_member_amount_cents >= 0
    ),

  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT', 'PUBLISHED', 'CLOSED')),

  due_date TEXT NOT NULL,

  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  published_at TEXT,
  closed_at TEXT,

  UNIQUE (year, month)
);