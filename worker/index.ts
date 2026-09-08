import {
  InvalidMonthInputError,
  MemberAlreadyInMonthError,
  MemberNotActiveError,
  MemberNotFoundError,
  MonthAlreadyExistsError,
  MonthHasNoMembersError,
  MonthMembershipConflictError,
  MonthNotFoundError,
  MonthNotPublishableError,
  MemberNotInMonthError,
  MonthNotEditableError
} from './errors/months'
import { getAllMembers } from './repositories/members'
import {
  calculateMonthAmount,
  createDraftMonth,
  getMonthDetail,
  publishMonthAmount,
  excludeMemberFromMonth,
  includeMemberInMonth,
  listMonths,
  markMemberPaymentPaid,
} from './services/months'

interface Env {
  DB: D1Database
}

function parsePositiveId(value: string): number | null {
  const id = Number(value)

  return Number.isSafeInteger(id) && id > 0
    ? id
    : null
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/api/health') {
      return Response.json({
        status: 'ok',
      })
    }

    if (
      url.pathname === '/api/members' &&
      request.method === 'GET'
    ) {
      const members = await getAllMembers(env.DB)

      return Response.json(members)
    }

    if (
      url.pathname === '/api/months' &&
      request.method === 'GET'
    ) {
      return Response.json(await listMonths(env.DB))
    }

    const monthMatch = url.pathname.match(/^\/api\/months\/([^/]+)$/)

    if (monthMatch && request.method === 'GET') {
      const monthId = /^\d+$/.test(monthMatch[1])
        ? parsePositiveId(monthMatch[1])
        : null

      if (monthId === null) {
        return Response.json(
          { error: 'invalid month id' },
          { status: 400 },
        )
      }

      try {
        return Response.json(await getMonthDetail(env.DB, monthId))
      } catch (error) {
        if (error instanceof MonthNotFoundError) {
          return Response.json(
            { error: error.message },
            { status: 404 },
          )
        }

        throw error
      }
    }

    const calculationMatch = url.pathname.match(
      /^\/api\/months\/(\d+)\/calculation$/,
    )

    if (calculationMatch && request.method === 'GET') {
      const monthId = parsePositiveId(calculationMatch[1])

      if (monthId === null) {
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
      const monthId = parsePositiveId(publishMatch[1])

      if (monthId === null) {
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

    if (
      url.pathname === '/api/months' &&
      request.method === 'POST'
    ) {
      let body: unknown

      try {
        body = await request.json()
      } catch {
        return Response.json(
          { error: 'invalid JSON body' },
          { status: 400 },
        )
      }

      if (
        typeof body !== 'object' ||
        body === null
      ) {
        return Response.json(
          { error: 'invalid request body' },
          { status: 400 },
        )
      }

      const {
        year,
        month,
        billAmountEuros,
      } = body as Record<string, unknown>

      if (
        typeof year !== 'number' ||
        typeof month !== 'number' ||
        typeof billAmountEuros !== 'number'
      ) {
        return Response.json(
          { error: 'invalid request body' },
          { status: 400 },
        )
      }

      try {
        const createdMonth = await createDraftMonth(
          env.DB,
          {
            year,
            month,
            billAmountEuros,
          },
        )

        return Response.json(
          createdMonth,
          { status: 201 },
        )
      } catch (error) {
        if (error instanceof InvalidMonthInputError) {
          return Response.json(
            { error: error.message },
            { status: 400 },
          )
        }

        if (error instanceof MonthAlreadyExistsError) {
          return Response.json(
            { error: 'month already exists' },
            { status: 409 },
          )
        }

        throw error
      }
    }

    const paymentMatch = url.pathname.match(
      /^\/api\/admin\/months\/([^/]+)\/members\/([^/]+)\/paid$/,
    )

    if (paymentMatch && request.method === 'POST') {
      // Manual administrator confirmation; protect this route when authorization is added.
      const monthId = /^\d+$/.test(paymentMatch[1]) ? parsePositiveId(paymentMatch[1]) : null
      const memberId = /^\d+$/.test(paymentMatch[2]) ? parsePositiveId(paymentMatch[2]) : null

      if (monthId === null || memberId === null) {
        return Response.json({ error: 'invalid id' }, { status: 400 })
      }

      if (await request.text()) {
        return Response.json({ error: 'request body is not allowed' }, { status: 400 })
      }

      try {
        await markMemberPaymentPaid(env.DB, monthId, memberId)
        return new Response(null, { status: 204 })
      } catch (error) {
        if (error instanceof MonthNotFoundError || error instanceof MemberNotInMonthError) {
          return Response.json({ error: error.message }, { status: 404 })
        }

        if (error instanceof MonthNotEditableError) {
          return Response.json({ error: error.message }, { status: 409 })
        }

        throw error
      }
    }

    const monthMemberMatch = url.pathname.match(
      /^\/api\/months\/(\d+)\/members\/(\d+)$/,
    )

    if (
      monthMemberMatch &&
      (request.method === 'DELETE' || request.method === 'POST')
    ) {
      const monthId = parsePositiveId(monthMemberMatch[1])
      const memberId = parsePositiveId(monthMemberMatch[2])

      if (monthId === null || memberId === null) {
        return Response.json(
          { error: 'invalid id' },
          { status: 400 },
        )
      }

      try {
        if (request.method === 'POST') {
          await includeMemberInMonth(env.DB, monthId, memberId)
        } else {
          await excludeMemberFromMonth(env.DB, monthId, memberId)
        }

        return new Response(null, {
          status: 204,
        })
      } catch (error) {
        if (
          error instanceof MonthNotFoundError ||
          error instanceof MemberNotInMonthError ||
          error instanceof MemberNotFoundError
        ) {
          return Response.json(
            { error: error.message },
            { status: 404 },
          )
        }

        if (
          error instanceof MonthNotEditableError ||
          error instanceof MemberNotActiveError ||
          error instanceof MemberAlreadyInMonthError ||
          error instanceof MonthMembershipConflictError
        ) {
          return Response.json(
            { error: error.message },
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
