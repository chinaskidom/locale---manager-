# Current Project Status

## Last completed work

- Implemented `PATCH /api/admin/members/:memberId/active` through repository, service, and HTTP layers. It accepts only `{ "isActive": boolean }` and returns 204 on success, 400 for invalid IDs/body or extra fields, and 404 for a missing member.
- A single parameterized SQL update sets only the requested member's `is_active` to 1 or 0 and checks `meta.changes`. Repeated desired states, including concurrent retries, succeed without toggling, inserting members, or changing existing month snapshots, payments, quotas, or lifecycle fields.
- Added 5 service and 35 local-D1/HTTP cases covering transitions, idempotency, validation, missing members, database failures, member listing, snapshot preservation, and active-only future-month creation. Updated 3 publication/inclusion regressions to use the activation service, retaining current-activation checks for explicit DRAFT inclusion.
- Verification passed: `npm run lint`, `npm test` (210 tests), `npm run build`, and `git diff --check`.

## Important unresolved issues

- Direct SQL writes that bypass guarded repository statements can still modify frozen month fields, membership, or payment state; no schema-wide lifecycle guard was added.
- Membership and bill-edit failure diagnosis reread current state after a guarded no-op; concurrent changes can obscure the original cause. Payment outcome diagnosis stays in the write transaction.
- HTTP tests cover membership, month-detail, month-listing, manual-payment, bill-editing, and global activation routes, plus member listing and month creation during activation workflows; other endpoint HTTP coverage and deployed D1 verification remain missing.
- Authentication/admin authorization and frontend API integration are missing; the `/api/admin` prefix does not enforce authorization and must not be exposed to untrusted users. Deployment D1 IDs remain local-development placeholders.
- The business rule for closing a PUBLISHED month remains undecided.

## Current state

- Backend endpoints support health checks, member listing and global activation/deactivation, month listing/detail, draft-month creation and bill editing, allocation calculation, publication, DRAFT-only member inclusion/re-inclusion and exclusion, and manual payment marking, with request validation and domain-error responses.
- Global activation changes only `members.is_active`; member listing retains active and inactive members. Existing participation, including DRAFT snapshots and explicit exclusions, is never resynchronized. New months snapshot the current active set, and explicit DRAFT inclusion still requires current global activation.
- `GET /api/months` returns persisted month fields newest-first by year/month, without recalculating stored quotas.
- `GET /api/months/:monthId` returns persisted month fields and month-specific participants in one D1 batch, including globally inactive members, without exposing emails or recalculating the official quota. Invalid IDs return 400; missing months return 404.
- Draft creation converts whole-euro bills to cents, defaults the fixed charge to 12000 cents, sets the due date to the 21st, and snapshots active members through a database trigger. Allocation uses month-specific membership and rounds up to integer cents.
- Bill editing is DRAFT-only and leaves the fixed charge, official quota, dates/timestamps, membership, and payment fields untouched. Preview calculation reads the updated bill; only publication freezes the official quota.
- Publication atomically counts membership, calculates the stored allocation, and publishes only a nonempty DRAFT. Membership writes retain SQL-level DRAFT guards; inclusion also requires an existing, globally active member and prevents duplicates.
- Month participation stores PAID/UNPAID and `paid_at` with consistency constraints, exposed by month detail. Manual marking is PUBLISHED-only and idempotent; reversal, backdating, timestamp editing, CLOSED-month corrections, and external payment integrations are not implemented.

## Next planned task

Confirm the next V1 development task with the user; no further implementation scope is selected.
