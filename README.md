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
  main.ts              # bootstrap, global pipes/filters/interceptors
  app.module.ts         # wires every domain module together
  config/                # environment configuration
  database/              # PrismaService + PrismaModule (the Data Layer)
  shared/                 # cross-cutting: guards, filters, decorators (Shared Components)
  modules/
    identity/             # ✅ fully implemented: register, login, JWT, /me
    marketplace/           # stubbed — same pattern, fill in business logic
    food/                   # stubbed
    laundry/                 # stubbed
    orders/                   # stubbed
    logistics/                 # stubbed
    payments/                   # stubbed
    notifications/                # stubbed
    support/                       # stubbed
    admin/                          # stubbed
prisma/
  schema.prisma           # all domain models in one schema (the ERD, as code)
```

Every stubbed module follows the same shape as `identity`:
`<name>.module.ts`, `<name>.controller.ts`, `<name>.service.ts`. Build them out the
same way — DTOs go in a `dto/` folder, controllers stay thin, business rules live
in the service, and the service talks to the database only through `PrismaService`.

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
5. Push the schema to Supabase and generate the Prisma client:
   ```bash
   npx prisma migrate dev --name init
   ```
   This creates all the tables (`users`, `products`, `orders`, `laundry_orders`,
   `deliveries`, `payments`, etc.) in your Supabase database.
6. Run the server:
   ```bash
   npm run start:dev
   ```
7. Test the auth flow:
   ```bash
   curl -X POST http://localhost:3000/api/v1/auth/register \
     -H "Content-Type: application/json" \
     -d '{"email":"you@example.com","password":"password123","fullName":"Test User"}'
   ```
   You should get back `{ success: true, data: { accessToken, user } }`.
   Use that token as `Authorization: Bearer <token>` to call `GET /api/v1/auth/me`
   or any of the stubbed module endpoints.

## What's real vs. stubbed right now

- **Identity module**: fully working — register, login (bcrypt + JWT), `/me`,
  `JwtAuthGuard` + `RolesGuard` for protecting routes by role.
- **Every other module**: has a working `GET /api/v1/<module>` route behind auth,
  and a service wired to `PrismaService`, but no real business logic yet. This is
  intentional — it's a consistent starting shape so you (or anyone joining) can build
  out marketplace, food, laundry, logistics, payments, etc. following the same pattern
  instead of inventing structure each time.

## Next steps, roughly in the order the doc's workflows suggest

1. Flesh out **Marketplace** (products/categories CRUD) — it's the simplest domain
   and a good way to get comfortable with the Prisma models.
2. Build **Orders** (create order from marketplace or food, calculate total).
3. Build **Payments** (start with a mock/manual "mark as paid" before wiring a real
   mobile money provider).
4. Build **Logistics** (delivery assignment: walking vs. motorcycle based on distance).
5. Build **Laundry** (the pickup → wash → deliver status pipeline from the doc).
6. Wire the **Domain Event Bus**: `@nestjs/event-emitter` is already installed and
   registered in `app.module.ts`. Use `this.eventEmitter.emit('order.created', order)`
   in Orders, and listen for it in Payments/Logistics/Notifications instead of
   calling those services directly — this is the loose coupling the doc describes.

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
