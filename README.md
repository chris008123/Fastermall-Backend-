# Super App Backend

Modular monolith backend for the Marketplace + Food Delivery + Laundry + Logistics
super app, matching the architecture doc. Built with **NestJS + TypeScript**,
**Prisma**, and **Supabase (Postgres)**.

## Why this stack

- **NestJS** gives you real module boundaries (`@Module()`) per business domain,
  which is exactly the "Modular Monolith" structure in the doc — each folder under
  `src/modules/` owns its controllers, services, and (via Prisma) its data.
- **Supabase** is used as a managed Postgres database. We connect to it with
  **Prisma**, not the `supabase-js` client, because Prisma gives you migrations,
  type-safe queries, and a single schema file (`prisma/schema.prisma`) that maps
  directly to the ERD you'll design. `supabase-js` is still included as a dependency
  for later use (e.g. Supabase Storage for laundry/product images).
- **We issue our own JWTs** in the Identity module rather than using Supabase Auth
  directly. This matches the doc's Authentication Layer (JWT, OTP, roles, permissions)
  and keeps auth logic — and the ability to add OTP, staff roles, delivery partner
  roles, etc. — fully inside your backend instead of split across two systems.

## Project structure

```
src/
  main.ts            # bootstrap: validation, error format, CORS, security headers
  app.module.ts      # wires every module together; global rate limit and audit log
  config/            # environment configuration and start-up checks
  database/          # PrismaService (the only way modules reach the database)
  shared/            # guards, interceptors, filters, email, storage, small utilities
  modules/
    identity/              # customer sign-up, email codes, login, Google sign-in, /me
    staff/                 # staff logins, sessions, password resets, deactivation
    partner-applications/  # delivery partner applications and approval
    addresses/             # customers' saved addresses
    marketplace/           # products, categories, photos, reviews
    food/                  # food vendors, menus, option groups and add-ons
    orders/                # checkout, stock, delivery windows, cancelling, unpaid expiry
    preorders/             # custom design requests and quotes
    laundry/               # laundry vendors, price lists, 13-stage orders, ratings
    logistics/             # delivery jobs, handover codes, wallet, payouts, documents
    payments/              # Paystack checkout, webhook, verification, refunds
    notifications/         # in-app notifications, Expo push, broadcasts
    support/               # support tickets and replies
    promotions/            # scheduled in-app promotions
    faq/                   # FAQ
    admin/                 # dashboard, cross-customer lists, audit log
    settings/              # platform settings (fees, maintenance, WhatsApp)
    app-config/            # minimum app versions and support contacts
prisma/
  schema.prisma      # every table, in one file
  migrations/        # dated, additive database changes
  seed.ts            # demo catalog and starter FAQs (SEED_ONLY=faqs for FAQs only)
presentation/        # plain-English deck and diagrams explaining the backend, with an audit
```

Every module has the same shape: `<name>.module.ts`, `<name>.controller.ts`
(the routes, kept thin), `<name>.service.ts` (the business rules), DTOs in
`dto/` and tests in `*.spec.ts`. Services talk to the database only through
`PrismaService`. Modules tell each other about changes through events
(`@nestjs/event-emitter`, e.g. `order.created`, `payment.successful`) rather
than calling each other directly.

## Setup

1. **Create a Supabase project** at supabase.com if you haven't already.
2. **Get your connection strings**: Project Settings → Database → Connection string.
   You need both the pooled (port 6543) and direct (port 5432) URLs.
3. Copy the env file and fill in your real values:
   ```bash
   cp .env.example .env
   ```
4. Install dependencies:
   ```bash
   npm install
   ```
5. Create the tables and generate the Prisma client:
   ```bash
   npx prisma migrate deploy
   npx prisma generate
   ```
6. Optionally add demo data and the starter FAQs:
   ```bash
   npx prisma db seed
   ```
7. Run the server:
   ```bash
   npm run start:dev
   ```
8. Test the auth flow:
   ```bash
   curl -X POST http://localhost:3000/api/v1/auth/register      -H "Content-Type: application/json"      -d '{"email":"you@example.com","password":"password123","fullName":"Test User"}'
   ```
   A verification code is emailed (SMTP settings needed); confirm it with
   `POST /api/v1/auth/verify-otp`, then use the returned token as
   `Authorization: Bearer <token>`.

Run the tests with `npm test`. Deploying to production: see `DEPLOYMENT.md`.

## What's built

Every module above is fully implemented and tested (`npm test`). The API
contracts for the app teams are in `APP_CHANGES.md`, what was built and why in
`BACKEND_WORK_LOG.md`, and a non-technical overview with an audit in
`presentation/`.

## Notes for your co-founder (frontend/Expo)

- Base URL: `http://<your-host>:3000/api/v1`
- All responses are wrapped: `{ success: true, data: ... }` on success,
  `{ success: false, statusCode, error, path, timestamp }` on error.
