export class MonthNotFoundError extends Error {
  constructor() {
    super('month not found')
    this.name = 'MonthNotFoundError'
  }
}

export class MonthHasNoMembersError extends Error {
  constructor() {
    super('month has no members')
    this.name = 'MonthHasNoMembersError'
  }
}

export class MonthNotPublishableError extends Error {
  constructor() {
    super('month is not publishable')
    this.name = 'MonthNotPublishableError'
  }
}