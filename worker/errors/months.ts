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

export class InvalidMonthInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidMonthInputError'
  }
}

export class MonthAlreadyExistsError extends Error {
  constructor() {
    super('month already exists')
    this.name = 'MonthAlreadyExistsError'
  }
}

export class MonthNotEditableError extends Error {
  constructor() {
    super('month is not editable')
    this.name = 'MonthNotEditableError'
  }
}

export class MemberNotInMonthError extends Error {
  constructor() {
    super('member is not included in month')
    this.name = 'MemberNotInMonthError'
  }
}

export class MemberNotFoundError extends Error {
  constructor() {
    super('member not found')
    this.name = 'MemberNotFoundError'
  }
}

export class MemberNotActiveError extends Error {
  constructor() {
    super('member is not active')
    this.name = 'MemberNotActiveError'
  }
}

export class MemberAlreadyInMonthError extends Error {
  constructor() {
    super('member is already included in month')
    this.name = 'MemberAlreadyInMonthError'
  }
}

export class MonthMembershipConflictError extends Error {
  constructor() {
    super('month membership conflicted with another change')
    this.name = 'MonthMembershipConflictError'
  }
}
