# Merging this update into your backend

This package adds real business logic to Marketplace, Food, Laundry, Orders,
Logistics, Payments, Notifications, Support, and Admin — replacing the stub
`.service.ts` / `.controller.ts` files and adding new `dto/` folders.

## 1. Install one new dependency

```powershell
cd Fastermall-Super-App-Backend
npm install @nestjs/mapped-types
```

(Used by `UpdateProductDto` so you don't have to redeclare every field as optional.)

## 2. Copy files in

Copy every folder inside `src/modules/` from this package into your real
`Fastermall-Super-App-Backend/src/modules/`, **overwriting** the existing stub
files with the same names. New `dto/` folders and new files (like
`update-order-status.dto.ts`) just get added alongside what's there.

Folders to copy over: `marketplace`, `food`, `laundry`, `orders`, `logistics`,
`payments`, `notifications`, `support`, `admin`.

Your `identity` module is untouched — don't copy anything over it.

## 3. Add the Support Ticket model to your Prisma schema

Open your real `prisma/schema.prisma` and paste the contents of
`prisma/schema-additions.prisma` (this package) onto the end of it.

## 4. Push the new table to Supabase

```powershell
npx prisma migrate dev --name add_support_tickets
```

## 5. `app.module.ts` needs no changes

All module names are unchanged, so your existing `app.module.ts` imports
still work as-is — just double check it looks like this (it already does
from the original scaffold):

```typescript
IdentityModule, MarketplaceModule, FoodModule, LaundryModule, OrdersModule,
LogisticsModule, PaymentsModule, NotificationsModule, SupportModule, AdminModule,
```

## 6. Rebuild and test

```powershell
npm run start:dev
```

If it starts clean with all routes mapped in the log (same as your last local
run), you're good. Commit and push, then redeploy on Render (it auto-deploys
on push if you connected the GitHub repo, or trigger a manual deploy).

## What's now real vs. what's still a placeholder

**Fully working:**
- Marketplace: categories + products, admin-only writes, public reads
- Food: vendors + menu items, admin/vendor writes, public reads
- Laundry: create order, list mine, staff-only status pipeline updates
- Orders: creates from marketplace OR food, validates stock/availability,
  calculates total, decrements stock, emits `order.created`
- Payments: auto-creates a PENDING payment when an order/laundry order is
  created (via event), mock `pay()` endpoint to mark it SUCCESSFUL
- Logistics: auto-creates a delivery when payment succeeds (via event),
  partners can see unassigned deliveries, claim one, update its status,
  see their earnings
- Notifications: auto-creates notification rows on order/laundry/payment
  events, customer can list/mark read
- Support: create/list tickets, admin can view all + update status
- Admin: dashboard stats (counts), list all users

**Still needs real logic later:**
- Real mobile money/card payment gateway (currently mocked)
- Real distance-based walking-vs-motorcycle assignment (currently defaults
  to walking — no pickup/dropoff coordinates are captured on orders yet)
- Refunds
- Product/vendor images (needs Supabase Storage wiring)
- Search/filtering beyond the basic `?categoryId=` filter

## One thing you'll hit immediately

Every admin-only and staff-only route (creating products, managing vendors,
updating laundry/order status, claiming deliveries, viewing admin dashboard)
requires a user with a non-CUSTOMER role. Right now, `register` always
creates a `CUSTOMER` — there's no way to become ADMIN/VENDOR/LAUNDRY_STAFF/
DELIVERY_PARTNER through the API yet. That's exactly the "integrate admin
and special users" step you said we'd tackle next.
