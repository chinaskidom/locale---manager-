# Locale Manager

Local development uses the same Cloudflare Access JWT verification as production:

```text
Browser -> stable HTTPS dev hostname -> Access email OTP + exact-email policy
        -> named Cloudflare Tunnel -> local Vite + Worker -> local D1
```

The real-browser Cloudflare Access/named-tunnel authentication smoke test succeeded, as reported by the user. The earlier Worker `401` was caused by an incorrect `ACCESS_AUD` in local `.dev.vars`; correcting it resolved the issue without changing authentication behavior. Temporary diagnostics have been removed. This guide creates development infrastructure only; do not deploy a Worker or create a remote D1 database.

## Live Verification

- OTP login through the protected HTTPS development hostname and real `Cf-Access-Jwt-Assertion` verification succeeded.
- Authenticated `/api/health` returned `200`; ADMIN `/api/members` returned `200`.
- Direct localhost `/api/health` returned `401`.
- A second authenticated MEMBER received `200` from `/api/health` and `403` from `/api/members`.
- MEMBER DRAFT detail returned `404`, and MEMBER month listing excluded DRAFTs.
- An ADMIN same-origin PATCH returned `204`; HMR worked through the protected tunnel.

These are the live checks reported complete, not a claim that every case in the broader checklist below was exercised. In particular, foreign/missing/null-Origin rejection, inactive-member login, and the remaining checklist cases were not reported as live-tested. The 30-day session duration remains a dashboard setting, not an elapsed-time smoke-test result.

## Existing Support

- `vite.config.ts` already starts an existing named tunnel automatically after Vite starts. It does not create the tunnel, DNS route, or Access application.
- Vite listens on `http://127.0.0.1:5173` with a strict port; HMR uses the configured HTTPS hostname over WSS/443. Explorer and local observability are disabled, and sensitive files are denied by Vite.
- `/api/*` runs through `worker/auth.ts`. Static assets, source modules, and HMR require the external Access policy covering the entire hostname, not just the API.
- No development identity bypass exists. The Worker verifies `Cf-Access-Jwt-Assertion` with `jose`; plaintext email headers, bearer headers, and cookies alone do not authenticate directly to the Worker.
- `.dev.vars` and its variants are ignored by Git. Do not put real values in this guide, `wrangler.jsonc`, tracked SQL, or any `VITE_*` variable.

## One-Time Dashboard Setup

Use an active Cloudflare-managed domain and an existing Zero Trust organization (or complete Zero Trust onboarding). Pick a dedicated single-level dev hostname such as `locale-dev.<YOUR_DOMAIN>` and a dedicated tunnel name such as `<DEV_TUNNEL_NAME>`. Do not reuse production infrastructure or add unrelated hostnames/connectors to this tunnel.

Dashboard labels can vary; current documentation uses the paths below.

### 1. Enable Email OTP

1. Open **Zero Trust > Integrations > Identity providers**.
2. Select **Add new identity provider > One-time PIN** and save, unless already configured.
3. Find the organization's team name under **Zero Trust > Settings**. Its team domain is `<TEAM_NAME>.cloudflareaccess.com`. `ACCESS_ISSUER` is exactly `https://<TEAM_NAME>.cloudflareaccess.com`, with no trailing slash or path. It is not the dev hostname or account ID. The public JWKS endpoint is this issuer plus `/cdn-cgi/access/certs`.

### 2. Protect the Whole Dev Hostname First

1. Open **Zero Trust > Access controls > Applications > Create new application > Self-hosted and private** (called **Self-hosted** in some dashboard versions).
2. Name it for development, then **Add public hostname**: subdomain `locale-dev`, domain `<YOUR_DOMAIN>`, and leave **Path empty**. This protects `/`, `/api/*`, Vite modules, and WebSocket upgrades. Do not create a separate, less restrictive application for a subpath.
3. Set the application's **Session Duration** to **30 days / 1 month (720 hours)**.
4. Add a dedicated policy with **Action: Allow** and **Include > Emails** containing only the exact email addresses permitted to use this development instance, including the administrator and a separate member test identity.
5. Set that policy's session duration to **Same as application session timeout**, or explicitly **30 days**. Do not use **Everyone**, **Emails ending in**, or **Login Methods: One-time PIN** as an Include rule; Include rules are alternatives, so adding OTP there would admit all OTP identities. Do not add Bypass or Service Auth policies.
6. Under authentication/login methods, disable accepting all identity providers and select **One-time PIN only**. Leave **Authenticate with Cloudflare One Client** off so it cannot override the intended login/session behavior.
7. Save the application. Open **Configure > Additional settings** and copy its **Application Audience (AUD) Tag** into local `ACCESS_AUD`. Use this development application's tag, not a production application's tag or the application ID.

