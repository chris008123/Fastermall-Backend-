import { Logger } from '@nestjs/common';

// Fails fast at startup on settings that would make the server unsafe, instead
// of discovering the problem in production traffic.
export function validateEnv(env: NodeJS.ProcessEnv = process.env) {
  const logger = new Logger('Env');
  const isProd = env.NODE_ENV === 'production';
  const problems: string[] = [];

  const jwt = env.JWT_SECRET ?? '';
  if (jwt.length < 32) {
    problems.push('JWT_SECRET must be set to a random string of at least 32 characters');
  }

  if (!/^[0-9a-fA-F]{64}$/.test(env.DELIVERY_CODE_ENCRYPTION_KEY ?? '')) {
    problems.push('DELIVERY_CODE_ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
  }

  if (isProd && (env.PAYMENT_PROVIDER ?? 'paystack').toLowerCase() === 'mock') {
    problems.push('PAYMENT_PROVIDER=mock is not allowed in production');
  }

  if (problems.length > 0) {
    const message = `Invalid environment:\n - ${problems.join('\n - ')}`;
    if (isProd) throw new Error(message);
    logger.warn(message);
  }

  // Not fatal, so the app can still boot and serve everything else.
  if ((env.PAYMENT_PROVIDER ?? 'paystack').toLowerCase() === 'paystack' && !env.PAYSTACK_SECRET_KEY) {
    logger.warn('PAYSTACK_SECRET_KEY is not set — online payments will fail until it is.');
  }
  if (isProd && !env.CORS_ORIGINS) {
    logger.warn('CORS_ORIGINS is not set — browser requests are accepted from any origin.');
  }
}
