# Fastermall Backend Work Log

Started: 10 Nov 2026
Source: "Fastermall Super App: Feature Analysis & Proposed Improvements" (8 Nov 2026) and the "Frontend & Backend Work Breakdown".
Scope: **backend only** (this NestJS + Prisma repo). No app or frontend work.

Status key: `[ ]` not started · `[~]` in progress · `[x]` done · `[-]` not doing (pending or out of scope)

---

## 1. What the codebase already has

These existing pieces are relevant to the new requirements:

| Area | Current state | File(s) |
| --- | --- | --- |
| Product images | `Product.imageUrl` exists, but there's no upload path. Supabase env vars are configured and `@supabase/supabase-js` is installed but unused. | `prisma/schema.prisma`, `src/config/configuration.ts` |
| Cash payments | `PaymentMethod.CASH` is accepted by `POST /payments/initialize`. There are also admin `PATCH /payments/:id/cash-collected` and a cash refund branch. `Order.paymentMethod` is a free string, not validated. | `src/modules/payments/*`, `src/modules/orders/dto/create-order.dto.ts` |
| Live maps / location | `PATCH /logistics/deliveries/:id/location` stores `riderLat/riderLng`. Delivery responses return `rider*`, `pickupLat/Lng`, `dropoffLat/Lng`. Addresses accept `lat/lng`. Partners have `currentLat/Lng`. | `src/modules/logistics/*`, `src/shared/utils/delivery-secrets.ts`, `src/modules/addresses/*` |
| Notifications | DB notifications + Expo push with `sound: 'default'` and per-device switches. `POST /admin/notifications/broadcast` sends to an audience. | `src/modules/notifications/*` |
| Settings | Key/value `PlatformSetting` with validation, cache, and public `GET /settings`. | `src/modules/settings/settings.service.ts` |
| Food | `FoodVendor` and `MenuItem` with a flat price. No options or add-ons. | `src/modules/food/*` |
| Laundry | A single company-run catalog (`LaundryCatalogItem`). No vendors, ratings or reviews. | `src/modules/laundry/*` |
| Reviews | A product review pattern exists (one per customer, rating aggregate kept on the row), which can be reused for laundry vendors. | `src/modules/marketplace/reviews.service.ts` |
| Delivery scheduling | None. `LaundryOrder` has `pickupAt/deliverAt`, but marketplace `Order` has no delivery window. | — |
| Promotions / FAQ | None. | — |

### Notification popup/ding investigation (2.4): initial findings

- **Probable cause:** `broadcast()` sends its push **without a `channelId`**. Every other notification uses `orders` or `deliveries`. On Android 8+, sound and heads-up popups are set by the notification channel, not the payload. A push with no channel lands in Expo's default channel, which shows silently in the tray if the app never created it with high importance and sound. This matches "it shows in the list but no popup or ding".
- `broadcast()` to `CUSTOMERS` also includes deleted (anonymised) users. Their devices are already removed, so this is harmless, but it wastes rows.
- Push failures are only logged and receipt errors are only logged 15 minutes later, so there's currently no way to see why a push failed.

---

## 2. What we will build (DEFINED features)

Each feature is planned as its own branch, merged into `main`, following the existing pattern. Each feature gets unit tests (`*.spec.ts`) and a Prisma migration where the schema changes.

### 2.5 Remove cash payments `[x]`
- [x] `POST /payments/initialize`: rejects `CASH` (allows only `MOBILE_MONEY`, `CARD`) with a clear 400, both in the DTO and in the service.
- [x] `POST /orders`: any cash `paymentMethod` (case-insensitive, e.g. "cash on delivery") is refused before anything is saved. `mobile_money` / `card` are stored in canonical form. Other labels pass through, because the field is only a hint and the real method is chosen at `/payments/initialize`.
- [x] `CASH` is kept in the DB enum for historical payments, with no migration.
- [x] `PATCH /payments/:id/cash-collected` and the cash refund branch are kept for legacy PENDING cash payments only, marked deprecated. A legacy cash payment can also be paid online now.
- [x] `GET /settings` returns `acceptedPaymentMethods`.
- [x] Tests updated and added (`payments.service.spec.ts`, `orders.service.spec.ts`, `settings.service.spec.ts`). README and APP_CHANGES updated.

