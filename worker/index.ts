import { authorize } from './auth'
import type { AuthenticatedIdentity } from './auth'
import { InvalidMemberInputError, MemberAlreadyExistsError } from './errors/members'
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
import { createMember, setMemberActiveStatus } from './services/members'
import {
  calculateMonthAmount,
  closeMonth,
  createDraftMonth,
  getMonthDetail,
  publishMonthAmount,
  excludeMemberFromMonth,
  includeMemberInMonth,
  listMonths,
  markMemberPaymentPaid,
  updateMonthBill,
} from './services/months'

function parsePositiveId(value: string): number | null {
  const id = Number(value)

  return Number.isSafeInteger(id) && id > 0
    ? id
    : null
}

const api = {
  async fetch(request: Request, env: Env, identity: AuthenticatedIdentity): Promise<Response> {
    const url = new URL(request.url)
    const isAdmin = identity.role === 'ADMIN'

    if (url.pathname === '/api/me' && request.method === 'GET') {
      return Response.json({ memberId: identity.memberId, name: identity.name, role: identity.role })
    }

    if (url.pathname === '/api/health' && request.method === 'GET') {
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

    if (url.pathname === '/api/admin/members' && request.method === 'POST') {
      let body: unknown
      try {
        body = await request.json()
      } catch {
        return Response.json({ error: 'invalid JSON body' }, { status: 400 })
      }

      if (
        typeof body !== 'object' || body === null ||
        !('name' in body) || typeof body.name !== 'string' ||
        !('email' in body) || typeof body.email !== 'string' ||
        Object.keys(body).length !== 2
      ) {
        return Response.json({ error: 'expected only name and email as strings' }, { status: 400 })
      }

      try {
        const member = await createMember(env.DB, { name: body.name, email: body.email })
        return Response.json({ memberId: member.id, name: member.name }, { status: 201 })
      } catch (error) {
        if (error instanceof InvalidMemberInputError) {
          return Response.json({ error: error.message }, { status: 400 })
        }

        if (error instanceof MemberAlreadyExistsError) {
          return Response.json({ error: error.message }, { status: 409 })
        }

        throw error
      }
    }

    const memberActiveMatch = url.pathname.match(/^\/api\/admin\/members\/([^/]+)\/active$/)

    if (memberActiveMatch && request.method === 'PATCH') {
      const memberId = /^\d+$/.test(memberActiveMatch[1]) ? parsePositiveId(memberActiveMatch[1]) : null

      if (memberId === null) {
        return Response.json({ error: 'invalid member id' }, { status: 400 })
      }

      let body: unknown
      try {
        body = await request.json()
      } catch {
        return Response.json({ error: 'invalid JSON body' }, { status: 400 })
      }

      if (
        typeof body !== 'object' || body === null ||
        !('isActive' in body) || typeof body.isActive !== 'boolean' ||
        Object.keys(body).length !== 1
      ) {
        return Response.json({ error: 'expected only isActive as a boolean' }, { status: 400 })
      }

      try {
        await setMemberActiveStatus(env.DB, memberId, body.isActive)
        return new Response(null, { status: 204 })
      } catch (error) {
        if (error instanceof MemberNotFoundError) {
          return Response.json({ error: error.message }, { status: 404 })
        }

        throw error
      }
    }

    if (
      url.pathname === '/api/months' &&
      request.method === 'GET'
    ) {
      const months = await listMonths(env.DB)
      return Response.json(isAdmin ? months : months.filter((month) =>
        month.status === 'PUBLISHED' || month.status === 'CLOSED',
      ))
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
        const month = await getMonthDetail(env.DB, monthId)
        if (!isAdmin && month.status !== 'PUBLISHED' && month.status !== 'CLOSED') {
          throw new MonthNotFoundError()
        }
        return Response.json(month)
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

    const billMatch = url.pathname.match(/^\/api\/admin\/months\/([^/]+)\/bill$/)

    if (billMatch && request.method === 'PATCH') {
      const monthId = /^\d+$/.test(billMatch[1]) ? parsePositiveId(billMatch[1]) : null

      if (monthId === null) {
        return Response.json({ error: 'invalid month id' }, { status: 400 })
      }

      let body: unknown
      try {
        body = await request.json()
      } catch {
        return Response.json({ error: 'invalid JSON body' }, { status: 400 })
      }

      if (
        typeof body !== 'object' || body === null ||
        !('billAmountEuros' in body) || typeof body.billAmountEuros !== 'number' ||
        Object.keys(body).length !== 1
      ) {
        return Response.json({ error: 'expected only billAmountEuros as a number' }, { status: 400 })
      }

      try {
        await updateMonthBill(env.DB, monthId, body.billAmountEuros)
        return new Response(null, { status: 204 })
      } catch (error) {
        if (error instanceof InvalidMonthInputError) {
          return Response.json({ error: error.message }, { status: 400 })
        }

        if (error instanceof MonthNotFoundError) {
          return Response.json({ error: error.message }, { status: 404 })
        }

        if (error instanceof MonthNotEditableError) {
          return Response.json({ error: error.message }, { status: 409 })
        }

        throw error
      }
    }

    const closeMatch = url.pathname.match(/^\/api\/admin\/months\/([^/]+)\/close$/)

    if (closeMatch && request.method === 'POST') {
      const monthId = /^\d+$/.test(closeMatch[1]) ? parsePositiveId(closeMatch[1]) : null

      if (monthId === null) {
        return Response.json({ error: 'invalid month id' }, { status: 400 })
      }

      if (await request.text()) {
        return Response.json({ error: 'request body is not allowed' }, { status: 400 })
      }

      try {
        await closeMonth(env.DB, monthId)
        return new Response(null, { status: 204 })
      } catch (error) {
        if (error instanceof MonthNotFoundError) {
          return Response.json({ error: error.message }, { status: 404 })
        }

        if (error instanceof MonthNotEditableError) {
          return Response.json({ error: error.message }, { status: 409 })
        }

        throw error
      }
    }

    const paymentMatch = url.pathname.match(
      /^\/api\/admin\/months\/([^/]+)\/members\/([^/]+)\/paid$/,
    )

    if (paymentMatch && request.method === 'POST') {
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let response: Response
    try {
      const authorization = await authorize(request, env)
      response = authorization instanceof Response
        ? authorization
        : await api.fetch(request, env, authorization)
    } catch {
      // Never leak database errors, claims, or authentication configuration.
      response = Response.json({ error: 'internal server error' }, { status: 500 })
    }
    response.headers.set('Cache-Control', 'private, no-store')
    return response
  },
}
