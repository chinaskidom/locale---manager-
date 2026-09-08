# Current Project Status

## Last completed work

- Implemented `POST /api/admin/months/:monthId/members/:memberId/paid` through repository, service, and HTTP layers for administrator-confirmed cash or other personally verified payments; no external transaction is required. Empty requests return 204 on success, including already-PAID participants. Invalid IDs/nonempty bodies return 400; missing months/participants return 404; DRAFT/CLOSED months return 409.
- A single D1 batch guards the UNPAID -> PAID update by PUBLISHED status, generates `paid_at` with `CURRENT_TIMESTAMP`, and reads the outcome transactionally. Retries preserve the original timestamp; membership, official quotas, and other participants are untouched. Recorded the supplied manual-payment rules in `PRODUCT.md`.
- Added 6 service and 24 local-D1/HTTP cases covering transitions, timestamp persistence/idempotency, concurrent requests, state/error handling, SQL guards, unchanged data, input rejection, and empty POST streams.
- Verification passed: `npm run lint`, `npm test` (126 tests), `npm run build`, and `git diff --check`.

## Important unresolved issues

- Direct SQL writes that bypass guarded repository statements can still modify published membership or payment state; no schema-wide lifecycle guard was added.
- Membership failure diagnosis reads current state after a guarded no-op; concurrent changes can obscure the original cause and return a membership conflict. Payment outcome diagnosis stays in the write transaction.
- HTTP tests cover membership, month-detail, month-listing, and manual-payment routes; other endpoint HTTP coverage and deployed D1 verification remain missing.
- Authentication/admin authorization and frontend API integration are missing; the `/api/admin` prefix does not enforce authorization and must not be exposed to untrusted users. Deployment D1 IDs remain local-development placeholders.
- Draft-bill editing and member-management mutations are not implemented.
- The business rule for closing a PUBLISHED month remains undecided.

## Current state

- Backend endpoints support health checks, member listing, month listing/detail, draft-month creation, allocation calculation, publication, DRAFT-only member inclusion/re-inclusion and exclusion, and manual payment marking, with request validation and domain-error responses.
- `GET /api/months` returns persisted month fields newest-first by year/month, without recalculating stored quotas.
- `GET /api/months/:monthId` returns persisted month fields and month-specific participants in one D1 batch, including globally inactive members, without exposing emails or recalculating the official quota. Invalid IDs return 400; missing months return 404.
- Draft creation converts whole-euro bills to cents, defaults the fixed charge to 12000 cents, sets the due date to the 21st, and snapshots active members through a database trigger. Allocation uses month-specific membership and rounds up to integer cents.
- Publication atomically counts membership, calculates the stored allocation, and publishes only a nonempty DRAFT. Membership writes retain SQL-level DRAFT guards; inclusion also requires an existing, globally active member and prevents duplicates.
- Month participation stores PAID/UNPAID and `paid_at` with consistency constraints, exposed by month detail. Manual marking is PUBLISHED-only and idempotent; reversal, backdating, timestamp editing, CLOSED-month corrections, and external payment integrations are not implemented.

## Next planned task

Implement DRAFT-only utility-bill editing, following `PRODUCT.md`'s editable-draft rule and existing whole-euro validation/cents storage, with SQL-level DRAFT guards and focused service/local-D1/HTTP tests.
