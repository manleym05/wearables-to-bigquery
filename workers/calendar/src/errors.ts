// Typed error carrying an HTTP status so the router maps failures correctly:
// client/validation problems -> 4xx, upstream Google problems -> 5xx.
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}
