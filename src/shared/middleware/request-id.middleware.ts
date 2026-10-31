import { randomUUID } from 'crypto';
import { NextFunction, Request, Response } from 'express';

export const REQUEST_ID_HEADER = 'X-Request-Id';

// Gives every request an id and echoes it on the response, so a partner can
// quote it to support and the logs can be matched to it. An id sent by the
// client (or the host's proxy) is kept only if it looks safe.
export function requestId(req: Request, res: Response, next: NextFunction) {
  const incoming = req.header(REQUEST_ID_HEADER);
  const id = incoming && /^[A-Za-z0-9._-]{8,64}$/.test(incoming) ? incoming : randomUUID();
  (req as any).requestId = id;
  res.setHeader(REQUEST_ID_HEADER, id);
  next();
}
