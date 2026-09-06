# Current Project Status

## Last completed work

- Implemented DRAFT-only member inclusion/re-inclusion via `POST /api/months/:monthId/members/:memberId`, reusing the existing SQL guards and affected-row check. Missing, inactive, and duplicate members have distinct domain errors; concurrent inclusion/exclusion diagnosis has a shared domain conflict.
- Added 10 service unit cases and 22 local-D1 regression cases covering persistence guards, inclusion/exclusion races, and membership HTTP semantics. Updated the publication/inclusion ordering test to use the new service.
- Verification passed: `npm run lint`, `npm test` (71 tests), `npm run build`, and `git diff --check`.

## Important unresolved issues

- Direct SQL writes that bypass guarded repository statements can still modify published membership; no schema-wide guard was added.
- Failure diagnosis reads current state after a guarded no-op; concurrent changes can obscure the original cause and return a membership conflict.
- Lower priority: HTTP tests cover membership routes only; deployed D1 remains untested.
- Lower priority: the frontend has no API integration, and deployment D1 IDs remain local-development placeholders.

## Current state

- Backend endpoints support health checks, member listing, draft-month creation, allocation calculation, publication, and DRAFT-only member inclusion/re-inclusion and exclusion, with request validation and domain-error responses.
- Draft creation converts whole-euro bills to cents, defaults the fixed charge to 12000 cents, sets the due date to the 21st, and snapshots active members through a database trigger. Allocation uses month-specific membership and rounds up to integer cents.
- Publication atomically counts membership, calculates the stored allocation, and publishes only a nonempty DRAFT. Membership writes retain SQL-level DRAFT guards; inclusion also requires an existing, globally active member and prevents duplicates.

## Next planned task

No subsequent task is documented in the existing project plan; awaiting prioritization.