### 2.6 Remove live maps and location `[x]`
- [x] `PATCH /logistics/deliveries/:id/location` now returns 410 Gone ("Location sharing has been removed…"). The service method and DTO were deleted, so nothing writes `rider*` any more.
- [x] No response carries `riderLat/riderLng/riderLocationAt` or `pickup/dropoff Lat/Lng`. This is enforced in one place (`stripDeliverySecrets` + `SAFE_DELIVERY_SELECT` in `src/shared/utils/delivery-secrets.ts`), which covers customer orders, the logistics (partner/admin) routes and the admin views. The customer order list and single order now use the shared helper. Previously they hand-stripped only two of the four code secrets, so `deliveryCodeAttempts`/`LockedUntil` also stop leaking.
- [x] DB columns kept. The saved-address `lat/lng` are still accepted, returned and copied onto the delivery's dropoff (stored, never displayed), so the feature can return without data loss.
- [x] Walking vs motorcycle (`determinePartnerType`) uses `distanceKm` only and doesn't depend on live location. It is left intact, and `distanceKm` is still returned.
- [x] Tests: `rider-location.spec.ts` replaced by `live-location-removed.spec.ts`. APP_CHANGES updated (the old "Share rider location" section is marked removed).

### 2.13 WhatsApp Contact Us `[x]`
- [x] `whatsappContactNumber` platform setting, editable with `PATCH /admin/settings`. Any common format is normalized to `233XXXXXXXXX` (Ghana local `0…` gets 233); it is validated as 10–15 digits with country code, and `""` clears it.
- [x] `GET /settings` returns `whatsappContactNumber` and `whatsappUrl` (`https://wa.me/<number>`), both `null` until set. `GET /app/config` also returns them under `support`.
- [ ] *Still needed:* the manager's real number. An admin enters it once the app is live; nothing in code needs changing.

### 2.14 FAQ `[x]`
- [x] `Faq` model (`question`, `answer`, `category?`, `sortOrder`, `isPublished`, timestamps), migration `20261110150000_add_faqs` (new table only).
- [x] Public `GET /faqs` (optional `?category=`) returns published questions in display order as `items`, plus `categories: [{ name, items }]`. Cached 5 minutes.
- [x] Admin `GET/POST /admin/faqs`, `PATCH/DELETE /admin/faqs/:id`, recorded in the audit log.
- [x] 8 starter FAQs in `prisma/seed.ts`, created only if missing, so admin edits are never overwritten.
- [x] Verified on a throwaway Postgres: migration from current `main` has no drift; seeding twice keeps 8 rows and keeps edits; full HTTP smoke test of every new route.

### 2.4 Notification popup fix and Delivery App notification setup `[x]`
- [x] Root cause on the backend: broadcasts had no Android channel, so they used Expo's fallback channel (no popup). They now use `orders` / `deliveries`, the channels every other push uses. I didn't add a new `announcements` channel: Android drops pushes for a channel id the phone doesn't have.
- [x] Broadcasts skip deleted customers.
- [x] `POST /notifications/test` (own phones) and `POST /admin/notifications/test` (any account): send a test push and return Expo's answer per phone, plus a hint. Push errors are now logged with the masked token and Expo's error code.
- [x] Delivery App settings: master's `GET/PUT /logistics/me/preferences` already stored them. Now `jobUpdates` (accepted delivery cancelled) and `payments` (cash-out paid/failed, admin payout recorded) are acted on, `sound` applies to every partner push, and the in-app list always gets everything.
- [ ] *App side (not backend):* create the `orders` and `deliveries` channels with MAX importance and sound, and set `Notifications.setNotificationHandler` so banners and sound show while the app is open. This is the most likely cause of "in the list but no popup". The exact code is in APP_CHANGES.md.

