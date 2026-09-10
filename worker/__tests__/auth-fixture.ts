import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import type { JWTPayload } from 'jose'
import { vi } from 'vitest'

export const authConfig = {
  ACCESS_ISSUER: 'https://test-team.cloudflareaccess.com',
  ACCESS_AUD: 'a'.repeat(64),
  ADMIN_EMAIL: 'admin@example.test',
  APP_ORIGIN: 'https://example.com',
}

export async function createAuthFixture() {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true })
  const jwks = { keys: [{ ...await exportJWK(publicKey), kid: 'test-rsa', alg: 'RS256', use: 'sig' }] }
  const realFetch = globalThis.fetch
  return {
    sign(email = authConfig.ADMIN_EMAIL, claims: JWTPayload = {}, algorithm = 'RS256', key = privateKey) {
      const now = Math.floor(Date.now() / 1000)
      return new SignJWT({
        iss: authConfig.ACCESS_ISSUER,
        aud: [authConfig.ACCESS_AUD],
        sub: 'test-human-id',
        email,
        type: 'app',
        identity_nonce: 'test-nonce',
        iat: now,
        nbf: now - 1,
        exp: now + 3600,
        ...claims,
      }).setProtectedHeader({ alg: algorithm, kid: 'test-rsa' }).sign(key)
    },
    mockJwks() {
      return vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
        const url = input instanceof Request ? input.url : String(input)
        if (url === `${authConfig.ACCESS_ISSUER}/cdn-cgi/access/certs`) {
          return Promise.resolve(Response.json(jwks))
        }
        // D1's real loopback transport is not mocked.
        return realFetch(input, init)
      })
    },
  }
}