- Auth: `POST /auth/register`, `POST /auth/login` return `{ accessToken, user }`.
  Send `Authorization: Bearer <accessToken>` on subsequent requests.

## Admin console endpoints

ADMIN-only, read-only views across every customer (`src/modules/admin`).
Lists take `?page=&pageSize=` (max 100) and answer
`{ data: [...], page, pageSize, hasMore, total }`; unknown filter values are
a 400.

| Route | Filters |
| --- | --- |
| `GET /admin/orders` | `status` (OrderStatus), `type` (OrderType) |
| `GET /admin/orders/:id` | — (any customer's order, with delivery timeline) |
| `GET /admin/laundry-orders` | `status` (LaundryStatus) |
| `GET /admin/deliveries` | `status` (DeliveryStatus) |
| `GET /admin/payments` | `status` (PaymentStatus) |
| `GET /admin/partners` | — (profile, active/completed deliveries, earnings) |

ADMIN-only actions:

| Route | Body | Effect |
| --- | --- | --- |
| `PATCH /payments/:id/cash-collected` | — | **Deprecated** (cash was removed from checkout; only for cash payments chosen before Nov 2026). PENDING CASH payment → SUCCESSFUL (`provider: cash`, `providerRef: collected-by:<staffId>`); emits `payment.successful` |
| `PATCH /staff/users/:id` | `fullName?`, `email?`, `phone?` (`""` clears phone) | Edit contact details; role can't be changed |
| `PATCH /staff/users/:id/password` | `password` (min 8) | Set a new password; existing tokens stay valid until they expire |
| `PATCH /staff/users/:id/active` | `isActive` (boolean) | Deactivate / reactivate. Deactivated staff can't log in and their tokens are refused at once. You can't deactivate yourself or the last active admin |
| `POST /support/tickets/:id/replies` | `message` (1–5000) | Reply to a ticket; OPEN → IN_PROGRESS; CLOSED tickets refuse replies; customer is notified |

| `POST /payments/:id/refund` | `reason?` | Full refund of a SUCCESSFUL payment: online payments go back through Paystack first; cash is marked refunded. Emits `payment.refunded` (customer notified) |
| `GET /admin/partners/:staffId/payouts` | — | A partner's payouts |
| `POST /admin/partners/:staffId/payouts` | `amount`, `method?`, `reference?`, `note?` | Record money sent to a partner; can't exceed their balance (earned − paid out) |
| `POST /admin/notifications/broadcast` | `audience` (CUSTOMERS, DELIVERY_PARTNER, VENDOR, LAUNDRY_STAFF, ADMIN, ALL_STAFF), `title`, `body` | In-app notification + push to everyone in the audience |
| `GET /admin/audit-logs` | `page`, `pageSize` | Every successful admin write (AuditInterceptor), secrets redacted |
| `GET/PATCH /admin/settings` | `marketplaceDeliveryFee`, `laundryPickupFee`, `partnerEarningPerDelivery`, `maintenanceMode`, `maintenanceMessage` | Platform settings; missing values use the defaults in `settings.service.ts` |

`GET /settings` (public) returns the fees, maintenance state and `acceptedPaymentMethods` (`MOBILE_MONEY`, `CARD`) for the apps.

Cash payments are no longer accepted: `POST /payments/initialize` and `POST /orders` refuse any cash method with a 400 (see `src/modules/payments/payment-methods.ts`).
`GET /admin/dashboard` also returns `revenueTotal`, `revenueLast30Days`,
`refundedTotal` and `revenueByMonth` (last six months), counting SUCCESSFUL
payments. `GET /admin/partners` adds `totalPaidOut` and `balance`.

Payouts, settings and the audit log need migration
`20261104150000_payouts_settings_audit_log` (new tables only). Until it runs,
settings fall back to their defaults and audit writes are skipped, so ordering
and login keep working; the partner list and payouts fail.

`GET /support/tickets/:id` returns one ticket with its replies: admins can open
any ticket (with the customer's contact details), customers only their own.

Deactivation and replies need migration
`20261104120000_staff_deactivation_and_ticket_replies`. Run
`npx prisma migrate deploy` **before** deploying this code: Prisma selects the
new columns on every staff lookup, so without them staff login fails.

Delivery handover-code secrets (`deliveryCodeHash`, `deliveryCodeEncrypted`,
attempt counters) are never returned by any endpoint; see
`src/shared/utils/delivery-secrets.ts`.

## Deploying

See **[DEPLOYMENT.md](DEPLOYMENT.md)**: environment variables, migrations, one-off steps, smoke tests and admin tasks for each release.

## Deploying the partner-app merge (Nov 2026)

Run `npx prisma migrate deploy` before starting the new code. It applies the
partner-app migrations (dated Oct 17 to Nov 1) and
`20261110120000_merge_support_messages_into_replies`. They were checked
against databases built from `main` and from `master`, and both end up
matching the schema. All staff must sign in again once (staff tokens now
need a session). See `APP_CHANGES.md` and `PARTNER_APP_INTEGRATION.md`.