### 2.8 Scheduled delivery windows and rescheduling `[x]`
- [x] Helper `src/shared/utils/delivery-windows.ts` with the cut-offs (before 09:00 gives same-day morning; 09:00 to 14:59 gives same-day afternoon; 15:00 or later gives next morning), next windows, labels in Ghana time, and 14 unit tests including the requirement's 8/9 Nov example.
- [x] `Order` fields `deliveryWindowStart/End`, `originalWindowStart`, `rescheduledAt`, `rescheduleCount`. Migration `20261110180000_add_delivery_windows` has nullable columns only.
- [x] Marketplace orders get their window when they are created. Order responses include `deliveryWindow` with a label.
- [x] `GET /orders/:id/delivery-windows` returns the original plus the next two, with availability and the reason when rescheduling is blocked.
- [x] `PATCH /orders/:id/delivery-window` refuses any other date. It is allowed until the current window starts, while the order is pending, confirmed or preparing, and before pickup. The write is atomic (409 `ORDER_CHANGED` on a race). The customer is notified, and so is the admin who accepted the delivery.
- [x] `GET /admin/orders?deliveryDate=YYYY-MM-DD` returns a day's deliveries sorted by window.
- [x] Verified on a throwaway Postgres: no drift. End-to-end run: an order placed at 20:37 got the next morning, the reschedule worked, an arbitrary date was refused, and the notification arrived.
- [ ] *Open (2.8 pending decision):* windows run every day including weekends, there is no capacity limit per window, and food orders don't get windows. Change these if operations want otherwise.

### 2.2 Product image upload `[x]`
- [x] Extended master's `StorageService` with public-bucket upload and delete. The `product-images` bucket is created automatically, public, with long cache headers.
- [x] `ProductImage` model (url, path, type, size, sortOrder), migration `20261110210000_add_product_images` (new table only). `Product.imageUrl` is kept in sync as the first photo.
- [x] Admin: upload (`multipart`, field `images`), reorder, delete. Type is checked from the bytes (JPEG/PNG/WebP). Up to 5 MB each and 5 per product (env-configurable). All-or-nothing: earlier files are cleaned up if a later upload fails. Deleting a product removes its files.
- [x] Product responses include `images`, plus a public `GET /marketplace/products/:id/images`.
- [x] Verified: unit tests; migration on a throwaway Postgres with no drift; HTTP checks of every refusal (401, 400 type, 413 size, 400 no file, 404) and of a valid image reaching storage. **Not verified:** a real upload to Supabase, because I didn't touch the production project. Try one upload after deploy.
- [ ] Not done (pending decisions): cropping/resizing (the admin uploads ready-made images), and food vendor/menu images (the same service can be reused).

### 2.13 WhatsApp Contact Us `[x]`
- [x] `whatsappContactNumber` platform setting, editable with `PATCH /admin/settings`. Any common format is normalized to `233XXXXXXXXX` (Ghana local `0…` gets 233); it is validated as 10–15 digits with country code, and `""` clears it.
- [x] `GET /settings` returns `whatsappContactNumber` and `whatsappUrl` (`https://wa.me/<number>`), both `null` until set. `GET /app/config` also returns them under `support`.
- [ ] *Still needed:* the manager's real number. An admin enters it once the app is live; nothing in code needs changing.

### 2.14 FAQ `[x]`
- [x] `Faq` model (`question`, `answer`, `category?`, `sortOrder`, `isPublished`, timestamps), migration `20261110150000_add_faqs` (new table only).
- [x] Public `GET /faqs` (optional `?category=`) returns published questions in display order as `items`, plus `categories: [{ name, items }]`. Cached 5 minutes.
- [x] Admin `GET/POST /admin/faqs`, `PATCH/DELETE /admin/faqs/:id`, recorded in the audit log.
- [x] 8 starter FAQs in `prisma/seed.ts`, created only if missing, so admin edits are never overwritten.
- [x] Verified on a throwaway Postgres: migration from current `main` has no drift; seeding twice keeps 8 rows and keeps edits; full HTTP smoke test of every new route.

