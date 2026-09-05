# Repository Guidance

## Commands

- Use npm (`npm ci`; lockfile is `package-lock.json`). Node 24.x satisfies the locked toolchain; Node 20 does not satisfy Vitest/Wrangler requirements.
- Before database-backed development, run `npx wrangler d1 migrations apply locale-manager-db --local`, then `npm run dev`. The Cloudflare Vite plugin runs the SPA and Worker together; no separate API server is needed.
- Verification: `npm run lint`, `npm test`, and `npm run build`. Build runs `tsc -b` across the app, Vite config, and Worker projects before producing `dist/client` and `dist/locale_manager`. For typechecking alone, use `npx tsc -b`.
- Focused tests: `npm test -- worker/services/__tests__/months.test.ts`; append `-t "calculatePerMemberAmount"` to select that suite. Existing tests mock repository calls and need no D1 setup; they do not exercise HTTP routing, SQL, or migration triggers.
- Regenerate `worker-configuration.d.ts` with `npx wrangler types` after changing bindings or runtime configuration in `wrangler.jsonc`; do not hand-edit the generated declarations.
- D1 is bound as `env.DB`. Both database IDs in `wrangler.jsonc` are `local-development` placeholders, not deployable remote database IDs. Keep local database commands explicitly `--local`.
- `.wrangler/state/` contains tracked runtime databases, including SQLite WAL/SHM files. Local tooling can dirty them; keep incidental runtime-state changes out of code/documentation commits.

## Wiring

- `README.md` is still the Vite template. The browser entry is `src/main.tsx`; `src/App.tsx` is only a heading, with no API integration yet. Tailwind v4 is wired through Vite and `src/index.css`, not a Tailwind config file.
- `worker/index.ts` implements HTTP routing and maps domain error classes to responses. Month business rules live in `worker/services/months.ts`; D1 SQL lives in `worker/repositories/`. Services receive `D1Database` explicitly. Row types in `worker/types.ts` mirror snake_case database columns, not camelCase request fields.
- `wrangler.jsonc` sends `/api/*` to the Worker before asset handling and uses SPA fallback for frontend paths. API routes belong under that prefix.

## Domain Constraints

- `billAmountEuros` accepts only non-negative whole euros; storage and allocation use integer cents. The fixed charge defaults to `12000` cents in migration `0002`, the due date is the month's 21st, and allocation rounds up with `Math.ceil((fixed + bill) / memberCount)`.
- Migration `0004_auto_add_month_members.sql` installs the trigger that copies active members into `month_members` when a month is inserted; the service does not populate membership. Its backfill also adds active members to existing drafts. Calculations count this month-specific membership, not currently active members; later activation changes do not resynchronize it.
- Publishing and membership edits are draft-only. Preserve the SQL-level `DRAFT` guards and `meta.changes` checks in `worker/repositories/months.ts`, not just service prechecks. Exclusion rereads status/membership after a failed conditional delete to distinguish concurrent changes.

## Development Style

- Prefer small, incremental changes over broad refactors.
- Do not introduce new dependencies unless they solve a concrete problem.
- Preserve the current repository → service → HTTP separation.
- Add or update tests when changing business rules.
- Do not change domain behavior merely to simplify implementation.
- Before finishing a task, run lint, tests, and build.