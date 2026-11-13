function positiveInt(raw: string | undefined, fallback: number): number {
  const n = parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export default () => ({
  port: parseInt(process.env.PORT || '3000', 10),
  productImages: {
    // PUBLIC Supabase bucket, created automatically on first upload.
    bucket: process.env.PRODUCT_IMAGES_BUCKET || 'product-images',
    maxBytes: parseInt(process.env.PRODUCT_IMAGE_MAX_BYTES || String(5 * 1024 * 1024), 10),
    maxPerProduct: parseInt(process.env.PRODUCT_IMAGES_MAX || '5', 10),
  },
  promotionImages: {
    // PUBLIC Supabase bucket, created automatically on first upload.
    bucket: process.env.PROMOTION_IMAGES_BUCKET || 'promotion-images',
  },
  preOrders: {
    // PRIVATE Supabase bucket for customers' reference photos, created on first upload.
    bucket: process.env.PREORDER_IMAGES_BUCKET || 'preorder-references',
    maxImages: parseInt(process.env.PREORDER_IMAGES_MAX || '5', 10),
  },
  documents: {
    bucket: process.env.DOCUMENTS_BUCKET || 'partner-documents',
    maxBytes: parseInt(process.env.DOCUMENT_MAX_BYTES || String(5 * 1024 * 1024), 10),
    // OFF by default: when on, a partner needs every required document
    // approved before they can accept a job.
    requireVerification: process.env.PARTNER_REQUIRE_VERIFICATION === 'true',
  },
  presence: {
    // OFF by default. Turn on (PARTNER_AUTO_OFFLINE=true) only once the app
    // sends location or heartbeat updates, or partners are taken offline
    // after the timeout even though they are still working.
    autoOffline: process.env.PARTNER_AUTO_OFFLINE === 'true',
    offlineAfterSeconds: parseInt(process.env.PARTNER_OFFLINE_AFTER_SECONDS || '180', 10),
    updateEverySeconds: 60,
  },
  wallet: {
    currency: 'GHS',
    minCashOutPesewas: parseInt(process.env.CASH_OUT_MIN_PESEWAS || '1000', 10),
    cashOutFeePesewas: parseInt(process.env.CASH_OUT_FEE_PESEWAS || '0', 10),
  },
  jwt: {
    secret: process.env.JWT_SECRET,
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    // Staff get an access token plus a one-time refresh token. Every staff
    // request checks the session (JwtStrategy), so logout or deactivation
    // takes effect at once whatever the lifetime. 12h keeps the admin
    // console, which doesn't refresh, signed in for a working day.
    staffAccessExpiresIn: process.env.STAFF_ACCESS_TOKEN_EXPIRES_IN || '12h',
    staffRefreshDays: parseInt(process.env.STAFF_REFRESH_TOKEN_DAYS || '30', 10),
  },
  supabase: {
    url: process.env.SUPABASE_URL,
    anonKey: process.env.SUPABASE_ANON_KEY,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  },
  // Used once to create your very first admin via POST /staff/bootstrap-admin.
  // Set this to a long random string in your .env / Render environment variables.
  adminBootstrapSecret: process.env.ADMIN_BOOTSTRAP_SECRET,
  orders: {
    // Flat delivery fee added to marketplace orders (GHS). Set to 0 for free delivery.
    marketplaceDeliveryFee: parseFloat(process.env.MARKETPLACE_DELIVERY_FEE ?? '5'),
    // Unpaid orders with no payment started are cancelled (and restocked)
    // after this many minutes. Invalid or non-positive values fall back to 30.
    paymentTimeoutMinutes: positiveInt(process.env.ORDER_PAYMENT_TIMEOUT_MINUTES, 30),
  },
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