### 2.4 Notification popup fix and Delivery App notification setup `[x]`
- [x] Root cause on the backend: broadcasts had no Android channel, so they used Expo's fallback channel (no popup). They now use `orders` / `deliveries`, the channels every other push uses. I didn't add a new `announcements` channel: Android drops pushes for a channel id the phone doesn't have.
- [x] Broadcasts skip deleted customers.
- [x] `POST /notifications/test` (own phones) and `POST /admin/notifications/test` (any account): send a test push and return Expo's answer per phone, plus a hint. Push errors are now logged with the masked token and Expo's error code.
- [x] Delivery App settings: master's `GET/PUT /logistics/me/preferences` already stored them. Now `jobUpdates` (accepted delivery cancelled) and `payments` (cash-out paid/failed, admin payout recorded) are acted on, `sound` applies to every partner push, and the in-app list always gets everything.
- [ ] *App side (not backend):* create the `orders` and `deliveries` channels with MAX importance and sound, and set `Notifications.setNotificationHandler` so banners and sound show while the app is open. This is the most likely cause of "in the list but no popup". The exact code is in APP_CHANGES.md.

### 2.8 Scheduled delivery windows and rescheduling `[x]`
- [x] Helper `src/shared/utils/delivery-windows.ts` with the cut-offs (before 09:00 gives same-day morning; 09:00 to 14:59 gives same-day afternoon; 15:00 or later gives next morning), next windows, labels in Ghana time, and 14 unit tests including the requirement's 8/9 Nov example.
- [x] `Order` fields `deliveryWindowStart/End`, `originalWindowStart`, `rescheduledAt`, `rescheduleCount`. Migration `20261110180000_add_delivery_windows` has nullable columns only.
- [x] Marketplace orders get their window when they are created. Order responses include `deliveryWindow` with a label.
- [x] `GET /orders/:id/delivery-windows` returns the original plus the next two, with availability and the reason when rescheduling is blocked.
- [x] `PATCH /orders/:id/delivery-window` refuses any other date. It is allowed until the current window starts, while the order is pending, confirmed or preparing, and before pickup. The write is atomic (409 `ORDER_CHANGED` on a race). The customer is notified, and so is the admin who accepted the delivery.
- [x] `GET /admin/orders?deliveryDate=YYYY-MM-DD` returns a day's deliveries sorted by window.
- [x] Verified on a throwaway Postgres: no drift. End-to-end run: an order placed at 20:37 got the next morning, the reschedule worked, an arbitrary date was refused, and the notification arrived.
- [ ] *Open (2.8 pending decision):* windows run every day including weekends, there is no capacity limit per window, and food orders don't get windows. Change these if operations want otherwise.

### 2.2 Product image upload `[x]`
- [ ] Add a `StorageService` (shared) using Supabase Storage with the service-role key. Uploads go to a public `product-images` bucket.
- [ ] Admin `POST /marketplace/products/:id/images` (multipart, `file` field), using `@nestjs/platform-express` / multer, which is already installed.
- [ ] Add a `ProductImage` model (`url`, `path`, `sortOrder`) so multiple images are possible. Keep `Product.imageUrl` as the primary image for backward compatibility.
- [ ] Admin `DELETE /marketplace/products/:id/images/:imageId` and `PATCH .../reorder` (or set primary).
- [ ] Product APIs return `imageUrl` plus `images[]`.
- [ ] Reuse the same service for food vendor/menu images and laundry vendor logos later.
- [ ] Migration.

### 2.1 Promotions `[x]`
- [x] `Promotion` model with content, button (`ctaType` PRODUCT/CATEGORY/VENDOR/FOOD_VENDOR/URL/NONE), `theme` (colours and animation preset, including `float3d`), schedule, priority, popup `frequency` and `announcedAt`. Migration `20261110230000_add_promotions`.
- [x] Public `GET /promotions/active`: live ones only, by priority, at most 10, without admin fields.
- [x] Admin CRUD with a status filter. The button target is validated (it must exist, and URLs must be https). Image upload goes to the public `promotion-images` bucket. Audited.
- [x] `POST /admin/promotions/:id/announce` pushes to customers (`type: PROMOTION`), live promotions only, once per 12 h, safe against double clicks and retriable if the push fails.
- [x] Verified: unit tests; migration with no drift; HTTP run of create, schedule, bad button, public list, announce (twice), the customer notification and deactivation.
- [ ] Decided by default (requirement left it open): admins manage promotions. The 3D look and animation themselves are drawn by the app; the backend only stores the preset.

