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
