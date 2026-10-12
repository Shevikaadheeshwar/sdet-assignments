/**
 * A failure that is part of the domain's contract rather than a crash: the HTTP
 * layer maps it to a status code, so services never import anything from Express
 * and stay independently testable.
 */
export class DomainError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
