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

### 2.6 Remove live maps and location `[ ]`
- [ ] Disable `PATCH /logistics/deliveries/:id/location`, returning 410 Gone with a "feature removed" message.
- [ ] Stop returning `riderLat/riderLng/riderLocationAt` (and pickup/dropoff coordinates) in customer-facing order and delivery responses.
- [ ] Keep the DB columns and the address `lat/lng` (optional input, ignored for display) so the feature can be brought back later without data loss.
- [ ] Check that walking vs motorcycle assignment does not depend on live location, and leave the `distanceKm` logic intact if it doesn't.
- [ ] Update tests and the README.

### 2.13 WhatsApp Contact Us `[ ]`
- [ ] Add a `whatsappContactNumber` platform setting (admin-editable, validated as an international number such as `233XXXXXXXXX`).
- [ ] Make `GET /settings` return `whatsappContactNumber` and a ready-made `whatsappUrl` (`https://wa.me/<number>`), or `null` while it's unset.
- [ ] *Blocked on:* the manager's number. The setting ships empty and the admin fills it in.

### 2.14 FAQ `[ ]`
- [ ] Add a `Faq` model: `question`, `answer`, `category?`, `sortOrder`, `isPublished`, timestamps.
- [ ] Public `GET /faqs`: published entries only, grouped or ordered by category and `sortOrder`.
- [ ] Admin CRUD: `GET/POST /admin/faqs`, `PATCH/DELETE /admin/faqs/:id`. These are recorded by the audit log automatically.
- [ ] Seed a few starter FAQs (`prisma/seed.ts`).

### 2.4 Notification popup fix and Delivery App notification setup `[ ]`
- [ ] Give broadcasts a dedicated `announcements` channel id and always send `sound: 'default'` and `priority: 'high'`. Document the exact channel ids the apps must create (`orders`, `deliveries`, `announcements`) with HIGH importance and sound.
- [ ] Exclude deleted customers (`deletedAt != null`) from broadcasts.
- [ ] Add `POST /notifications/test`, which sends a test push to the caller's own devices and returns the Expo ticket results, so popup and ding problems can be diagnosed on a real phone.
- [ ] Log receipts more clearly (count sent / failed / reason).
- [ ] Delivery App setup: add staff device preferences (`newDeliveries`, `deliveryUpdates`, `announcements`). Add `GET/PATCH /notifications/preferences` for staff, so the Delivery App has a settings section to call. Honour `newDeliveries` in `onDeliveryCreated`.
- [ ] Optional: let the admin broadcast target a single role (already supported) with a chosen channel.

### 2.8 Scheduled delivery windows and rescheduling `[ ]`
- [ ] Add a pure, fully unit-tested helper `src/shared/utils/delivery-windows.ts`:
  - `assignWindow(orderTime)`: before 09:00 → same day 10:00–12:00; 09:00–15:00 → same day 16:00–18:00; after 15:00 → next day 10:00–12:00.
  - `nextWindows(window, 2)`: the next two consecutive windows (10–12 → 16–18 same day → 10–12 next day, and so on).
  - All times in **Africa/Accra (UTC+0, no DST)**, stored as UTC.
- [ ] Add fields to `Order`: `deliveryWindowStart`, `deliveryWindowEnd`, `originalWindowStart`, `rescheduledAt?`, `rescheduleCount`.
- [ ] Set the window automatically in `POST /orders` for **marketplace** orders.
- [ ] Return the window on `GET /orders` and `GET /orders/:id`.
- [ ] `GET /orders/:id/delivery-windows`: return the current window plus the only allowed alternatives (the next two after the **original** window).
- [ ] `PATCH /orders/:id/delivery-window` `{ windowStart }`: the server checks that it's one of the two allowed windows, and arbitrary dates are rejected. Emit an event so the customer and admins are notified.
- [ ] Admin delivery lists show and sort by window (`GET /admin/orders`, `GET /logistics/deliveries/unassigned`).
- [ ] Migration.

### 2.2 Product image upload `[ ]`
- [ ] Add a `StorageService` (shared) using Supabase Storage with the service-role key. Uploads go to a public `product-images` bucket.
- [ ] Admin `POST /marketplace/products/:id/images` (multipart, `file` field), using `@nestjs/platform-express` / multer, which is already installed.
- [ ] Add a `ProductImage` model (`url`, `path`, `sortOrder`) so multiple images are possible. Keep `Product.imageUrl` as the primary image for backward compatibility.
- [ ] Admin `DELETE /marketplace/products/:id/images/:imageId` and `PATCH .../reorder` (or set primary).
- [ ] Product APIs return `imageUrl` plus `images[]`.
- [ ] Reuse the same service for food vendor/menu images and laundry vendor logos later.
- [ ] Migration.

### 2.1 Promotions `[ ]`
- [ ] Add a `Promotion` model: `title`, `subtitle?`, `body?`, `imageUrl?`, `ctaLabel?`, `ctaTarget?` (product, category, vendor or URL), `theme` (JSON for colours or animation preset), `startsAt`, `endsAt`, `isActive`, `priority`, timestamps.
- [ ] Public `GET /promotions/active`: the promotions that are live now, highest priority first. The app shows the popup from this.
- [ ] Admin CRUD: `GET/POST /admin/promotions`, `PATCH/DELETE /admin/promotions/:id`, with image upload through the `StorageService`.
- [ ] Optional: a `promotion.published` broadcast push.
- [ ] Migration.

### 2.12A Customizable food orders `[ ]`
- [ ] Add `MenuItemOptionGroup` (`name`, `minSelect`, `maxSelect`, `isRequired`, `sortOrder`) and `MenuItemOption` (`name`, `price`, `isAvailable`). This covers the Gɔbɛ example (beans GH₵5 / GH₵7, plantain GH₵5 / GH₵6, extras: sausage, egg).
- [ ] Return option groups in menu endpoints (`GET /food/vendors/:id/menu`, `GET /food/menu-items/:id`).
- [ ] `POST /orders`: food items accept `options: [{ optionId, quantity? }]`. The server validates min/max per group and computes `unitPrice = base price + Σ option prices`. The client never sends prices.
- [ ] Add a `selectedOptions` JSON snapshot (name + price at time of order) on `OrderItem`.
- [ ] Admin/Vendor CRUD for option groups and options.
- [ ] Migration.

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
