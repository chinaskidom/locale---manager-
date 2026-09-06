export interface Member {
  id: number
  name: string
  email: string
  is_active: number
  created_at: string
}

export type MonthStatus =
  | 'DRAFT'
  | 'PUBLISHED'
  | 'CLOSED'

export interface Month {
  id: number
  year: number
  month: number
  bill_amount_cents: number
  fixed_amount_cents: number
  per_member_amount_cents: number | null
  status: MonthStatus
  due_date: string
  created_at: string
  published_at: string | null
  closed_at: string | null
}

export type PaymentStatus = 'UNPAID' | 'PAID'

export interface MonthMember {
  id: number
  month_id: number
  member_id: number
  created_at: string
  payment_status: PaymentStatus
  paid_at: string | null
}

export interface MonthParticipant {
  member_id: number
  name: string
  payment_status: PaymentStatus
  paid_at: string | null
}

export interface MonthDetail extends Month {
  participants: MonthParticipant[]
}
