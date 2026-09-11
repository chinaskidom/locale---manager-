import { createRemoteJWKSet, jwtVerify } from 'jose'
import { getMemberIdentityByEmail } from './repositories/members'

export type AuthenticatedIdentity = {
  memberId: number
  name: string
  role: 'ADMIN' | 'MEMBER'
}

let keySet: { issuer: string; keys: ReturnType<typeof createRemoteJWKSet> } | undefined

export async function authorize(request: Request, env: Env): Promise<AuthenticatedIdentity | Response> {
  let adminEmail: string
  try {
    const origin = new URL(env.APP_ORIGIN)
    if (
      typeof env.ACCESS_ISSUER !== 'string' ||
      !/^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/.test(env.ACCESS_ISSUER) ||
      typeof env.ACCESS_AUD !== 'string' || !/^\S+$/.test(env.ACCESS_AUD) ||
      typeof env.ADMIN_EMAIL !== 'string' ||
      !/^[^\s@]+@[^\s@]+$/.test(env.ADMIN_EMAIL.trim()) ||
      origin.protocol !== 'https:' || origin.origin !== env.APP_ORIGIN
    ) {
      throw new Error()
    }
    adminEmail = env.ADMIN_EMAIL.trim().toLowerCase()
  } catch {
    return Response.json({ error: 'service unavailable' }, { status: 503 })
  }

  let email: string
  try {
    const assertion = request.headers.get('Cf-Access-Jwt-Assertion')
    if (!assertion) throw new Error()

    if (keySet?.issuer !== env.ACCESS_ISSUER) {
      keySet = {
        issuer: env.ACCESS_ISSUER,
        keys: createRemoteJWKSet(new URL(`${env.ACCESS_ISSUER}/cdn-cgi/access/certs`)),
      }
    }
    const { payload } = await jwtVerify(assertion, keySet.keys, {
      algorithms: ['RS256'],
      issuer: env.ACCESS_ISSUER,
      audience: env.ACCESS_AUD,
      requiredClaims: ['iss', 'aud', 'exp', 'iat', 'sub', 'email', 'type'],
    })

    // Access service/global tokens are not human application identities.
    if (
      payload.type !== 'app' || payload.common_name !== undefined ||
      typeof payload.sub !== 'string' || !payload.sub.trim() ||
      typeof payload.email !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(payload.email.trim()) ||
      typeof payload.iat !== 'number' || !Number.isFinite(payload.iat) ||
      typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) ||
      payload.iat > Date.now() / 1000 || payload.exp <= payload.iat
    ) {
      throw new Error()
    }
    email = payload.email.trim().toLowerCase()
  } catch {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }

  const member = await getMemberIdentityByEmail(env.DB, email)
  if (member === null) {
    return Response.json({ error: 'forbidden' }, { status: 403 })
  }

  const isAdmin = email === adminEmail
  const path = new URL(request.url).pathname
  // Only these GET routes are member-readable; new routes default to administrator-only.
  if (!isAdmin && !(request.method === 'GET' && (
    path === '/api/me' || path === '/api/health' || path === '/api/months' || /^\/api\/months\/\d+$/.test(path)
  ))) {
    return Response.json({ error: 'forbidden' }, { status: 403 })
  }

  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
    request.headers.get('Origin') !== env.APP_ORIGIN) {
    return Response.json({ error: 'forbidden' }, { status: 403 })
  }

  return { memberId: member.id, name: member.name, role: isAdmin ? 'ADMIN' : 'MEMBER' }
}
