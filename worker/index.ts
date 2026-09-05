import {
  MonthHasNoMembersError,
  MonthNotFoundError,
  MonthNotPublishableError,
} from './errors/months'
import { getAllMembers } from './repositories/members'
import {
  calculateMonthAmount,
  publishMonthAmount,
} from './services/months'

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

    const calculationMatch = url.pathname.match(
      /^\/api\/months\/(\d+)\/calculation$/,
    )

    if (calculationMatch && request.method === 'GET') {
      const monthId = Number(calculationMatch[1])

      if (!Number.isSafeInteger(monthId) || monthId <= 0) {
        return Response.json(
          { error: 'invalid month id' },
          { status: 400 },
        )
      }

      try {
        const perMemberAmountCents = await calculateMonthAmount(
          env.DB,
          monthId,
        )

        return Response.json({
          perMemberAmountCents,
        })
      } catch (error) {
        if (error instanceof MonthNotFoundError) {
          return Response.json(
            { error: 'month not found' },
            { status: 404 },
          )
        }

        if (error instanceof MonthHasNoMembersError) {
          return Response.json(
            { error: 'month has no members' },
            { status: 422 },
          )
        }

        throw error
      }
    }

    const publishMatch = url.pathname.match(
      /^\/api\/months\/(\d+)\/publish$/,
    )

    if (publishMatch && request.method === 'POST') {
      const monthId = Number(publishMatch[1])

      if (!Number.isSafeInteger(monthId) || monthId <= 0) {
        return Response.json(
          { error: 'invalid month id' },
          { status: 400 },
        )
      }

      try {
        const perMemberAmountCents = await publishMonthAmount(
          env.DB,
          monthId,
        )

        return Response.json({
          status: 'PUBLISHED',
          perMemberAmountCents,
        })
      } catch (error) {
        if (error instanceof MonthNotFoundError) {
          return Response.json(
            { error: 'month not found' },
            { status: 404 },
          )
        }

        if (error instanceof MonthHasNoMembersError) {
          return Response.json(
            { error: 'month has no members' },
            { status: 422 },
          )
        }

        if (error instanceof MonthNotPublishableError) {
          return Response.json(
            { error: 'month is not publishable' },
            { status: 409 },
          )
        }

        throw error
      }
    }

    return new Response('Not Found', {
      status: 404,
    })
  },
}