import { NextFunction, Request, Response } from 'express';

// A few standard protective headers, set on every response. (This is the
// useful subset of what the `helmet` package does, without adding a dependency.)
export function securityHeaders(isProd: boolean) {
  return (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    // This is a JSON API: it never needs to run scripts or load anything.
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    if (isProd) {
      res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    }
    next();
  };
}
