import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cloudflare } from '@cloudflare/vite-plugin'
import { createServer, normalizePath, resolveConfig } from 'vite'
import { afterEach, expect, it, vi } from 'vitest'
import config from './vite.config.ts'

vi.mock('node:fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs')>(),
  // Config tests must never open the real .dev.vars.
  readFileSync: vi.fn(),
}))
vi.mock('@cloudflare/vite-plugin', () => ({ cloudflare: vi.fn(() => []) }))

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
})

it('rereads local tunnel settings, ignoring stale shell values, and keeps tooling interactive-only', () => {
  vi.stubEnv('VITEST', '')
  vi.stubEnv('APP_ORIGIN', 'https://stale.example.test')
  vi.stubEnv('CLOUDFLARE_TUNNEL_NAME', 'stale-tunnel')
  vi.stubEnv('X_LOCAL_EXPLORER', 'true')
  vi.stubEnv('X_LOCAL_OBSERVABILITY', 'true')
  vi.mocked(cloudflare).mockImplementation(() => {
    expect(process.env.X_LOCAL_EXPLORER).toBe('false')
    expect(process.env.X_LOCAL_OBSERVABILITY).toBe('false')
    return []
  })

  for (const name of ['first', 'second']) {
    vi.mocked(readFileSync).mockReturnValue(`APP_ORIGIN=https://${name}.example.test\nCLOUDFLARE_TUNNEL_NAME=${name}`)
    const result = config({ command: 'serve', mode: 'development' })
    expect(result.server).toMatchObject({
      host: '127.0.0.1', port: 5173, strictPort: true, cors: false,
      allowedHosts: [`${name}.example.test`],
      ws: { protocol: 'wss', host: `${name}.example.test`, clientPort: 443 },
    })
    expect(cloudflare).toHaveBeenLastCalledWith({ tunnel: { name, autoStart: true } })
  }
  expect(readFileSync).toHaveBeenCalledTimes(2)
  expect(process.env.APP_ORIGIN).toBe('https://stale.example.test')
  expect(process.env.CLOUDFLARE_TUNNEL_NAME).toBe('stale-tunnel')

  for (const env of [
    { command: 'build' as const, mode: 'production' },
    { command: 'serve' as const, mode: 'production', isPreview: true },
  ]) {
    config(env)
    expect(cloudflare).toHaveBeenLastCalledWith({ tunnel: false })
  }
  vi.stubEnv('VITEST', 'true')
  vi.mocked(cloudflare).mockClear()
  config({ command: 'serve', mode: 'test' })
  expect(cloudflare).not.toHaveBeenCalled()
  expect(readFileSync).toHaveBeenCalledTimes(2)
})

it('rejects missing or invalid local settings with only a generic error', () => {
  vi.stubEnv('VITEST', '')
  for (const contents of [
    '',
    'APP_ORIGIN=http://private.example.test\nCLOUDFLARE_TUNNEL_NAME=private',
    'APP_ORIGIN=https://private.example.test/path\nCLOUDFLARE_TUNNEL_NAME=private',
    'APP_ORIGIN=https://private.example.test\nCLOUDFLARE_TUNNEL_NAME=" "',
    null,
  ]) {
    vi.mocked(readFileSync).mockImplementation(() => {
      if (contents === null) throw new Error('private filesystem detail')
      return contents
    })
    expect(() => config({ command: 'serve', mode: 'development' })).toThrow(
      new Error('Development requires an HTTPS APP_ORIGIN and CLOUDFLARE_TUNNEL_NAME in .dev.vars'),
    )
  }
  expect(cloudflare).not.toHaveBeenCalled()
})

