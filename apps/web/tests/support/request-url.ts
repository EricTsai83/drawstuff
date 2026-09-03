/**
 * The URL a `fetch` stub was called with, whichever input form the caller used.
 * A `Request` stringifies to `[object Request]`, so it is read explicitly.
 */
export const requestUrl = (input: RequestInfo | URL): string =>
  input instanceof Request ? input.url : input.toString();