### 2.12A Customizable food orders `[x]`
- [x] `MenuItemOptionGroup` (min/max picks) and `MenuItemOption` (price, maxQuantity, isAvailable). `OrderItem.selectedOptions` snapshot. Migration `20261111000000_add_menu_item_options`.
- [x] Menu endpoints return `optionGroups`. Admin or owning-vendor CRUD for groups and options, with an ownership check.
- [x] `POST /orders`: food lines take `options`. Pricing is done on the server (pesewa math) in `src/modules/food/menu-options.ts`, with every rule and the Gɔbɛ example unit-tested. Different choices stay separate lines.
- [x] 646 tests pass; build clean.
- [ ] **Not yet verified on a real database:** the throwaway Postgres was stopped by Claude Code because the computer ran low on memory, so the migration and the HTTP run weren't done. Run them before relying on it.
- [ ] Pending decisions: which items get options (vendors decide per item); whether vendors other than admins should manage them is covered by the VENDOR role.

### 2.12B Product pre-orders (variants and custom requests) `[ ]`
- [ ] Add a `ProductVariant` model (`name` such as a design or size, `priceDelta`, `stock`, `imageUrl?`), with an optional `variantId` on marketplace order items.
- [ ] Add a `Product.allowsPreOrder` flag.
- [ ] Add a `PreOrderRequest` model: `customerId`, `productId?`, `variantId?`, `description`, `specifications` (JSON), `referenceImageUrls[]`, `status` (SUBMITTED → QUOTED → ACCEPTED → FULFILLED / CANCELLED), `quotedPrice?`, `estimatedDate?`.
- [ ] Customer endpoints: `POST /preorders`, `GET /preorders`, `GET /preorders/:id`, plus a reference image upload.
- [ ] Admin endpoints: list, quote, and change status. The customer is notified.
- [ ] *Fulfilment and payment rules are pending.* We build the request and quote flow only, and turning an accepted quote into a paid order waits for that decision.
- [ ] Migration.

### 2.15 Laundry multivendor `[ ]`
- [ ] Add a `LaundryVendor` model: `name`, `description`, `logoUrl`, `location`, `phone`, `status` (PENDING / APPROVED / SUSPENDED), `rating`, `reviewCount`, `isOpen`.
- [ ] Link `LaundryCatalogItem` to `vendorId`. The migration creates a "Fastermall Laundry" vendor and moves the existing catalog onto it, so nothing breaks.
- [ ] Link `LaundryOrder` to `vendorId`. An order may only contain one vendor's items.
- [ ] Link `StaffUser` (LAUNDRY_STAFF) to a vendor, so staff only see and update their vendor's orders.
- [ ] Public `GET /laundry/vendors` (approved only, sort by rating), `GET /laundry/vendors/:id` and `GET /laundry/vendors/:id/catalog`. Keep `GET /laundry/catalog` working for older apps.
- [ ] Add `LaundryVendorReview` (one per customer per vendor, only after a COMPLETED order with that vendor), reusing the product review approach with a rating aggregate on the vendor.
- [ ] Admin endpoints: create, approve or suspend a vendor, manage its catalog, and moderate (delete) reviews.
- [ ] Delivery stays Fastermall-run (the existing logistics flow).
- [ ] *Commission and payouts to vendors are pending.* We'll store `commissionRate` (nullable), but there's no settlement logic yet.
- [ ] Migration.

---

## 3. Not doing now (PENDING in the requirements doc)