it('blocks Explorer SQL, unauthenticated CORS preflights, and sensitive files in the real dev stack', async () => {
  const root = mkdtempSync(join(tmpdir(), 'opencode', 'vite-security-'))
  let server: Awaited<ReturnType<typeof createServer>> | undefined
  try {
    const marker = 'synthetic-private-security-fixture'
    const files = [
      '.dev.vars', '.dev.vars.local', '.wrangler/state/local.sqlite',
      '.env', '.env.local', 'test.crt', 'test.pem', 'test.key', 'test.p12',
      'test.pfx', 'test.cer', 'test.der', '.npmrc', '.yarnrc.yml', '.git/config',
    ]
    mkdirSync(join(root, '.wrangler', 'state'), { recursive: true })
    mkdirSync(join(root, '.git'))
    for (const file of files) writeFileSync(join(root, file), marker)
    writeFileSync(join(root, '.dev.vars'), [
      `# ${marker}`,
      'ACCESS_ISSUER=https://test-team.cloudflareaccess.com',
      'ACCESS_AUD=synthetic-audience',
      'ADMIN_EMAIL=admin@example.test',
      'APP_ORIGIN=https://example.test',
    ].join('\n'))
    writeFileSync(join(root, 'index.html'), '<!doctype html><title>Security fixture</title>')
    const configPath = join(root, 'wrangler.json')
    writeFileSync(configPath, JSON.stringify({
      name: 'dev-security-test',
      main: fileURLToPath(new URL('./worker/index.ts', import.meta.url)),
      compatibility_date: '2026-09-05',
      assets: { not_found_handling: 'single-page-application', run_worker_first: ['/api/*'] },
      d1_databases: [{ binding: 'DB', database_name: 'security-test', database_id: 'security-test' }],
    }))

    const production = config({ command: 'serve', mode: 'test' })
    const defaults = await resolveConfig({ configFile: false, root, envDir: false }, 'serve')
    expect(production.server!.fs!.deny).toEqual(expect.arrayContaining(defaults.server.fs.deny))
    const actual = await vi.importActual<typeof import('@cloudflare/vite-plugin')>('@cloudflare/vite-plugin')
    server = await createServer({
      ...production,
      root,
      configFile: false,
      envDir: false,
      cacheDir: join(root, 'vite-cache'),
      logLevel: 'silent',
      plugins: [...production.plugins!, ...actual.cloudflare({
        configPath, persistState: false, remoteBindings: false, inspectorPort: false, tunnel: false,
      })],
      server: { ...production.server, port: 0, fs: { ...production.server!.fs, allow: [root, fileURLToPath(new URL('.', import.meta.url))] } },
    })
    await server.listen()
    const address = server.httpServer!.address()
    if (!address || typeof address === 'string') throw new Error('Missing test server address')
    const base = `http://127.0.0.1:${address.port}`

    const preflight = await fetch(`${base}/api/months`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
    })
    expect(preflight.status).toBe(401)
    expect(await preflight.json()).toEqual({ error: 'unauthorized' })
    expect(preflight.headers.get('cache-control')).toBe('private, no-store')
    expect([...preflight.headers.keys()].filter((name) => name.startsWith('access-control-'))).toEqual([])

    for (const prefix of ['/cdn-cgi/local/explorer', '/cdn-cgi/explorer', '/cdn-cgi/handler/explorer']) {
      const response = await fetch(`${base}${prefix}/api/d1/database/security-test/raw`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql: `SELECT '${marker}' AS secret` }),
      })
      // Disabled Explorer routes fall through to the Worker's authentication gate.
      expect(response.status, prefix).toBe(401)
      expect(await response.text()).toBe('{"error":"unauthorized"}')
      expect(response.headers.get('cache-control')).toBe('private, no-store')
    }

    // Both ordinary asset paths and Vite's absolute-file middleware must refuse these.
    for (const file of files) {
      for (const path of [`/${file}`, `/@fs/${normalizePath(join(root, file))}`]) {
        const response = await fetch(`${base}${path}`)
        expect(response.status, path).toBe(403)
        expect(await response.text(), path).not.toContain(marker)
      }
    }
  } finally {
    await server?.close()
    rmSync(root, { recursive: true, force: true })
  }
}, 60_000)
