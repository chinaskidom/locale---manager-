ALTER TABLE month_members
ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'UNPAID'
  CHECK (payment_status IN ('UNPAID', 'PAID'));

ALTER TABLE month_members
ADD COLUMN paid_at TEXT
  CHECK (
    (payment_status = 'UNPAID' AND paid_at IS NULL)
    OR
    (payment_status = 'PAID' AND paid_at IS NOT NULL)
  );