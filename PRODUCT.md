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
| CLOSED | Final state for a completed month. |

The exact rule allowing a PUBLISHED month to become CLOSED is undecided and must not be invented.

## Payments

- Each participating member has only UNPAID or PAID status for the month. There are no partial payments.
- When a payment becomes PAID, store when it was paid.
- Unpaid status must not alter membership or the frozen monthly quota.
- The administrator must be able to mark payments manually, including cash payments. Giovanni commonly pays cash, but this is not a special domain rule.
- Verified automatic reconciliation may eventually update payment status. A possible match alone must never mark a payment PAID; false negatives are preferable to false positives.

## Member Experience

- The application must be mobile-first and also work well on desktop.
- A member can see their monthly amount due, relevant monthly cost information, deadline, payment options, and payment status.
- A shared table visible to members shows the month's participating members, their PAID / UNPAID status, and when they paid, when available.
- Members may see each other's payment status and date, but sensitive personal information must not be exposed.

## Administration

The administrator must be able to create and manage months, enter the monthly bill, manage DRAFT participation, publish a month, inspect member/payment status, mark payments manually, eventually close a month, and manage members as required for the V1 workflow.

Exact UI screens and endpoint shapes should follow the simplest architecture consistent with these requirements.

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
