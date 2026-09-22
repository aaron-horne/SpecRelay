export class ServiceError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 401 | 403 | 404 | 409 | 502 | 504,
    readonly code: string,
    readonly details: readonly string[] = [],
  ) {
    super(message);
    this.name = "ServiceError";
  }
}