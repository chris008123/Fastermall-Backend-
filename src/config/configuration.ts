export default () => ({
  port: parseInt(process.env.PORT || '3000', 10),
  jwt: {
    secret: process.env.JWT_SECRET,
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  },
  supabase: {
    url: process.env.SUPABASE_URL,
    anonKey: process.env.SUPABASE_ANON_KEY,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  },
  // Used once to create your very first admin via POST /staff/bootstrap-admin.
  // Set this to a long random string in your .env / Render environment variables.
  adminBootstrapSecret: process.env.ADMIN_BOOTSTRAP_SECRET,
  payments: {
    // 'paystack' (default) or 'mock' (local dev only — refused in production)
    provider: process.env.PAYMENT_PROVIDER || 'paystack',
    currency: process.env.PAYMENT_CURRENCY || 'GHS',
    // Where the provider sends the customer's browser after checkout
    callbackUrl: process.env.PAYMENT_CALLBACK_URL,
    paystack: {
      secretKey: process.env.PAYSTACK_SECRET_KEY,
      baseUrl: process.env.PAYSTACK_BASE_URL || 'https://api.paystack.co',
    },
  },
  // Comma-separated list of allowed browser origins. Native mobile apps send
  // no Origin header, so they are unaffected by this.
  corsOrigins: (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  email: {
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || '587', 10),
  user: process.env.SMTP_USER,
  pass: process.env.SMTP_PASS,
  from: process.env.EMAIL_FROM || process.env.SMTP_USER,
  },
});
