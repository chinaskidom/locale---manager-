# Current Project Status

## Last completed work

- Finished the interrupted Cloudflare Access authentication/authorization implementation without replacing existing work. Verified RS256 assertions must match the configured issuer/audience and exactly one existing member; administrator access uses the configured email, and mutations require the exact configured Origin.
- Members can read health and PUBLISHED/CLOSED months only; DRAFT details are hidden. Other routes default to administrator-only. Worker responses use private/no-store caching and generic errors.
- Retained tunnel-only interactive development settings, disabled local Explorer/observability, sensitive-file protection, and signed authentication/SQL regressions. Fixed the Vite security test to expect the Worker's 401, corrected its NodeNext import and optional config field types, and replaced deprecated `envFile` with `envDir`.
- Removed the unused returned JWKS fixture property and replaced duplicate Explorer response-body checks with one exact-body assertion; status/cache checks remain unchanged.
- Verification passed: `npm run lint`, `npm test` (321 tests, including 108 authentication tests), `npm run build`, and `git diff --check`.

## Important unresolved issues

- Direct SQL writes that bypass guarded repository statements can still modify frozen month fields, membership, or payment state; no schema-wide lifecycle guard was added.
- Membership and bill-edit failure diagnosis reread current state after a guarded no-op; concurrent changes can obscure the original cause. Payment outcome diagnosis stays in the write transaction.
- Authentication tests use synthetic Access identities and isolated local D1; live Cloudflare Access policy/tunnel and deployed D1 verification remain missing. SPA protection requires an external Access policy.
- Build succeeds but warns that `ACCESS_ISSUER`, `ACCESS_AUD`, `ADMIN_EMAIL`, and `APP_ORIGIN` are unset. Deployment D1 IDs remain local-development placeholders; frontend API integration is still missing.
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

Confirm the next V1 development task with the user; no further implementation scope is selected.