The 30-day setting here controls the application token. A policy override takes precedence. The organization's global session controls SSO renewal separately; a shorter global session does not shorten an already-issued 30-day application token. Do not change an existing organization's global setting merely for this dev app. Session expiry, revocation, or clearing cookies can require a fresh OTP login.

### 3. Create the Named Tunnel and Route

1. Open the account dashboard's **Networking > Tunnels > Create a tunnel** (older Zero Trust navigation: **Networks > Connectors > Cloudflare Tunnels**). Choose **Cloudflared** if prompted and enter `<DEV_TUNNEL_NAME>`.
2. Create a **remotely managed** tunnel. The project will run its connector; do not install the dashboard's persistent Windows service or run a second connector. If onboarding waits for a connector, return to the tunnel list and configure the saved tunnel there while it is still inactive.
3. Select the tunnel, then **Routes > Add route > Published application** (older label: **Public Hostnames > Add a public hostname**).
4. Set the same `locale-dev.<YOUR_DOMAIN>` hostname, leave **Path empty**, and set **Service URL** to `http://127.0.0.1:5173` (or type **HTTP**, URL `127.0.0.1:5173` in a split form). Do not point it at HTTPS locally or a separate Worker port. Leave the HTTP Host Header override unset.
5. Save. For a Cloudflare-managed DNS zone, this creates the tunnel DNS record. Confirm the hostname has a proxied CNAME pointing to `<TUNNEL_ID>.cfargotunnel.com`; resolve any conflicting record for this dedicated hostname first.
6. Recheck that the whole-hostname Access application exists before starting any connector. An inactive tunnel is expected until `npm run dev` starts it.

### 4. Authorize the Local Tunnel Tooling

1. In **My Profile > API Tokens > Create Token > Create Custom Token**, create a development tooling token with **Account > Cloudflare Tunnel > Edit**, scoped to the specific account containing this tunnel.
2. Keep the token in a password manager. This account-level permission can manage tunnels in that account; do not share it with application members. DNS/Access edit permissions are not required for daily startup; those resources were configured manually above.
3. Copy the **Account ID** from the account dashboard into the launching shell as `CLOUDFLARE_ACCOUNT_ID`. Supply the token as `CLOUDFLARE_API_TOKEN` in that shell, not `.dev.vars` or client configuration.

The installed plugin looks up the tunnel by exact name, checks its existing ingress target, obtains a connector token, and starts `cloudflared`. It neither creates nor rewrites ingress. `wrangler login` alone does not supply the required tunnel permissions. The plugin locates/downloads `cloudflared` as needed; no separate tunnel script is required.

## Local Configuration

Create the repository-root `.dev.vars` locally with these placeholders replaced by development values only:

```dotenv
ACCESS_ISSUER=https://<TEAM_NAME>.cloudflareaccess.com
ACCESS_AUD=<DEV_APPLICATION_AUDIENCE_TAG>
ADMIN_EMAIL=<EXACT_ADMIN_EMAIL>
APP_ORIGIN=https://locale-dev.<YOUR_DOMAIN>
CLOUDFLARE_TUNNEL_NAME=<DEV_TUNNEL_NAME>
```

`APP_ORIGIN` must be exactly the browser origin, without a trailing slash, path, or explicit default `:443`. Restart Vite after changing these settings. Keep them in `.dev.vars`, not a mode-specific variant: the Vite configuration reads this exact file. Do not reuse production `ACCESS_AUD` or `APP_ORIGIN`; the issuer may be shared if both Access applications belong to the same organization.

### Local D1 Membership

Use Node 24.x. Install dependencies if needed, then apply local migrations before starting development:

```powershell
npm ci
npx wrangler d1 migrations apply locale-manager-db --local
```

Each allowed login must match **exactly one** local `members.email` after trimming and case normalization. The Access allowlist alone does not create a member. The administrator must have a matching row too; only equality with `ADMIN_EMAIL` grants administrator access. `members.is_active` controls participation, not login eligibility; inactive members can still authenticate.

Inspect existing local members before adding anyone:

```powershell
npx wrangler d1 execute locale-manager-db --local --command "SELECT id, name, email, is_active FROM members ORDER BY id;"
```