| # | Feature | Reason |
| --- | --- | --- |
| 2.3 | Vendor integration | Scope not discussed |
| 2.9 | Wallet system | Not defined |
| 2.10 | Loyalty points | Not defined |
| 2.11 | Email / SMS / in-app notification system | Not defined (in-app push fix is covered in 2.4) |
| 2.16 | Nsano payment gateway | Research only, integration not approved. The existing `PaymentProvider` interface (`src/modules/payments/providers/`) means it could be added later without changing the payments flow |
| 2.17 | Separate delivery price | Not clarified |
| — | Reply screen to notifications | Discarded (duplicate) |

---

## 4. Assumptions to confirm (defaults used unless told otherwise)

1. **Promotions** are created and managed by admins through the admin API.
2. **Product images:** up to 5 per product; JPEG/PNG/WebP; max 5 MB each; stored in Supabase Storage; no cropping on the server.
3. **Delivery window boundaries:** an order at exactly 09:00 gets the afternoon window, and one at exactly 15:00 or later goes to the next morning. Windows run every day, including weekends.
4. **Rescheduling** is allowed until the current window starts and is limited to the two windows after the *original* one. It can be changed again within those two.
5. **Delivery windows** apply to **marketplace** orders only. Food stays as-is.
6. **Custom food options** are managed by admins and vendors on each menu item.
7. **WhatsApp number** is stored as a platform setting and filled in by the admin.
8. **Legacy cash payments** still pending can still be marked collected or refunded by admins.

---

## 5. Order of work

1. Remove cash payments (2.5)
2. Remove live maps and location (2.6)
3. WhatsApp contact (2.13) and FAQ (2.14)
4. Notification fix and Delivery App notification settings (2.4)
5. Delivery windows and rescheduling (2.8)
6. Storage service and product images (2.2)
7. Promotions (2.1)
8. Custom food options (2.12A)
9. Pre-orders (2.12B)
10. Laundry multivendor (2.15)

After each step: `npm test`, `npm run build`, then update this log, `README.md` and `APP_CHANGES.md` (the notes for the app teams).

---

## 6. Progress log

| Date | Item | Notes |
| --- | --- | --- |
| 10 Nov 2026 | Analysis | Read the requirements and the codebase; created this log. |
| 10 Nov 2026 | 2.5 Remove cash payments | Done on branch `remove-cash-payments`. 261/261 tests pass, build clean. The Prisma client was stale locally; ran `npx prisma generate` before testing. |
| 10 Nov 2026 | 2.6 Remove live maps and location | Done on branch `remove-live-maps` (pulled `main` first, up to date). 266/266 tests pass, build clean. No migration. |
| 10 Nov 2026 | Merge `origin/master` into `main` | Partner-app branch (88 commits) merged on `merge-master`; 19 conflicts resolved, duplicates unified (support replies, partner payouts, staff deactivation). Live location from that branch disabled to match 2.6. Lost code restored (customer lockout, vendor-owner schema, security headers); missing account-deletion feature removed from routes. Migrations verified on a throwaway Postgres for fresh, main-history and master-history databases (no drift). Tests and build pass. `backup-connecting-to-frontend` left unmerged (superseded first-version backup). |
| 10 Nov 2026 | 2.13 WhatsApp contact + 2.14 FAQ | Built directly on `main` (no branches from now on, per user). Unit tests added; migration, seed and routes verified against a throwaway Postgres. |
| 10 Nov 2026 | 2.4 Notifications | Broadcast channel fix, test-push diagnostics, partner jobUpdates/payments/sound switches live. 548 tests pass; app booted against a throwaway DB and the new routes answered. No migration. |
| 10 Nov 2026 | 2.8 Delivery windows | Built on `main`. 583 tests pass; migration and full reschedule flow verified against a throwaway Postgres. |
| 10 Nov 2026 | 2.2 Product images | Built on `main`. 601 tests pass; upload route checked over HTTP without touching the real Supabase project. |
| 10 Nov 2026 | 2.1 Promotions | Built on `main`. Tests pass; routes verified over HTTP on a throwaway Postgres. |
| 11 Nov 2026 | 2.12A Custom food orders | Built on `main`. 646 tests pass. Migration/HTTP check on the throwaway DB not done: it was stopped for low memory. |
