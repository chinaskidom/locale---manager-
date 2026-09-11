export class InvalidMemberInputError extends Error {
  constructor() {
    super('expected a nonempty name and valid email')
    this.name = 'InvalidMemberInputError'
  }
}

export class MemberAlreadyExistsError extends Error {
  constructor() {
    super('member email already exists')
    this.name = 'MemberAlreadyExistsError'
  }
}
