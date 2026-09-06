# Current Project Status

## Last completed work

- Made month publication atomic: one SQL statement counts current month membership, calculates and stores integer-cent ceiling allocation, and publishes only a nonempty DRAFT. The service returns the stored amount; publication and exclusion retain SQL-level concurrency guards.
- Added 15 local-D1 regression cases using real migrations, covering both publication/exclusion orderings, last-member removal, member addition, competing publishers, SQL guards, membership scope, and rounding. Added six service unit cases and updated the publication-failure test.
- Verification passed: `npm run lint`, `npm test` (39 tests), and `npm run build`.

## Important unresolved issues

- Member inclusion/re-inclusion has a DRAFT-only repository helper but no service or HTTP endpoint.
- Direct SQL writes that bypass guarded repository statements can still modify published membership; no schema-wide guard was added.
- Lower priority: tests do not cover HTTP routing or deployed D1.
- Lower priority: the frontend has no API integration, and deployment D1 IDs remain local-development placeholders.

## Current state

- Backend endpoints support health checks, member listing, draft-month creation, allocation calculation, publication, and DRAFT-only member exclusion, with request validation and domain-error responses.
- Draft creation converts whole-euro bills to cents, defaults the fixed charge to 12000 cents, sets the due date to the 21st, and snapshots active members through a database trigger. Allocation uses month-specific membership and rounds up to integer cents.

## Next planned task

Implement member inclusion/re-inclusion for DRAFT months.
