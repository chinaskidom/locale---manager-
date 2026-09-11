# Current Project Status

## Last completed work

- Implemented `POST /api/admin/members` through existing ADMIN authorization and same-origin protection. It accepts only string `name`/`email`, trims inputs, creates an active member, and returns exactly `{ memberId, name }` with 201; invalid inputs return 400 and duplicate identities 409.
- New emails are stored trimmed/lowercase. Existing rows are checked with authentication-equivalent JavaScript normalization; the existing `UNIQUE(email)` constraint arbitrates concurrent canonical inserts. No migration or existing-data rewrite was needed.
- Added 50 service and real-verifier/local-D1 API cases covering validation, exact responses, active defaults, legacy/ambiguous/Unicode duplicates, forced duplicate races, unchanged snapshots, future snapshots, explicit DRAFT inclusion, and authorization. Updated `PRODUCT.md` with the finalized creation behavior.
- Verification passed: focused member service/auth/API tests (176/176), `npm run lint`, `npm run build`, and `git diff --check`. The full suite was not rerun because shared authentication and existing endpoint behavior were unchanged.

## Important unresolved issues

- Direct SQL writes that bypass guarded repository statements can still modify frozen month fields, membership, or payment state; no schema-wide lifecycle guard was added.
- Membership and bill-edit failure diagnosis reread current state after a guarded no-op; concurrent changes can obscure the original cause. Payment outcome diagnosis stays in the write transaction.
- Production hostname/whole-hostname Access policy, production server-side auth configuration, real D1 IDs/migrations/member rows, and deployed routing/auth verification remain prerequisites; no production deployment was performed. Frontend API integration is still missing.
- Foreign/missing/null-Origin rejection, inactive-member login, and other checklist cases not listed above were not reported as live-tested. The 30-day session duration is a dashboard configuration requirement, not an elapsed-time verification result.
- Direct SQL member inserts/email edits must use the same trimmed/lowercase email convention; the existing unique constraint alone does not normalize arbitrary SQL values. Legacy normalized duplicates remain rejected by authentication and cannot be expanded through the creation API.

## Current state

- Authenticated backend endpoints support health checks, member listing and global activation/deactivation, month listing/detail, draft-month creation and bill editing, allocation calculation, publication, DRAFT-only member inclusion/re-inclusion and exclusion, manual payment marking, and manual month closing, with request validation and domain-error responses.
- Access requires an unambiguous existing member email; global inactivity does not revoke access. Missing/invalid authentication returns 401, denied authorization returns 403, and invalid authentication configuration fails closed with 503.
- `GET /api/me` exposes only the authenticated member's ID, database name, and ADMIN/MEMBER role; it does not expose email, Access claims, configuration, or full member rows. Existing real Access/OTP/Tunnel smoke verification is documented in `README.md`; this endpoint has automated coverage but has not been live-browser verified.
- Global activation changes only `members.is_active`; member listing retains active and inactive members. Existing participation, including DRAFT snapshots and explicit exclusions, is never resynchronized. New months snapshot the current active set, and explicit DRAFT inclusion still requires current global activation.
- ADMIN member creation defaults to active without changing any existing month or participant row. Future months snapshot the member; existing DRAFT inclusion is a separate operation. Cloudflare Access whitelist changes remain separate administrative configuration. Member creation has automated coverage but has not been live-browser verified.
- `GET /api/months` returns persisted month fields newest-first by year/month, without recalculating stored quotas.
- `GET /api/months/:monthId` returns persisted month fields and month-specific participants in one D1 batch, including globally inactive members, without exposing emails or recalculating the official quota. Invalid IDs return 400; missing months return 404.
- Draft creation converts whole-euro bills to cents, defaults the fixed charge to 12000 cents, sets the due date to the 21st, and snapshots active members through a database trigger. Allocation uses month-specific membership and rounds up to integer cents.
- Bill editing is DRAFT-only and leaves the fixed charge, official quota, dates/timestamps, membership, and payment fields untouched. Preview calculation reads the updated bill; only publication freezes the official quota.
- Publication atomically counts membership, calculates the stored allocation, and publishes only a nonempty DRAFT. Membership writes retain SQL-level DRAFT guards; inclusion also requires an existing, globally active member and prevents duplicates.
- Month participation stores PAID/UNPAID and `paid_at` with consistency constraints, exposed by month detail. Manual marking is PUBLISHED-only and idempotent; reversal, backdating, timestamp editing, CLOSED-month corrections, and external payment integrations are not implemented.
- Manual closing is never automatic and unpaid participants do not block it. Invalid IDs/nonempty bodies return 400, missing months 404, DRAFT 409, and PUBLISHED/already-CLOSED months 204. CLOSED is final through application operations. Closing has automated coverage but has not been live-browser verified.

## Next planned task

Confirm the next development task with the user; no further implementation scope is selected.
