import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { generateKeyPair, SignJWT } from 'jose'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { getPlatformProxy, unstable_splitSqlQuery } from 'wrangler'
import type { PlatformProxy } from 'wrangler'
import type { Month, MonthDetail } from '../types'
import { authConfig, createAuthFixture } from './auth-fixture'

const mutations = [
  ['POST', '/api/months', { year: 2026, month: 12, billAmountEuros: 32 }, 201],
  ['POST', '/api/months/1/publish', undefined, 200],
  ['POST', '/api/months/1/members/2', undefined, 204],
  ['DELETE', '/api/months/1/members/1', undefined, 204],
  ['PATCH', '/api/admin/months/1/bill', { billAmountEuros: 50 }, 204],
  ['POST', '/api/admin/months/2/members/2/paid', undefined, 204],
  ['PATCH', '/api/admin/members/2/active', { isActive: false }, 204],
] as const

describe('Access authentication and API authorization (real verifier and local D1)', () => {
  let platform: PlatformProxy<{ DB: D1Database }>
  let db: D1Database
  let worker: typeof import('../index').default
  let auth: Awaited<ReturnType<typeof createAuthFixture>>
  let adminToken: string
  let memberToken: string
  let inactiveToken: string

  beforeAll(async () => {
    auth = await createAuthFixture()
    adminToken = await auth.sign(' \tADMIN@EXAMPLE.TEST\n')
    memberToken = await auth.sign('member@example.test')
    inactiveToken = await auth.sign('inactive@example.test')
    platform = await getPlatformProxy<{ DB: D1Database }>({
      configPath: fileURLToPath(new URL('../../wrangler.jsonc', import.meta.url)),
      envFiles: [fileURLToPath(new URL('./test.env', import.meta.url))],
      persist: false,
      remoteBindings: false,
    })
    db = platform.env.DB
    const migrations = new URL('../../migrations/', import.meta.url)
    for (const filename of readdirSync(migrations).filter((name) => name.endsWith('.sql')).sort()) {
      await db.batch(unstable_splitSqlQuery(readFileSync(new URL(filename, migrations), 'utf8'))
        .map((statement) => db.prepare(statement)))
    }
  }, 30_000)

  beforeEach(async () => {
    // Reset the module-owned JWKS cache, never replace the verifier or its key resolver.
    vi.resetModules()
    worker = (await import('../index')).default
    auth.mockJwks()
    await db.batch([
      db.prepare('DELETE FROM months'),
      db.prepare('DELETE FROM members'),
      db.prepare(`INSERT INTO members (id, name, email, is_active) VALUES
        (1, 'Admin', 'admin@example.test', 1),
        (2, 'Member', ?, 1),
        (3, 'Inactive', 'inactive@example.test', 0)`).bind(' \tMEMBER@EXAMPLE.TEST\n'),
      db.prepare(`INSERT INTO months (id, year, month, bill_amount_cents, status, due_date, per_member_amount_cents)
        VALUES (1, 2026, 9, 3200, 'DRAFT', '2026-09-21', NULL),
        (2, 2026, 10, 3200, 'PUBLISHED', '2026-10-21', 7600),
        (3, 2026, 11, 3200, 'CLOSED', '2026-11-21', 7600)`),
      db.prepare('DELETE FROM month_members WHERE month_id = 1 AND member_id = 2'),
      db.prepare(`INSERT INTO month_members (month_id, member_id, payment_status, paid_at)
        VALUES (2, 3, 'PAID', '2026-10-21 12:34:56')`),
    ])
  })

  afterEach(() => vi.restoreAllMocks())
  afterAll(async () => { await platform?.dispose() })

  async function call(
    token: string | null,
    path = '/api/health',
    init: RequestInit = {},
    config: Partial<Env> = {},
  ) {
    const headers = new Headers(init.headers)
    if (token !== null) headers.set('Cf-Access-Jwt-Assertion', token)
    const response = await worker.fetch(new Request(`${authConfig.APP_ORIGIN}${path}`, { ...init, headers }), {
      ...authConfig, DB: db, ...config,
    })
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(response.headers.has('Access-Control-Allow-Origin')).toBe(false)
    return response
  }

  async function snapshot() {
    return db.batch([
      db.prepare('SELECT * FROM members ORDER BY id'),
      db.prepare('SELECT * FROM months ORDER BY id'),
      db.prepare('SELECT * FROM month_members ORDER BY id'),
    ]).then((results) => results.map((result) => result.results))
  }

  it.each([null, '', 'not-a-jwt', 'a.b.c'])('rejects missing/malformed assertion %s before D1', async (token) => {
    const prepare = vi.spyOn(db, 'prepare')
    const response = await call(token)
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'unauthorized' })
    expect(prepare).not.toHaveBeenCalled()
  })

  it('does not authenticate plaintext email/role headers, cookies, or a Bearer token', async () => {
    const response = await call(null, '/api/members', { headers: {
      'Cf-Access-Authenticated-User-Email': authConfig.ADMIN_EMAIL,
      'X-User-Email': authConfig.ADMIN_EMAIL,
      'X-Role': 'ADMIN',
      Authorization: `Bearer ${adminToken}`,
      Cookie: `CF_Authorization=${adminToken}`,
    } })
    expect(response.status).toBe(401)
  })

  it('rejects a forged RSA signature even with the trusted kid and claims', async () => {
    const forged = await generateKeyPair('RS256')
    const token = await auth.sign(undefined, {}, 'RS256', forged.privateKey)
    expect((await call(token)).status).toBe(401)
  })

  it.each([
    { iss: 'https://attacker.example.test' },
    { iss: `${authConfig.ACCESS_ISSUER}/` },
    { aud: 'wrong-audience' },
    { aud: ['wrong-audience'] },
    { exp: 1 },
    { nbf: 9_999_999_999 },
    { iat: 9_999_999_999 },
    { type: 'org' },
    { type: 'service' },
    { common_name: 'service-token-id' },
    { sub: '' },
    { sub: '   ' },
    { sub: 123 },
    { email: '' },
    { email: 'not-an-email' },
    { email: ['admin@example.test'] },
    { exp: '9999999999' },
    { nbf: '0' },
    { iat: '0' },
  ])('rejects invalid signed claims %j', async (claims) => {
    const token = await auth.sign(undefined, claims as Parameters<typeof auth.sign>[1])
    const response = await call(token)
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'unauthorized' })
    // Untrusted token URLs must never choose the issuer or JWKS endpoint.
    expect(vi.mocked(fetch).mock.calls.every(([url]) =>
      String(url) === `${authConfig.ACCESS_ISSUER}/cdn-cgi/access/certs`,
    )).toBe(true)
  })

  it.each(['iss', 'aud', 'exp', 'iat', 'sub', 'email', 'type'])('requires the %s claim', async (claim) => {
    expect((await call(await auth.sign(undefined, { [claim]: undefined }))).status).toBe(401)
  })

  it.each(['RS384', 'PS256', 'ES256', 'HS256', 'none'])('rejects unsupported algorithm %s', async (algorithm) => {
    let token: string
    if (algorithm === 'none') {
      const [, payload] = adminToken.split('.')
      token = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${payload}.`
    } else if (algorithm === 'HS256') {
      token = await new SignJWT({ email: authConfig.ADMIN_EMAIL })
        .setProtectedHeader({ alg: algorithm, kid: 'test-rsa' })
        .sign(crypto.getRandomValues(new Uint8Array(32)))
    } else {
      const keys = await generateKeyPair(algorithm)
      token = await auth.sign(undefined, {}, algorithm, keys.privateKey)
    }
    expect((await call(token)).status).toBe(401)
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['network', 'http', 'invalid-json', 'no-keys'])('fails closed on JWKS %s failure', async (failure) => {
    vi.mocked(fetch).mockImplementationOnce(async () => {
      if (failure === 'network') throw new Error('network failure with sensitive details')
      if (failure === 'http') return new Response('upstream failure', { status: 503 })
      if (failure === 'invalid-json') return new Response('not JSON')
      return Response.json({ keys: [] })
    })
    const response = await call(adminToken)
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'unauthorized' })
  })

  it('uses the cached remote public key for subsequent verification', async () => {
    expect((await call(adminToken)).status).toBe(200)
    expect((await call(memberToken)).status).toBe(200)
    const keyRequests = vi.mocked(fetch).mock.calls.filter(([url]) =>
      String(url) === `${authConfig.ACCESS_ISSUER}/cdn-cgi/access/certs`,
    )
    expect(keyRequests).toHaveLength(1)
  })

  it.each(['ACCESS_ISSUER', 'ACCESS_AUD', 'ADMIN_EMAIL', 'APP_ORIGIN'] as const)(
    'fails closed when %s is missing/empty', async (setting) => {
      for (const value of [undefined, '', '   ']) {
        const response = await call(adminToken, '/api/health', {}, { [setting]: value })
        expect(response.status).toBe(503)
        expect(await response.json()).toEqual({ error: 'service unavailable' })
      }
      expect(fetch).not.toHaveBeenCalled()
    },
  )

  it.each([
    { ACCESS_ISSUER: 'http://test-team.cloudflareaccess.com' },
    { ACCESS_ISSUER: `${authConfig.ACCESS_ISSUER}/` },
    { ACCESS_ISSUER: `${authConfig.ACCESS_ISSUER}.attacker.test` },
    { ACCESS_ISSUER: 'https://test-team.cloudflareaccess.com@attacker.test' },
    { ACCESS_ISSUER: `${authConfig.ACCESS_ISSUER}/cdn-cgi/access/certs` },
    { ACCESS_AUD: 'audience with spaces' },
    { ADMIN_EMAIL: 'not-an-email' },
    { ADMIN_EMAIL: 'a@example.test,b@example.test' },
    { APP_ORIGIN: 'null' },
    { APP_ORIGIN: 'http://localhost:5173' },
    { APP_ORIGIN: 'https://example.com/' },
    { APP_ORIGIN: 'https://example.com/path' },
    { APP_ORIGIN: 'https://user:password@example.com' },
  ])('rejects invalid configuration %j without network access', async (config) => {
    expect((await call(adminToken, '/api/health', {}, config)).status).toBe(503)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not disclose configuration, tokens, claims, or exception details in responses/logs', async () => {
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')]
    const response = await call(await auth.sign(undefined, { type: 'org', secret: 'private-claim' }))
    expect(await response.text()).toBe('{"error":"unauthorized"}')
    expect([...response.headers.keys()].sort()).toEqual(['cache-control', 'content-type'])
    expect((await call(adminToken, '/api/health', {}, { ADMIN_EMAIL: '' })).status).toBe(503)
    for (const log of logs) expect(log).not.toHaveBeenCalled()
  })

  it('denies an unknown member without auto-registration', async () => {
    const before = await snapshot()
    const response = await call(await auth.sign('unknown@example.test'))
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'forbidden' })
    expect(await snapshot()).toEqual(before)
  })

  it('requires the administrator to resolve to an existing member too', async () => {
    await db.prepare('DELETE FROM month_members WHERE member_id = 1').run()
    await db.prepare('DELETE FROM members WHERE id = 1').run()
    expect((await call(adminToken)).status).toBe(403)
  })

  it.each(['admin@example.test', 'member@example.test'])('denies ambiguous normalized email %s', async (email) => {
    await db.prepare('INSERT INTO members (name, email, is_active) VALUES (?, ?, 0)')
      .bind('Duplicate', `\t${email.toUpperCase()} `).run()
    const response = await call(await auth.sign(email))
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'forbidden' })
  })

  it('uses trimmed case-insensitive email for member resolution and administrator selection', async () => {
    expect((await call(adminToken, '/api/members', {}, { ADMIN_EMAIL: ' \tADMIN@Example.Test\n' })).status).toBe(200)
    expect((await call(memberToken)).status).toBe(200)
  })

  it('ignores signed client role claims and plaintext identity headers', async () => {
    const response = await call(await auth.sign('member@example.test', { role: 'ADMIN', roles: ['ADMIN'] }), '/api/members', {
      headers: { 'Cf-Access-Authenticated-User-Email': authConfig.ADMIN_EMAIL, 'X-Role': 'ADMIN' },
    })
    expect(response.status).toBe(403)
  })

  it('permits inactive member login and historical reads without requiring month participation', async () => {
    for (const path of ['/api/health', '/api/months', '/api/months/2', '/api/months/3']) {
      expect((await call(inactiveToken, path)).status).toBe(200)
    }
    expect((await call(inactiveToken, '/api/months/1')).status).toBe(404)
    expect((await call(inactiveToken, '/api/members')).status).toBe(403)
  })

  it('does not remove administrator rights when the administrator is inactive', async () => {
    await db.prepare('UPDATE members SET is_active = 0 WHERE id = 1').run()
    expect((await call(adminToken, '/api/members')).status).toBe(200)
  })

  it('lists only PUBLISHED/CLOSED months for members, with no emails or recalculation', async () => {
    const response = await call(memberToken, '/api/months')
    expect(response.status).toBe(200)
    const months = await response.json() as Month[]
    expect(months.map((month) => [month.id, month.status, month.per_member_amount_cents]))
      .toEqual([[3, 'CLOSED', 7600], [2, 'PUBLISHED', 7600]])
    expect(JSON.stringify(months)).not.toMatch(/email|@|participants/)
  })

  it.each([2, 3])('returns the safe participant projection to a member for month %i', async (id) => {
    const response = await call(memberToken, `/api/months/${id}`)
    expect(response.status).toBe(200)
    const detail = await response.json() as MonthDetail
    expect(detail.per_member_amount_cents).toBe(7600)
    expect(detail.participants.length).toBe(id === 2 ? 3 : 2)
    for (const participant of detail.participants) {
      expect(Object.keys(participant).sort()).toEqual(['member_id', 'name', 'paid_at', 'payment_status'])
    }
    if (id === 2) expect(detail.participants).toContainEqual({
      member_id: 3, name: 'Inactive', payment_status: 'PAID', paid_at: '2026-10-21 12:34:56',
    })
    expect(JSON.stringify(detail)).not.toMatch(/email|@|is_active/)
  })

  it('makes member DRAFT detail indistinguishable from a missing month', async () => {
    const draft = await call(memberToken, '/api/months/1')
    const missing = await call(memberToken, '/api/months/999')
    expect(draft.status).toBe(404)
    expect(missing.status).toBe(404)
    expect(await draft.json()).toEqual(await missing.json())
  })

  it.each(['/api/members', '/api/months/1/calculation', '/api/months/2/calculation', '/api/months/3/calculation', '/api/months/999/calculation'])(
    'denies member access to %s', async (path) => {
      const response = await call(memberToken, path)
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({ error: 'forbidden' })
    },
  )

  it.each(mutations)('denies MEMBER %s %s without modifying data', async (method, path, body) => {
    const before = await snapshot()
    for (const token of [memberToken, inactiveToken]) {
      expect((await call(token, path, {
        method, body: JSON.stringify(body), headers: { Origin: authConfig.APP_ORIGIN },
      })).status).toBe(403)
    }
    expect(await snapshot()).toEqual(before)
  })

  it.each(mutations)('allows ADMIN %s %s with the configured Origin', async (method, path, body, status) => {
    expect((await call(adminToken, path, {
      method, body: JSON.stringify(body), headers: { Origin: authConfig.APP_ORIGIN },
    })).status).toBe(status)
  })

  it.each(mutations)('enforces Origin for ADMIN %s %s before mutation', async (method, path, body) => {
    const before = await snapshot()
    for (const origin of [undefined, '', 'null', 'https://foreign.test', 'http://example.com',
      'https://example.com/', 'https://example.com:443', 'https://example.com.attacker.test',
      'https://example.com https://foreign.test']) {
      const response = await call(adminToken, path, {
        method, body: JSON.stringify(body), headers: origin === undefined ? {} : { Origin: origin },
      })
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({ error: 'forbidden' })
    }
    expect(await snapshot()).toEqual(before)
  })

  it('allows ADMIN all current GET routes and all month states', async () => {
    for (const path of ['/api/health', '/api/members', '/api/months', '/api/months/1', '/api/months/2',
      '/api/months/3', '/api/months/1/calculation', '/api/months/2/calculation', '/api/months/3/calculation']) {
      expect((await call(adminToken, path)).status).toBe(200)
    }
    const months = await (await call(adminToken, '/api/months')).json() as Month[]
    expect(months.map((month) => month.status)).toEqual(['CLOSED', 'PUBLISHED', 'DRAFT'])
  })

  it.each([['GET', '/api/future'], ['GET', '/api/admin/future'], ['GET', '/api/months/1/future'],
    ['POST', '/api/health'], ['HEAD', '/api/months'], ['OPTIONS', '/api/months'],
  ])('denies non-allowlisted member route/method %s %s', async (method, path) => {
    expect((await call(memberToken, path, { method, headers: { Origin: authConfig.APP_ORIGIN } })).status).toBe(403)
    expect((await call(adminToken, path, { method, headers: { Origin: authConfig.APP_ORIGIN } })).status).toBe(404)
  })

  it('authenticates even nonexistent routes and mutation requests before authorization', async () => {
    expect((await call(null, '/api/future')).status).toBe(401)
    expect((await call(null, '/api/months', { method: 'POST' })).status).toBe(401)
  })

  it('does not grant member access to future literal routes under /api/months', async () => {
    expect((await call(memberToken, '/api/months/future')).status).toBe(403)
  })

  it('has no localhost or development identity bypass', async () => {
    const response = await worker.fetch(new Request('http://localhost:5173/api/health', {
      headers: { 'X-Dev-Email': authConfig.ADMIN_EMAIL, 'Cf-Access-Authenticated-User-Email': authConfig.ADMIN_EMAIL },
    }), { ...authConfig, DB: db })
    expect(response.status).toBe(401)
  })
})
