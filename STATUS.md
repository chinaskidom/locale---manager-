# Current Project Status

## Last completed work

- Implemented `PATCH /api/admin/months/:monthId/bill` through repository, service, and HTTP layers. It accepts only `{ "billAmountEuros": number }` and returns 204 on success, 400 for invalid IDs/input or extra fields, 404 for a missing month, and 409 for PUBLISHED/CLOSED months.
- Shared month creation's safe-integer whole-euro validation and cents conversion with bill editing. A conditional SQL update changes only `bill_amount_cents` while DRAFT and checks `meta.changes`; publication winning first blocks the edit, while an edit winning first is used by publication's atomic quota calculation.
- Added 14 service and 31 local-D1/HTTP cases covering valid/zero/boundary bills, invalid input, unchanged month/participation fields, preview updates, SQL guards, missing/noneditable months, and both publication write orderings.
- Verification passed: `npm run lint`, `npm test` (170 tests), `npm run build`, and `git diff --check`.

## Important unresolved issues

- Direct SQL writes that bypass guarded repository statements can still modify frozen month fields, membership, or payment state; no schema-wide lifecycle guard was added.
- Membership and bill-edit failure diagnosis reread current state after a guarded no-op; concurrent changes can obscure the original cause. Payment outcome diagnosis stays in the write transaction.
- HTTP tests cover membership, month-detail, month-listing, manual-payment, and bill-editing routes; other endpoint HTTP coverage and deployed D1 verification remain missing.
- Authentication/admin authorization and frontend API integration are missing; the `/api/admin` prefix does not enforce authorization and must not be exposed to untrusted users. Deployment D1 IDs remain local-development placeholders.
- Member-management mutations are not implemented.
- The business rule for closing a PUBLISHED month remains undecided.

## Current state

- Backend endpoints support health checks, member listing, month listing/detail, draft-month creation and bill editing, allocation calculation, publication, DRAFT-only member inclusion/re-inclusion and exclusion, and manual payment marking, with request validation and domain-error responses.
- `GET /api/months` returns persisted month fields newest-first by year/month, without recalculating stored quotas.
- `GET /api/months/:monthId` returns persisted month fields and month-specific participants in one D1 batch, including globally inactive members, without exposing emails or recalculating the official quota. Invalid IDs return 400; missing months return 404.
- Draft creation converts whole-euro bills to cents, defaults the fixed charge to 12000 cents, sets the due date to the 21st, and snapshots active members through a database trigger. Allocation uses month-specific membership and rounds up to integer cents.
- Bill editing is DRAFT-only and leaves the fixed charge, official quota, dates/timestamps, membership, and payment fields untouched. Preview calculation reads the updated bill; only publication freezes the official quota.
- Publication atomically counts membership, calculates the stored allocation, and publishes only a nonempty DRAFT. Membership writes retain SQL-level DRAFT guards; inclusion also requires an existing, globally active member and prevents duplicates.
- Month participation stores PAID/UNPAID and `paid_at` with consistency constraints, exposed by month detail. Manual marking is PUBLISHED-only and idempotent; reversal, backdating, timestamp editing, CLOSED-month corrections, and external payment integrations are not implemented.

## Next planned task

Implement administrator-controlled global member activation/deactivation, following `PRODUCT.md`'s active/inactive membership rules, without resynchronizing existing month participation snapshots, with focused service/local-D1/HTTP tests.
