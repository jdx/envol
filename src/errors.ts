export class RequestError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409 | 503 = 400,
  ) {
    super(message);
    this.name = "RequestError";
  }
}