For missing identities, put the following statements with your local values in `.wrangler/members.local.sql`, then run the command below. That directory is ignored by Git and denied by Vite; do not put personal seed SQL in a publicly served directory. Do not duplicate an existing normalized email. Escape any SQL apostrophe as `''`. These rows are for the local database only.

```sql
INSERT INTO members (name, email, is_active) VALUES ('Dev admin', '<EXACT_ADMIN_EMAIL>', 1);
INSERT INTO members (name, email, is_active) VALUES ('Dev member', '<EXACT_MEMBER_EMAIL>', 1);
```

```powershell
npx wrangler d1 execute locale-manager-db --local --file ".wrangler/members.local.sql"
git check-ignore .dev.vars .wrangler/members.local.sql
```

Local D1 state may already be tracked under `.wrangler/state/`; ignore rules do not untrack existing files. Do not stage runtime databases or WAL/SHM files after adding personal values. Do not change the placeholder remote database IDs or remove `--local`.

## Daily Startup

In the project root, use a fresh PowerShell terminal. This prompts for the API token without placing its literal value in shell history:

```powershell
$env:CLOUDFLARE_ACCOUNT_ID = '<YOUR_ACCOUNT_ID>'
$token = Read-Host 'Cloudflare API token' -AsSecureString
$env:CLOUDFLARE_API_TOKEN = [System.Net.NetworkCredential]::new('', $token).Password
Remove-Variable token
npm run dev
```

The exact flow is **`npm run dev` -> Vite listens on 127.0.0.1:5173 -> plugin starts the named tunnel automatically -> open `APP_ORIGIN` -> OTP login**. There is no second `cloudflared tunnel run` command. Do not set `VITEST` in this shell: it intentionally disables the plugin for tests. `npm run preview` does not start this tunnel.

Wait for the connector to register and the dashboard tunnel to become **Healthy**. A printed URL alone is not proof that Access or the tunnel works. Open the HTTPS dev hostname, enter an allowlisted email, request the code, and complete login. An existing valid Access session may skip OTP; use a fresh browser profile for the initial check.

The installed plugin gives a tunnel a one-hour default lifetime, independent of the 30-day Access session. Press **a + Enter** in the Vite terminal to extend it by one hour (up to three hours remaining). **Ctrl+C** stops Vite and its connector; the named tunnel/DNS/Access application remain for the next session. Close the terminal afterward, or remove the shell token with `Remove-Item Env:CLOUDFLARE_API_TOKEN`.

## Browser Smoke Test

Use only disposable local month data. The frontend currently displays a heading, not role-aware UI, so inspect API responses with browser DevTools. Do not add an identity endpoint or bypass for this test. Do not export HAR files, cookies, or tokens to a repository, chat, or online JWT decoder.

1. **Access gate:** In a fresh browser profile, open the HTTPS hostname and complete OTP with an allowlisted email. In another fresh profile, try an email outside the policy; it must not reach the app. Access may say a code was emailed even when it did not send one. Before login, opening `/api/health` or `/@vite/client` must also require Access, not expose the API/module.
2. **API and admin:** Log in as `ADMIN_EMAIL`. In the console, run the GET checks below: health must be `200` with `{"status":"ok"}`, and `/api/members` must be `200`. Worker API responses must have `Cache-Control: private, no-store`. The browser sends its Access cookie; Access adds the signed assertion on the origin hop, so that assertion need not appear in browser request headers.
3. **Localhost rejection:** In a terminal, run `curl.exe -i http://127.0.0.1:5173/api/health` without identity headers or cookies. Expect the Worker's `401 {"error":"unauthorized"}`, even while the HTTPS browser is logged in. `503` means configuration is missing/invalid, not a successful authentication test.
4. **Same-Origin mutation:** As admin, create a disposable DRAFT with the console example below, using an unused year/month. Expect `201`; record its `id`. Patch its bill to `1` and expect `204`. In Network tools confirm the request's Origin exactly equals `APP_ORIGIN`.
5. **Origin rejection:** In Firefox Network tools, use **Edit and Resend** on that authenticated PATCH. Change the bill to `2` and change `Origin` to `https://foreign.invalid`; expect the Worker's `403 {"error":"forbidden"}`. Repeat with the Origin header removed and with `Origin: null`. GET the month again and confirm the bill remains `100` cents. Preserve the Access cookie when resending. Browser `fetch` cannot manually override Origin; if tooling rewrites it, or Access returns a login page instead of Worker JSON, this check is inconclusive, not a pass.
6. **Member/DRAFT/privacy:** In a separate browser profile, OTP-login as the allowlisted non-admin member. Health and month listing must be `200`; the new DRAFT must be absent from the listing and its detail must be `404`. `/api/members` and the same bill PATCH must be `403`. Existing PUBLISHED/CLOSED detail must be readable with participant name/payment status/date but no emails. If none exists, the admin can publish the disposable DRAFT with `POST /api/months/<ID>/publish` (no body, at least one participant); expect `200`, then verify the member can read it and admin bill/membership edits now return `409`.
7. **Inactive login:** Using a disposable member identity, have the admin PATCH `/api/admin/members/<MEMBER_ID>/active` with `{"isActive":false}`. Expect `204`; that member must still get `200` from `/api/health` and historical reads, including after fresh OTP login. Restore the original active state after the check. Do not use deactivation as access revocation.
8. **HMR:** On the HTTPS app page, confirm a connected `wss://<DEV_HOSTNAME>` WebSocket in Network tools and no localhost WebSocket fallback. Temporarily change the heading in `src/App.tsx` using your editor; it must update without a full navigation or another login. Undo only that temporary edit. Do not weaken Access or CORS to make HMR work.

