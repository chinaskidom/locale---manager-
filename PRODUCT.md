# locale-manager Product

## Purpose

locale-manager is a small web application for managing the monthly shared expenses of a private venue/group with roughly 12 members, fluctuating around 11-14 people, and one administrator.

This document defines the authoritative intended product and V1 scope, not implementation progress. Undecided rules must not be invented.

## Monthly Costs

- The fixed shared monthly cost is always EUR 120 (12,000 cents).
- The administrator manually enters the monthly utility bill as a non-negative whole euro amount, without cents.
- The total to collect is EUR 120 plus the utility bill, divided equally among that month's participating members.
- The per-member amount is always rounded upward to the nearest cent. Collecting a few cents more than the exact total is acceptable.
- All monetary values use integer cents internally; floating-point money calculations must not be used.
- The payment deadline is always the 21st of that month.

## Membership And Month Lifecycle

- Members are globally active or inactive.
- Each month has its own participation snapshot, initially including active members when the month is created.
- The administrator can exclude or re-include members only while the month is DRAFT.
- Later global active-state changes must not rewrite historical month participation.
- Nonpayment must never change participation or the quota owed by other members.

Months have exactly these states:

| State | Rules |
| --- | --- |
| DRAFT | The bill and participation can be changed; the quota may be calculated as a preview. |
| PUBLISHED | Participating members and the official per-member amount are frozen; membership is no longer editable. |
| CLOSED | Final, immutable state after an explicit administrator close action. |

Closing is an explicit ADMIN-only action from PUBLISHED to CLOSED and is never automatic. A PUBLISHED month may be closed regardless of payment statuses; some or all participants being UNPAID must not prevent closing. DRAFT cannot be closed.

Closing changes only the month status and `closed_at`, generated server-side/database-side on the first close. It preserves membership, bill and fixed amounts, the frozen per-member quota, due date, `published_at`, payment statuses, and `paid_at`. Repeated close requests for a CLOSED month succeed without modifying it or replacing the original `closed_at`; concurrent close attempts must be safe.

## Payments

- Each participating member has only UNPAID or PAID status for the month. There are no partial payments.
- When a payment becomes PAID, store when it was paid.
- Unpaid status must not alter membership or the frozen monthly quota.
- The administrator must be able to mark payments manually, including cash payments. Giovanni commonly pays cash, but this is not a special domain rule.
- Manual marking is the administrator's explicit confirmation that payment was received, whether in cash or by another personally verified method. No external transaction is required.
- Manual marking allows only UNPAID -> PAID in PUBLISHED months. DRAFT payments cannot be recorded, and CLOSED months are not editable.
- The server/database generates `paid_at` when the transition succeeds. Repeating the operation for an already-PAID participant in a PUBLISHED month succeeds without changing the original timestamp.
- Manual marking must not change participation, the stored official quota, or any other participant. Reversal, backdating, timestamp editing, and CLOSED-month corrections are outside this operation's scope; client-supplied timestamps are not accepted.
- Verified automatic reconciliation may eventually update payment status. A possible match alone must never mark a payment PAID; false negatives are preferable to false positives.

## Member Experience

- The application must be mobile-first and also work well on desktop.
- A member can see their monthly amount due, relevant monthly cost information, deadline, payment options, and payment status.
- A shared table visible to members shows the month's participating members, their PAID / UNPAID status, and when they paid, when available.
- Members may see each other's payment status and date, but sensitive personal information must not be exposed.

## Administration

The administrator must be able to create and manage months, enter the monthly bill, manage DRAFT participation, publish a month, inspect member/payment status, mark payments manually, explicitly close a PUBLISHED month, and manage members as required for the V1 workflow.

Exact UI screens and endpoint shapes should follow the simplest architecture consistent with these requirements.

### Member Creation

- An authenticated administrator may create a member with only `name` and `email`, using the existing same-origin mutation protection. All other client-supplied fields are rejected.
- Name and email are trimmed; empty names and empty/invalid emails are rejected. Email identities are unique after trimming and case-insensitive normalization, including concurrent creation requests. Provider-specific dot/plus normalization is not used.
- New members are globally active by default. Creation does not change any existing DRAFT, PUBLISHED, or CLOSED month, its membership, payments, or quota.
- Future newly-created months include the new active member through the existing snapshot behavior. Inclusion in an existing DRAFT month requires the separate explicit month-member inclusion operation.
- Member creation does not update the Cloudflare Access whitelist; that remains separate deployment/administrative configuration.

## Payment Methods And Integrations

- Bank transfer is an intended payment method; the receiving account is BBVA Italy.
- Automatic bank-transfer reconciliation is planned through an Open Banking / AIS provider abstraction. Provider integration has not been implemented yet.
- Commercial PayPal checkout / PayPal Business API is not currently part of the intended V1 because merchant fees would fall on the administrator.
- Personal PayPal automation is unresolved and must not be invented.
- Do not implement external payment integrations until explicitly requested.

## Authentication And Authorization

- There is no public registration; access is for a small whitelist of approximately 12-14 users.
- Cloudflare Access with email OTP is currently the likely authentication approach, not a finalized implementation.
- Administrative operations require stronger authorization than ordinary member access.
- The exact authentication implementation has not yet been completed.

## Technology

Use the established React, TypeScript, Vite, Tailwind, Cloudflare Workers, and Cloudflare D1 stack, with Cloudflare Access likely for authentication. Keep the application in one repository. Do not introduce Next.js or an unnecessary backend framework.

## Out Of Scope

Unless later requested, V1 excludes partial payments, notifications, exports, bill attachments, advanced reporting, public/free registration, complex accounting, speculative PayPal automation, and unrelated product features.
