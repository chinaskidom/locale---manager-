import { getAllMembers } from './repositories/members'

interface Env {
  DB: D1Database
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/api/health') {
      return Response.json({
        status: 'ok',
      })
    }

    if (url.pathname === '/api/members' && request.method === 'GET') {
      const members = await getAllMembers(env.DB)

      return Response.json(members)
    }

    return new Response('Not Found', {
      status: 404,
    })
  },
}