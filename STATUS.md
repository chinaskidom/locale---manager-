# Current Project Status

## Last completed work

- User confirmed the real-browser Access/named-tunnel smoke test succeeded: OTP and real JWT verification, health 200, ADMIN member listing 200, localhost 401, MEMBER health 200/member listing 403, MEMBER DRAFT detail 404 and DRAFT filtering, HMR, and ADMIN same-origin PATCH 204.
- The earlier live 401 was caused by an incorrect `ACCESS_AUD` in local `.dev.vars`. Correcting configuration resolved it; authentication architecture and verification rules were not changed.
- Removed temporary diagnostic instrumentation, its Vite flag, diagnostic-only tests, and instructions. Updated `README.md` with the successful live results and production prerequisites; no personal configuration values were added, and `.dev.vars` remains ignored.
- Cleanup verification passed: focused auth/tunnel tests (111/111, including 108 auth tests), `npm run lint`, `npm run build`, and `git diff --check`. The full suite was not rerun because production authentication behavior is unchanged.

## Important unresolved issues

- Direct SQL writes that bypass guarded repository statements can still modify frozen month fields, membership, or payment state; no schema-wide lifecycle guard was added.
- Membership and bill-edit failure diagnosis reread current state after a guarded no-op; concurrent changes can obscure the original cause. Payment outcome diagnosis stays in the write transaction.
- Production hostname/whole-hostname Access policy, production server-side auth configuration, real D1 IDs/migrations/member rows, and deployed routing/auth verification remain prerequisites; no production deployment was performed. Frontend API integration is still missing.
- Foreign/missing/null-Origin rejection, inactive-member login, and other checklist cases not listed above were not reported as live-tested. The 30-day session duration is a dashboard configuration requirement, not an elapsed-time verification result.
- The business rule for closing a PUBLISHED month remains undecided.

## Current state

- Authenticated backend endpoints support health checks, member listing and global activation/deactivation, month listing/detail, draft-month creation and bill editing, allocation calculation, publication, DRAFT-only member inclusion/re-inclusion and exclusion, and manual payment marking, with request validation and domain-error responses.
- Access requires an unambiguous existing member email; global inactivity does not revoke access. Missing/invalid authentication returns 401, denied authorization returns 403, and invalid authentication configuration fails closed with 503.
- Global activation changes only `members.is_active`; member listing retains active and inactive members. Existing participation, including DRAFT snapshots and explicit exclusions, is never resynchronized. New months snapshot the current active set, and explicit DRAFT inclusion still requires current global activation.
- `GET /api/months` returns persisted month fields newest-first by year/month, without recalculating stored quotas.
- `GET /api/months/:monthId` returns persisted month fields and month-specific participants in one D1 batch, including globally inactive members, without exposing emails or recalculating the official quota. Invalid IDs return 400; missing months return 404.
- Draft creation converts whole-euro bills to cents, defaults the fixed charge to 12000 cents, sets the due date to the 21st, and snapshots active members through a database trigger. Allocation uses month-specific membership and rounds up to integer cents.
- Bill editing is DRAFT-only and leaves the fixed charge, official quota, dates/timestamps, membership, and payment fields untouched. Preview calculation reads the updated bill; only publication freezes the official quota.
- Publication atomically counts membership, calculates the stored allocation, and publishes only a nonempty DRAFT. Membership writes retain SQL-level DRAFT guards; inclusion also requires an existing, globally active member and prevents duplicates.
- Month participation stores PAID/UNPAID and `paid_at` with consistency constraints, exposed by month detail. Manual marking is PUBLISHED-only and idempotent; reversal, backdating, timestamp editing, CLOSED-month corrections, and external payment integrations are not implemented.

## Next planned task

Confirm the next development task with the user; no further implementation scope is selected.