Run these examples in DevTools on the authenticated HTTPS app page:

```javascript
await fetch('/api/health').then(async r => [r.status, await r.json()])
await fetch('/api/members').then(async r => [r.status, await r.json()])
await fetch('/api/months').then(async r => [r.status, await r.json()])

// Choose an unused local year/month before running; a duplicate returns 409.
var created = await fetch('/api/months', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ year: 2026, month: 12, billAmountEuros: 0 }),
})
var draft = await created.json()
console.log(created.status, draft)
await fetch(`/api/admin/months/${draft.id}/bill`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ billAmountEuros: 1 }),
}).then(r => r.status)
await fetch(`/api/months/${draft.id}`).then(async r => [r.status, await r.json()])
```

Record additional pass/fail results without personal values. The Live Verification section records the successful checks already reported; retain this checklist for repeat testing and cases not yet reported complete.

## Troubleshooting

- Tunnel not found/no matching ingress: check the exact tunnel name/account and the remote route's `http://127.0.0.1:5173` target. Do not switch to a quick tunnel.
- Cloudflare API authentication error: check the shell token's account scope and Cloudflare Tunnel Edit permission; `wrangler login` is not a replacement.
- Tunnel offline/502: check connector registration, local port 5173, outbound connectivity (including cloudflared port 7844), and the plugin's tunnel lifetime.
- Worker `401`: check dev AUD, issuer, machine clock, login session, and whether the complete hostname is covered by Access. The resolved live issue was a wrong AUD: use the Application Audience tag of the Access application protecting the dev hostname, not its application ID or a production AUD. Restart Vite after correcting `.dev.vars`. Do not send an unsigned email header as a workaround.
- Worker `403`: check the unique local member match, admin email, route permissions, and mutation Origin. `is_active` is not an authentication switch.
- Worker `503`: check all four auth values in `.dev.vars`; Worker `500` after authentication can indicate unapplied local migrations.

## Production Prerequisites

The successful local smoke test is not a production deployment verification. Before a separately authorized deployment:

- Provision production D1, apply migrations, configure the real binding/database IDs, and populate the exact member identities, including the administrator. Current Wrangler database IDs remain local-development placeholders.
- Configure the production hostname and a whole-hostname Access application with OTP, an exact-email Allow policy, and the intended 30-day application/policy session duration. Ensure alternate production hostnames cannot expose assets outside Access protection.
- Set production `ACCESS_ISSUER`, `ACCESS_AUD`, `ADMIN_EMAIL`, and `APP_ORIGIN` through server-side configuration/secrets. Use the production application's AUD and origin, not the dev values. Local tunnel tooling credentials are not production application bindings.
- Verify the deployed Static Assets/Access routing, Worker JWT checks, D1 binding, and admin/member/Origin/privacy behavior on the actual production hostname. Do not deploy local `.dev.vars` or local database state.

## References

- [Self-hosted Access application](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)
- [One-time PIN](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/)
- [Named dashboard tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/)
- [AUD and JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
- [Session duration and precedence](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/)

Tunnel startup details were checked against installed `@cloudflare/vite-plugin` 1.54.4 and Wrangler 4.129.0. Recheck them when upgrading tooling.
