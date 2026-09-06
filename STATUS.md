# Current Project Status

## Last completed work

- Implemented `GET /api/months/:monthId` through repository, service, and HTTP layers. One D1 batch returns persisted month fields and month-specific participants, including globally inactive members, without exposing emails or recalculating the official quota. Invalid IDs return 400; a typed missing-month error maps to 404.
- Added 3 service unit cases and 13 local-D1/HTTP cases covering response shape, empty drafts, PUBLISHED/CLOSED stored quotas and timestamps, payment fields, historical participation, read-only behavior, and errors.
- Verification passed: `npm run lint`, `npm test` (94 tests), `npm run build`, and `git diff --check`.

## Important unresolved issues

- Direct SQL writes that bypass guarded repository statements can still modify published membership; no schema-wide guard was added.
- Failure diagnosis reads current state after a guarded no-op; concurrent changes can obscure the original cause and return a membership conflict.
- HTTP tests cover membership and month-detail routes; other endpoint HTTP coverage and deployed D1 verification remain missing.
- Authentication/admin authorization and frontend API integration are missing; deployment D1 IDs remain local-development placeholders.
- The business rule for closing a PUBLISHED month remains undecided.

## Current state

- Backend endpoints support health checks, member listing, month detail, draft-month creation, allocation calculation, publication, and DRAFT-only member inclusion/re-inclusion and exclusion, with request validation and domain-error responses.
- Draft creation converts whole-euro bills to cents, defaults the fixed charge to 12000 cents, sets the due date to the 21st, and snapshots active members through a database trigger. Allocation uses month-specific membership and rounds up to integer cents.
- Publication atomically counts membership, calculates the stored allocation, and publishes only a nonempty DRAFT. Membership writes retain SQL-level DRAFT guards; inclusion also requires an existing, globally active member and prevents duplicates.
- Month participation stores PAID/UNPAID and paid_at with consistency constraints. Month detail exposes these fields; payment mutations are not implemented.

## Next planned task

Implement month listing (`GET /api/months`) using persisted month fields, with focused local-D1/HTTP tests.
