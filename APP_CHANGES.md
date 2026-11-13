# Fastermall app changes after the 2 Nov backend update

2 Nov 2026

## Summary

The backend now supports almost everything both app review docs asked for. Ship the app changes below only after the backend release is live: most of them send fields or call routes the current production API rejects.

Release order:

1. Backend runs `npx prisma migrate deploy`. Three new migrations apply in order: `20261102120000_add_delivery_claimed_by_staff`, `20261102130000_customer_app_backend_fields`, `20261102140000_add_product_reviews_and_addresses`.
2. Backend deploys the API.
3. Backend team confirms on staging, then tells both app teams it is live.
4. App teams release the changes in this doc.

Why the order matters: the API rejects any request field it does not know (`forbidNonWhitelisted`). Sending a new field such as `preferences`, `addressId` or `sort` to the old API fails the whole request with a 400. Calling a new route on the old API returns 404.

Every response is still wrapped as `{ success: true, data: ... }`, and errors still look like `{ success: false, statusCode, error }`. Paths below omit the `/api/v1` prefix.

## Customer app

Twelve changes, numbered as in the "Backend changes needed by the app" doc. Three need no app work: 2, 9 and 12.

| # | Change | File | App work |
| --- | --- | --- | --- |
| 1 | Laundry pickup address | `src/services/orders.ts` | Send `addressLabel` |
| 2 | Delete account | `src/services/auth.ts` | None |
| 3 | Edit profile | `src/services/user.ts` | Call `PATCH /auth/me` |
| 4 | Product vendor, rating, review count | `src/services/marketplace.ts` | None for reading; new review screens |
| 5 | Server-side sort and filters | `src/services/marketplace.ts` | Pass params, use server pages |
| 6 | Live rider position | `app/(main)/(food)/live-tracking/[orderId].tsx` | Read `delivery.rider*` |
| 7 | Push category switches | `src/services/push.ts` | Send `preferences` again |
| 8 | Mark all read | `src/services/notifications.ts` | One request |
| 9 | Notification paging | — | None |
| 10 | Structured reports | `src/services/reports.ts` | Send three new fields |
| 11 | Saved addresses | `useUserStore` | Use `/me/addresses`, send `addressId` |
| 12 | Idempotency-Key | — | None |

### 1. Laundry pickup address

In the laundry branch of `placeOrder`, add `addressLabel: input.addressLabel` to the `POST /laundry/orders` body. Maximum 300 characters. If the customer picked a saved address, send `addressId` instead (see 11).

### 2. Delete account

No change. `DELETE /auth/me` now exists and returns `{ ok: true }`. Calling it twice is safe.

- The account is anonymised, not removed: orders stay for accounting. Saved addresses, devices and notifications are deleted. Product reviews stay, shown as "Deleted user".
- Afterwards `GET /auth/me` returns 401, so the existing session-end handling signs the user out.
- The "email us to delete" fallback can be removed.

### 3. Edit profile

Replace the body of `updateProfile()` with `api.patch('/auth/me', { fullName: patch.name, phone: patch.phone })`. Send only the fields that changed; omitted fields are left alone.

- `fullName`: 2 to 100 characters, trimmed by the server.
- `phone`: a local 10-digit number starting with 0, e.g. `0241234567`. Convert `+233…` before sending.
- The response has the same shape as `GET /auth/me`. Map `fullName` to `name`.
- 409 "That number is already in use" when another account has the phone. 400 for a bad format.

### 4. Product vendor and ratings

`GET /marketplace/products` and `GET /marketplace/products/:id` now return, on every product:

- `vendor`: `{ id, name }`, or `null` for a product with no vendor.
- `rating`: the average to one decimal, or `null` until the first review.
- `reviewCount`: an integer, 0 with no reviews.

`toProduct()` already reads these. Keep the bundled fallback only for `imageUrl` (still `null` until photos are uploaded) and for `rating` while it is `null`.

New review routes, for a product detail screen:

| Route | Who | Body / query | Returns |
| --- | --- | --- | --- |
| `GET /marketplace/products/:id/reviews` | Anyone | `?page&pageSize` (max 50) | `{ data, page, pageSize, hasMore, total }` |
| `GET /marketplace/products/:id/reviews/me` | Customer | — | The customer's review, or `null` |
| `POST /marketplace/products/:id/reviews` | Customer | `{ rating: 1–5, comment? }` | `{ review, product: { id, rating, reviewCount } }` |
| `DELETE /marketplace/products/:id/reviews/me` | Customer | — | `{ deleted: true, product }` |

- A review is `{ id, productId, rating, comment, author, createdAt, updatedAt }`. `author` is the first name only.
- One review per customer per product. Posting again replaces it; a missing `comment` clears the old one.
- `rating` must be a whole number. `comment` is up to 1000 characters.
- 403 "You can review a product once an order with it has been delivered" until the customer has a delivered Marketplace order containing that product. Show the Rate button only for delivered orders.
- Limited to 10 posts a minute per device.
- After a post or delete, update the product card from the returned `product`.

### 5. Server-side sort and filters

Change `getProducts()` to pass these query params and use the server's pages instead of `queryProducts()`:

| App choice | Query param |
| --- | --- |
| Default / relevance | `sort=relevance` (or omit), newest first |
| Popular | `sort=popular`, most often ordered |
| Top rated | `sort=rating`, unrated products last |
| Price low to high | `sort=price_asc` |
| Price high to low | `sort=price_desc` |
| Price range | `minPrice`, `maxPrice` (GH₵, 0 or more) |
| Minimum rating | `minRating` (1 to 5, decimals allowed) |
| In stock only | `inStock=true` |

- Existing params stay: `query`, `categoryId`, `page`, `pageSize`. `pageSize` is capped at 100.
- The response is unchanged: `{ data, page, pageSize, hasMore, total }`. Load the next page while `hasMore` is true.
- `minRating` leaves out products that have no reviews yet.
- 400 for any unknown param, an unknown `sort`, `minPrice` above `maxPrice`, or a non-numeric value. Don't add cache-busting params such as `_=`.

### 6. Live rider position

`GET /orders/:id` (and `GET /orders`) now include, on `delivery`:

- `riderLat`, `riderLng`: numbers, or `null` until the rider starts sharing.
- `riderLocationAt`: when it was last reported, or `null`.

In `mapFoodOrder`, read these and pass them to `TrackingMap` instead of the `RIDER` constant. When they are `null`, hide the rider marker rather than showing a made-up position. The rider sends about one update every 10 seconds, so the existing 10-second refetch is enough. Consider marking the position as old when `riderLocationAt` is more than 2 minutes ago.

`delivery.dropoffLat` / `dropoffLng` are also filled when the order used a saved address with coordinates.

### 7. Push category switches

In `registerDeviceWithBackend()`, send `preferences` again: `{ token, platform, preferences: { orderUpdates, announcements } }`. Both are booleans and either can be left out to keep the stored value. The same body works on `PATCH /notifications/devices`.

- The response now includes `preferences: { orderUpdates, announcements }`.
- "Order updates" turns off both order-status and delivery-progress pushes.
- "Offers & announcements" is stored, but the backend sends no offer pushes yet.
- The in-app list still receives every notification; the switches only stop lock-screen pushes.
- **Do not release this before the backend is live.** The old API rejects `preferences` and every registration would fail again.

### 8. Mark all read

In `markAllNotificationsRead()`, replace the `Promise.all` with one `api.patch('/notifications/read-all')`. It returns `{ count }`, the number marked.

### 9. Notification paging

No change. `GET /notifications` now returns the latest 50, newest first. An unread badge counted from this list tops out at 50.

### 10. Structured reports

In `submitReport()`, add the optional fields to the `POST /support/tickets` body. `subject` (3+ characters) and `message` (5+ characters) are still required.

- `targetType`: what is reported, e.g. `ORDER`, `LISTING`, `VENDOR`. Up to 50 characters.
- `targetId`: its id. Up to 100 characters.
- `reason`: the reason code picked in the app. Up to 100 characters.

### 11. Saved addresses

Back `useUserStore` addresses with these routes. Customers only.

| Route | Body | Returns |
| --- | --- | --- |
| `GET /me/addresses` | — | Array, default first then oldest first |
| `POST /me/addresses` | `{ label, hostel, room, landmark?, lat?, lng?, isDefault? }` | The new address |
| `PATCH /me/addresses/:id` | Any of the same fields | The updated address |
| `DELETE /me/addresses/:id` | — | `{ deleted: true }` |

An address is `{ id, userId, label, hostel, room, landmark, lat, lng, isDefault, createdAt, updatedAt }`.

- Limits: `label` 50, `hostel` 100, `room` 30, `landmark` 150 characters. `lat` and `lng` must be sent together.
- Up to 20 addresses; the 21st returns 400.
- The first address becomes the default automatically. Setting `isDefault: true` moves the default. Deleting the default passes it to the oldest remaining address. Refresh the list after any change, because one write can change two addresses.
- Another customer's address id returns 404.
- When placing an order, send `addressId` on `POST /orders` or `POST /laundry/orders`. The server copies the address onto the order as text, e.g. "Unity Hall, Room 12, near the main gate", and ignores `addressLabel`. A bad `addressId` returns 404 and no order is created.
- Keep sending `addressLabel` when there is no saved address.
- On the first launch after this update, upload the addresses saved on the phone, then read them from the server.

### 12. Idempotency-Key

No change. The `Idempotency-Key` header on `POST /orders` and `POST /laundry/orders` is now honoured. A retry with the same key returns the first order instead of creating another.

- Use a new key for each new order, and the same key for its retries. Up to 255 characters.
- Keys are per customer, so a UUID per order is enough.
- A replayed `POST /orders` returns the order as `GET /orders/:id` does, including `delivery.code`.

## Partner app

Four fixes from the partner backend review (R1, R6, R7 and item 4) are live, plus rider location. Admins now run Marketplace and Laundry deliveries through the same routes.

| Change | File | App work |
| --- | --- | --- |
| Report a failed delivery (R1) | `src/stores/jobsStore.ts` | None; the button works again |
| "Already taken" is now 409 (item 4) | Jobs list / accept | Handle 409 |
| 3-order limit enforced (R6) | `src/utils/jobFilters.ts` | Count admin-assigned jobs too |
| Start an admin-assigned job (R7) | Job detail | Send `EN_ROUTE_TO_PICKUP` |
| Share rider location | New | Location permission + updates |

### Report a failed delivery (R1)

"Can't complete this delivery?" works again. `PATCH /logistics/deliveries/:id/status` accepts `{ "status": "FAILED" }` from `EN_ROUTE_TO_PICKUP`, `PICKED_UP` and `EN_ROUTE_TO_CUSTOMER`.

- From `ASSIGNED`, `DELIVERED` or `FAILED` it is still a 400.
- The order's own status is left for an admin to resolve, and the customer is not notified.
- **Keep sending `status` only.** Storing the failure reason (R1b) is not built, so a `reason` field still fails with 400.

### "Already taken" is now 409 (item 4)

`POST /logistics/deliveries/:id/claim` returns **409 Conflict** when the job was taken by someone else, including when two partners tap at the same moment. Messages: "This delivery has already been claimed" or "This delivery is no longer available".

On 409, remove the job from the list and show the message. Don't retry.

### 3-order limit enforced (R6)

The server now refuses a 4th active food delivery with **400** "You can carry up to 3 food orders at once. Finish one before accepting another." Show the message as is.

- Active means `ASSIGNED` (with this partner), `EN_ROUTE_TO_PICKUP`, `PICKED_UP` or `EN_ROUTE_TO_CUSTOMER`. `DELIVERED` and `FAILED` free a slot straight away.
- The server also counts jobs an admin assigned (`ASSIGNED` with `partnerId` set). Update the count in `src/utils/jobFilters.ts` to match, or the app can show Accept when the server will refuse it.
- The server limit can be changed with the env var `MAX_ACTIVE_FOOD_DELIVERIES` (default 3). Keep `MAX_ACTIVE_FOOD_JOBS` equal to it.

### Start an admin-assigned job (R7)

A job that is `ASSIGNED` and already has this partner can now be started: send `{ "status": "EN_ROUTE_TO_PICKUP" }` to the status route. Replace the "contact Support" message for these jobs with the normal Start button. After that the usual steps apply.

### Share rider location

> **Removed (Nov 2026)**: see "Live maps and location removed" at the end of this file. The route now returns 410.

The customer's tracking map shows the rider's last reported position.

- Send `PATCH /logistics/deliveries/:id/location` with `{ lat, lng }` about every 10 seconds while the job is `EN_ROUTE_TO_PICKUP`, `PICKED_UP` or `EN_ROUTE_TO_CUSTOMER`.
- With several active jobs, send it for each. Don't go faster than every 10 seconds: the route allows 20 calls a minute, and over that returns 429.
- Returns `{ riderLat, riderLng, riderLocationAt }`.
- 400 "Location can only be shared while the delivery is in progress" once the job is finished: stop sending for that job.
- 400 for another partner's job, 404 for an unknown id.
- The app needs a location permission and a short privacy explanation before this ships.

### Admin-run Marketplace and Laundry deliveries

For whoever builds the admin screens. Partners are unaffected and still get 403 on these deliveries.

1. `GET /logistics/deliveries/unassigned` shows admins every delivery nobody has accepted.
2. `POST /logistics/deliveries/:id/claim` by an admin accepts a Marketplace or Laundry delivery. It records the admin in `claimedByStaffId` (`partnerId` stays `null`) and moves it to `EN_ROUTE_TO_PICKUP`. No 3-order limit. If another admin accepted it first, 409.
3. `PATCH …/status` moves it to `PICKED_UP`, `EN_ROUTE_TO_CUSTOMER`, then `DELIVERED`. **No handover code**: `DELIVERED` is sent directly. `FAILED` works from any in-progress stage.
4. Only the admin who accepted it can move it; another admin gets 400.
5. `GET /logistics/me/deliveries` for an admin returns the deliveries they accepted.

A Marketplace order's status follows along, ending at `DELIVERED`. A Laundry order's own status is still set by laundry staff. Admins earn nothing for these deliveries.

### New fields on delivery objects

Delivery responses now also carry `claimedByStaffId`. (`riderLat`, `riderLng` and `riderLocationAt` were removed again in Nov 2026.) Existing fields, including `order.type`, are unchanged.

## New errors to handle

These responses are new or changed in this release. The message is in the `error` field; there are no stable error codes yet, so match on status and route.

| App | Route | Status | Message | What the app should do |
| --- | --- | --- | --- | --- |
| Partner | `POST /logistics/deliveries/:id/claim` | 409 (was 400) | "This delivery has already been claimed" / "…no longer available" | Drop the job from the list, show the message |
| Partner | `POST /logistics/deliveries/:id/claim` | 400 | "You can carry up to 3 food orders at once…" | Show the message |
| Partner | `PATCH /logistics/deliveries/:id/location` | 400 | "Location can only be shared while the delivery is in progress" | Stop sending for that job |
| Partner | `PATCH /logistics/deliveries/:id/location` | 429 | Too many requests | Slow to one call per 10 s |
| Customer | `PATCH /auth/me` | 409 | "That number is already in use" | Show under the phone field |
| Customer | `GET /auth/me` | 401 | — | Already ends the session; now also after account deletion |
| Customer | `/auth/me`, `/me/addresses`, review writes | 403 | "Only customer accounts can use this route" | Only reached with a staff token |
| Customer | `POST /marketplace/products/:id/reviews` | 403 | "You can review a product once an order with it has been delivered" | Hide Rate until delivered |
| Customer | `GET /marketplace/products` | 400 | Validation message | Only send the params listed in 5 |
| Customer | `POST /me/addresses` | 400 | "You can save up to 20 addresses…" / "Send both lat and lng, or neither" | Show the message |
| Customer | `POST /orders`, `POST /laundry/orders` | 404 | "Address not found" | Refresh saved addresses, ask again |
| Customer | `POST /orders`, `POST /laundry/orders` | 400 | "Idempotency-Key must be at most 255 characters" | Use a UUID |

## Not built yet: keep the workarounds

These requests are still open on the backend. Keep the app's current behaviour (local data, "not available yet" labels) for each.

| App | Item | What the app keeps doing |
| --- | --- | --- |
| Customer | Product photos | Bundled `imageUrl` fallback. This is data entry through admin `PATCH /marketplace/products/:id`, not code |
| Customer | Offers push channel | The announcements switch is stored but has nothing to filter |
| Partner | R1b failure reason | Send `FAILED` without `reason` |
| Partner | R3 pay per delivery | Pay is still a flat GH₵ 15, not `order.deliveryFee`; decision pending |
| Partner | R4 `vendorPayoutAmount`, reimbursements, customer ratings | Local values |
| Partner | R5 / 11 support tickets for staff | Mocked support chat |
| Partner | 1 account deletion and data export | Email support |
| Partner | 2–3 logout, refresh tokens, password reset and change | Delete the token locally on logout |
| Partner | 5 Idempotency-Key on claim, status, cash-out | No automatic retries |
| Partner | 6 `PAY_VENDOR` status, `?status=` filter, pagination | Stages kept on the phone |
| Partner | 7–8 payout destination, wallet ledger, cash-out | Local mock data |
| Partner | 9 mark unread, delete, notification preferences | Phone-only unread state |
| Partner | 10 document upload | Local mock data |
| Partner | 13–14 error codes, `X-Request-Id`, `GET /app/config` | Hard-coded config |
| Partner | 16 / 21 saved online state, `lastSeenAt`, auto-offline | Current toggle |
| Partner | 18 preferences on the account | Phone-only, marked "not active yet" |
| Partner | 19 partner location for matching | Per-job location only (see Partner app) |
| Partner | 20 profile edits | Phone-only |

Two partner items already work and can be used now:

- **Mark all read:** `PATCH /notifications/read-all` also works with a staff token. It can replace the one-request-per-notification loop.
- **Stage history:** each delivery from `GET /logistics/me/deliveries` and from the status route carries `statusEvents: [{ status, createdAt }]`, oldest first. The timeline can show when each step happened.

---

# November 2026 backend changes

Tracked in `BACKEND_WORK_LOG.md`. Each part lists what the apps must change.

## Cash payments removed (2.5)

Customer app:

- Remove the cash option from checkout. Offer the methods in `GET /settings` → `acceptedPaymentMethods` (currently `["MOBILE_MONEY", "CARD"]`).
- `POST /payments/initialize` with `method: "CASH"` now returns 400: "Cash payment is no longer available. Please pay with mobile money or card."
- `POST /orders` with any cash `paymentMethod` (`"CASH"`, `"cash on delivery"`, …) returns the same 400 and no order is created. `"mobile_money"` / `"card"` are stored as `MOBILE_MONEY` / `CARD`.
- Orders placed with cash before the change can be paid online: call `POST /payments/initialize` with `MOBILE_MONEY` or `CARD` as usual.

Admin console:

- `PATCH /payments/:id/cash-collected` still works, for cash payments chosen before the change only. Hide the button for anything else.
- Refunding an old cash payment still marks it refunded without Paystack.

Ship order: the backend can go out first. Older app versions that still offer cash get the 400 above when a customer picks it.

## Live maps and location removed (2.6)

Live maps and rider tracking are out of this release. They may come back later; the data columns are kept for that.

Customer app:

- Remove the live-tracking map screen and any map on order or delivery screens. Show the delivery **status** and its timeline instead (`statusEvents` on delivery objects, plus push notifications).
- Delivery objects (on `GET /orders`, `GET /orders/:id` and the order returned by `POST /orders`) no longer have `riderLat`, `riderLng`, `riderLocationAt`, `pickupLat`, `pickupLng`, `dropoffLat` or `dropoffLng`. Nothing else changed: `status`, `code`, `deliveryCodeUsed`, `distanceKm` and the rest are as before.
- Saved addresses still accept and return optional `lat` / `lng`. No map is needed to use them, and they can be left out.

Partner app:

- Stop sending `PATCH /logistics/deliveries/:id/location` and remove the location permission prompt. The route now returns **410**: "Location sharing has been removed. Update the app to the latest version." Older versions that still call it should stop retrying on 410.
- Delivery objects from `/logistics/...` routes no longer carry any coordinates or rider position.

Admin console:

- `GET /admin/orders/:id`, `/admin/deliveries` and the other admin views no longer include delivery coordinates.

Ship order: the backend can go out first. Older apps that read the removed fields just see them missing, which the tracking screen already handled as "no position yet".


## Partner-app branch merged into main (Nov 2026)

The `master` branch (partner-app work: wallet and cash-out, documents, staff sessions, lockout, idempotency, app config) is now part of `main`. Full partner-app details are in `PARTNER_APP_INTEGRATION.md`. What changes for apps built against `main`:

All staff apps (admin console, partner app):

- **Staff must sign in again once after this release.** Staff tokens now belong to a session; tokens issued before the release have none and get 401.
- `POST /staff/login` also returns `refreshToken` and `expiresIn`. The access token lasts 12 hours by default. `POST /staff/refresh` `{ refreshToken }` swaps it for a new pair; `POST /staff/logout` ends this device's session.
- A deactivated account logging in now gets **403** `ACCOUNT_DISABLED` (was 401). Five wrong passwords lock the account for 15 minutes: **429** `ACCOUNT_LOCKED` with `Retry-After`.
- New: `POST /staff/password/forgot`, `/password/reset`, `/password/change`.
- `PATCH /staff/users/:id/password` (admin) now also signs that person out everywhere.

Delivery routes (`/logistics/...`):

- Not your delivery: **403** (was 400). Delivery changed under you: **409** `DELIVERY_STATE_CHANGED` (was 400). Already taken: 409 `JOB_ALREADY_TAKEN`. Bad step: 400 `INVALID_STAGE_TRANSITION` with `allowed`.
- New optional stage `PAY_VENDOR` between `EN_ROUTE_TO_PICKUP` and `PICKED_UP`. Delivery objects gain `stageHistory: [{ stage, at }]`.
- The handover code can only be checked after pickup.
- New: `GET /logistics/deliveries/:id`, `GET /logistics/me`, `POST /logistics/deliveries/:id/accept` (same as claim), wallet and documents routes.

Support:

- Replies have `fromAdmin`, `authorId`, and the text as both `message` and `body`. A ticket returns them as `replies` and again as `messages`.
- Customers and partners can reply with `POST /support/tickets/:id/messages` `{ body }`. Admins keep `POST /support/tickets/:id/replies` `{ message }`.
- Replying to a closed ticket is now **409** `TICKET_CLOSED` (was 400).

Notifications:

- `PATCH /notifications/read-all` answers `{ count, updated }` (same number).
- `GET /notifications` without paging options still returns the latest 50 as an array. With `?limit=&cursor=` it returns `{ items, nextCursor }`.

Errors:

- Every error now also has `message`, `code` and `requestId`. The old `statusCode`, `error`, `path` and `timestamp` are unchanged.

Customer app:

- Orders: quantities must be whole numbers from 1 to 100, with at most 50 lines. Duplicate lines are merged.
- Unpaid orders are cancelled and restocked after `ORDER_PAYMENT_TIMEOUT_MINUTES` (default 30), or 24 hours once an online payment was started.
- Five wrong passwords lock the account for 15 minutes (429). Ten wrong codes across sign-up and reset lock the code flows for an hour (429).
- A new code can be requested at most once a minute (429 on resend).
- `GET /app/config?app=customer&version=` is available. Its `maintenance` follows the admin maintenance switch.

## WhatsApp "Contact us" and FAQ (2.13, 2.14)

Needs migration `20261110150000_add_faqs` (a new table only). Run `npx prisma db seed` once to add the starter questions; it never overwrites answers an admin has edited.

Customer app:

- **Contact us:** read `whatsappUrl` from `GET /settings` (also in `GET /app/config` → `support.whatsappUrl`) and open it. It is `https://wa.me/233XXXXXXXXX`, which opens a WhatsApp chat with the manager. Hide the button while it is `null`, which it is until an admin sets the number.
- **FAQ:** `GET /faqs` (no login) returns `{ items, categories }`. `items` is every published question in display order. `categories` is `[{ name, items }]` for a sectioned screen (`name: null` = uncategorised, listed last). Add `?category=Payments` to show one section. Each item is `{ id, question, answer, category, sortOrder, updatedAt }`.

Admin console:

- WhatsApp number: `PATCH /admin/settings` `{ "whatsappContactNumber": "0241234567" }`. Any common format works (`+233 24 123 4567`, `0241234567`); it is stored as `233241234567`. Send `""` to remove it. A bad number gets 400.
- FAQs: `GET /admin/faqs` (all, including unpublished), `POST /admin/faqs` `{ question, answer, category?, sortOrder?, isPublished? }`, `PATCH /admin/faqs/:id` (any of those fields), `DELETE /admin/faqs/:id`. Question 5–300 characters, answer up to 5000. `isPublished: false` hides a question without deleting it. Changes appear in the audit log.

## Notification popup and sound, Delivery App notification settings (2.4)

No migration. The missing popup and "ding" is partly backend and partly app.

**Backend (done):**
- Admin broadcasts were the only pushes sent with no Android channel. Android then uses Expo's fallback channel, which shows no popup. They now go out on `orders` (customers) or `deliveries` (staff), like every other push. Deleted customer accounts are no longer included.
- Every push asks for `sound: "default"` and `priority: "high"`. Partners who turned sound off get silent pushes.

**Both apps must (or the popup and sound still won't appear):**

1. Create the channels once at start-up, before registering the token:
   ```ts
   await Notifications.setNotificationChannelAsync('orders', { name: 'Orders', importance: Notifications.AndroidImportance.MAX, sound: 'default', vibrationPattern: [0, 250, 250, 250] });
   await Notifications.setNotificationChannelAsync('deliveries', { name: 'Deliveries', importance: Notifications.AndroidImportance.MAX, sound: 'default', vibrationPattern: [0, 250, 250, 250] });
   ```
   Android only shows a popup for channels with HIGH or MAX importance. A channel's importance can't be raised after it was created, so if the app already created them with lower importance, use new ids (tell us and we'll switch the backend to them) or ask testers to reinstall.
2. Show notifications while the app is open. By default Expo shows nothing in the foreground, which matches "it's in the list but no popup":
   ```ts
   Notifications.setNotificationHandler({
     handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
   });
   ```
3. Register the token after every login: `POST /notifications/devices` `{ token, platform }`.

**Checking a phone:**
- `POST /notifications/test` (any signed-in user) sends a test push to the caller's own phones. It returns, per phone, whether Expo accepted it, plus a `hint`. Nothing is added to the in-app list. Limited to 5 a minute.
- `POST /admin/notifications/test` `{ userId }` or `{ staffUserId }` does the same for someone else's account (admin only).
- What the answer means:
  - `devices: []` means the app never registered that phone.
  - `status: ok` but nothing on the phone means app setup (channels and handler above).
  - `DeviceNotRegistered` means the app must register again.
  - `InvalidCredentials` means the FCM/APNs keys in the Expo project.

**Delivery App notification settings:** `GET /logistics/me/preferences` and `PUT /logistics/me/preferences` `{ notifications: { … } }` (partners). The backend now acts on these switches (`active` in the answer says which):

| Switch | Pushes it controls |
| --- | --- |
| `newJobs` | New delivery available (`DELIVERY_AVAILABLE`) |
| `jobUpdates` | **New:** a delivery you accepted was cancelled (`DELIVERY_CANCELLED`, with `jobId`) |
| `payments` | **New:** cash-out sent (`CASHOUT_PAID`), cash-out failed (`CASHOUT_FAILED`, money back in balance), payment recorded by an admin (`PAYOUT_RECORDED`) |
| `sound` | Every partner push is silent when off |
| `promotions` | Saved only; nothing is sent yet |

A switched-off category still appears in the in-app notification list; only the lock-screen push is skipped. Document reviews and support replies always push.

## Delivery windows and rescheduling (2.8)

Needs migration `20261110180000_add_delivery_windows` (new nullable columns on `orders` only). Marketplace orders only; food orders are unchanged. Times are Ghana time (UTC+0, no daylight saving).

| Order placed | Delivered |
| --- | --- |
| before 9:00 AM | same day, 10:00 AM – 12:00 PM |
| 9:00 AM to 2:59 PM | same day, 4:00 PM – 6:00 PM |
| 3:00 PM or later | next day, 10:00 AM – 12:00 PM |

Customer app:

- Marketplace orders (from `POST /orders`, `GET /orders`, `GET /orders/:id`) now carry `deliveryWindow: { slot, start, end, label }`, e.g. `label: "Sun 8 Nov, 10:00 AM – 12:00 PM"`. It is `null` for food orders and for orders placed before this release. The raw `deliveryWindowStart`, `deliveryWindowEnd`, `originalWindowStart`, `rescheduledAt` and `rescheduleCount` are there too.
- `GET /orders/:id/delivery-windows` returns:
  - `current` and `original`;
  - `canReschedule`, plus a `reason` when it is false;
  - `options`: the original window and the two after it, each with `isCurrent`, `isOriginal` and `available`.

  Show only these options; there is no date picker.
- `PATCH /orders/:id/delivery-window` `{ windowStart }` (the `start` of an option) moves the delivery and returns the same shape as above. The customer gets a `DELIVERY_RESCHEDULED` notification.
- Rules:
  - Only the original window and the two after it, counted from the **original** window, not from the last move. Moving back to the original is allowed.
  - Only until the current window starts, while the order is pending, confirmed or preparing, and before pickup.
- Errors:
  - 400 `WINDOW_NOT_ALLOWED` (with `allowed`) or `WINDOW_IN_THE_PAST`.
  - 409 `WINDOW_STARTED`, `ALREADY_ON_THE_WAY`, `ORDER_NOT_RESCHEDULABLE` or `ORDER_CHANGED` (refresh and retry).
  - 400 `NO_DELIVERY_WINDOW` for food orders.

Admin console:

- `GET /admin/orders?deliveryDate=2026-11-08` gives one day's marketplace deliveries, sorted by window: a run sheet for that day.
- Every order shows its window fields.
- The admin who accepted a marketplace delivery is notified when the customer moves it.

## Product images (2.2)

Needs migration `20261110210000_add_product_images` (a new table only). Uses the existing `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. The public bucket `product-images` is created automatically on the first upload (change it with `PRODUCT_IMAGES_BUCKET`).

Admin console:

- **Upload:** `POST /marketplace/products/:id/images` as `multipart/form-data`, with one or more files in the field **`images`**.
  - JPEG, PNG or WebP, at most 5 MB each (`PRODUCT_IMAGE_MAX_BYTES`), at most 5 per product (`PRODUCT_IMAGES_MAX`).
  - The type is checked from the file's contents, so a renamed PDF is refused.
  - If any file is refused, nothing is uploaded.
  - **Since 13 Nov 2026 every photo is converted on the server:** stored as WebP, at most 1600 px on its longest side (smaller photos are not enlarged), turned upright from the camera's orientation, with hidden metadata (GPS location, camera details) removed. A 400 px WebP thumbnail is made too. The admin can keep uploading normal JPEG/PNG/WebP files. Needs migration `20261113120000_product_image_thumbnails` (nullable columns only).
  - Returns `{ productId, imageUrl, thumbnailUrl, images }`.
- **Reorder:** `PATCH /marketplace/products/:id/images/order` `{ imageIds: [...] }` lists every image once; the first becomes the main image.
- **Delete:** `DELETE /marketplace/products/:id/images/:imageId` removes one photo (and its file); the next becomes the main image.
- Deleting a product also deletes its photo files.
- **Errors:**
  - 400 `UNSUPPORTED_IMAGE_TYPE`, `NO_IMAGE` or `INVALID_IMAGE_ORDER`;
  - 400 `INVALID_IMAGE` when the file can't be read as a picture, or `IMAGE_TOO_LARGE` when it is over 40 megapixels;
  - 413 when the file is too large;
  - 409 `TOO_MANY_IMAGES`;
  - 503 `STORAGE_NOT_CONFIGURED` or `STORAGE_UNAVAILABLE`.

Customer app:

- Every product (list and detail) now has `images: [{ id, url, thumbnailUrl, width, height, sortOrder }]` in display order.
- `imageUrl` is still there and is always the first photo, so screens that only use `imageUrl` work unchanged. Use `images` for a gallery.
- **Thumbnails (13 Nov 2026):** use `product.thumbnailUrl` (or `images[i].thumbnailUrl`) on product cards and lists, and `url` on the product page. Photos uploaded before the change have `thumbnailUrl`, `width` and `height` set to `null`, so fall back to `url`: `thumbnailUrl ?? url`. `width`/`height` let the app reserve the right space before the picture loads.
- `GET /marketplace/products/:id/images` (public) returns the same list.
- The bundled fallback image is only needed while `imageUrl` is `null`.

## Promotions popup (2.1)

Needs migration `20261110230000_add_promotions` (new table and two enums only). Uploaded popup images go to the public bucket `promotion-images` (created on first upload; `PROMOTION_IMAGES_BUCKET` to change it). Since 13 Nov 2026 they are converted to WebP (max 1600 px, metadata removed), like product photos; no thumbnail is made.

Customer app:

- On launch, call `GET /promotions/active` (no login). It returns live promotions, highest `priority` first, at most 10. Show the first as the popup (the rest can be a carousel). Each has:
  - **Text and image:** `id`, `title`, `subtitle`, `body`, `imageUrl`.
  - **Button:** `ctaLabel`, `ctaType`, `ctaValue`. See the button table below.
  - **Look:** `theme`, e.g. `{ background, textColor, accentColor, animation }`, where `animation` is one of `none`, `fade`, `slide`, `bounce`, `confetti`, `float3d`. This is where the 3D and animated presentation is styled.
  - **Schedule:** `startsAt`, `endsAt`.
  - **Popup frequency:** `ONCE`, `DAILY` or `EVERY_OPEN`. The app tracks which ids it has shown; also use `updatedAt` to show an edited promotion again.
- Button: open the product / category / vendor / food vendor with id `ctaValue`, or the https link for `URL`. `NONE` means no button.
- When an admin announces a promotion, customers get a push and an in-app notification with `type: "PROMOTION"` and `data.promotionId`. Opening it should show that promotion.

Admin console:

| Route | Body / query | Notes |
| --- | --- | --- |
| `GET /admin/promotions` | `?status=live\|scheduled\|ended\|inactive` | Each row has `status` |
| `GET /admin/promotions/:id` | | |
| `POST /admin/promotions` | `title` (required), `subtitle?`, `body?`, `imageUrl?` (https), `ctaType?`, `ctaValue?`, `ctaLabel?`, `theme?`, `startsAt?` (default now), `endsAt?` (null = no end), `isActive?`, `priority?` 0–1000, `frequency?` | The button target must exist (400 `INVALID_CTA`); the end must be after the start |
| `PATCH /admin/promotions/:id` | any of the above | `isActive: false` hides it at once |
| `DELETE /admin/promotions/:id` | | Removes the uploaded image too |
| `POST /admin/promotions/:id/image` | multipart, field `image` | JPEG, PNG or WebP; replaces the old one |
| `POST /admin/promotions/:id/announce` | | Push to all customers (their "announcements" switch is respected). Live promotions only (409 `PROMOTION_NOT_LIVE`), at most once per 12 hours (409 `ALREADY_ANNOUNCED`) |

All admin changes appear in the audit log.

## Customisable food orders (2.12A)

Needs migration `20261111000000_add_menu_item_options`. It adds two new tables and one nullable column on `order_items`.

Example (the Gɔbɛ from the requirement): menu item "Gɔbɛ" at GH₵0, with three groups:
- "Beans portion", pick exactly 1: Beans GH₵5 or Beans GH₵7;
- "Plantain", optional: GH₵5 or GH₵6;
- "Extras", up to 2 kinds: Sausage GH₵3.50, Egg GH₵2 (up to 3 eggs).

Beans 5 + plantain 5 + sausage = GH₵13.50; beans 7 + plantain 6 + egg = GH₵15.

Customer app:

- Menu items (`GET /food/vendors/:id/menu`, `GET /food/vendors/:id`, `GET /food/menu-items/:id`) now have `optionGroups: [{ id, name, minSelect, maxSelect, sortOrder, options: [{ id, name, price, maxQuantity, isAvailable, sortOrder }] }]`, in display order. Items with no groups are plain, as before.
  - `minSelect` 0 means optional; 1 or more means the customer must pick that many.
  - `maxSelect` is how many different options may be picked.
  - `maxQuantity` is how many of one option (e.g. 3 eggs); that counts as one pick.
  - Grey out `isAvailable: false`.
- The price shown = item `price` + each chosen option's `price` × its quantity, then × the item quantity. The server works it out the same way; the app never sends prices.
- Order: each food line can have `options: [{ optionId, quantity? }]` (`quantity` defaults to 1, max 20; at most 30 options per line). The same item with different choices is a separate line; identical lines are merged.
- Errors (400):
  - `OPTIONS_REQUIRED`: a required group was not chosen; the message names it.
  - `INVALID_OPTIONS`: too many picks, an option from another item, a duplicate, or a bad quantity.
  - `OPTION_UNAVAILABLE`.
  - "Marketplace products have no options".
- Orders return `items[].selectedOptions: [{ groupId, groupName, optionId, name, price, quantity }]` (null for plain items). Show these on the order and receipt; `unitPrice` already includes them. They are a copy: later menu changes never alter past orders.
- **Older app versions** cannot add options, so ordering an item that has a required group fails with `OPTIONS_REQUIRED` until the app is updated. Add required groups only after the new app is out (optional groups are fine).

Admin console / vendors (ADMIN, or the VENDOR who owns that food vendor):

| Route | Body |
| --- | --- |
| `POST /food/menu-items/:id/option-groups` | `{ name, minSelect?, maxSelect?, sortOrder? }` (max defaults to min, or 1) |
| `PATCH /food/option-groups/:id` | any of those (min may not exceed max) |
| `DELETE /food/option-groups/:id` | removes it with its options |
| `POST /food/option-groups/:id/options` | `{ name, price?, maxQuantity?, isAvailable?, sortOrder? }` |
| `PATCH /food/options/:id` | any of those, e.g. `{ "isAvailable": false }` when eggs run out |
| `DELETE /food/options/:id` | |

## Pre-orders (2.12B)

Needs migration `20261111030000_add_pre_orders`: new tables, one enum, and two defaulted columns on `products`. Customers' reference photos go to the PRIVATE bucket `preorder-references`, created on first upload. The apps get links that last 10 minutes; re-fetch the request to refresh them.

**Not built yet:** paying for an accepted quote. That rule is undecided. Until then, accepting means "agreed", and payment and delivery are arranged outside the app.

Customer app:

- Products have `allowsPreOrder`, `preOrderLeadDays` and `variants: [{ id, name, description, priceDelta, imageUrl }]` (the designs to pick from).
- `POST /preorders` `{ productId?, variantId?, description, specifications?, quantity? }`:
  - Leave out the product for a fully custom request.
  - `specifications` is label → text, e.g. `{ "Size": "42", "Colour": "brown" }`, at most 20 entries.
  - `description` is 10–2000 characters; `quantity` is 1–20.
- `POST /preorders/:id/images`: multipart, field `images`. JPEG, PNG or WebP, up to 5 MB each and 5 per request, and only while it is `SUBMITTED`.
- `GET /preorders` and `GET /preorders/:id` (own requests only).
  - Each has `status`, `quotedPrice`, `estimatedDate`, `adminNote`, the product and design, and `images: [{ id, url }]`.
- After a quote (`QUOTED`): `POST /preorders/:id/accept`, or `POST /preorders/:id/decline` `{ note? }`.
- `POST /preorders/:id/cancel` `{ note? }` works while `SUBMITTED` or `QUOTED`.
- Statuses: `SUBMITTED`, then `QUOTED`, then `ACCEPTED` (then `FULFILLED`) or `DECLINED`. A request can be `CANCELLED` before it's fulfilled.
- Notifications: `PREORDER_QUOTED` (price and date), `PREORDER_FULFILLED`, `PREORDER_CANCELLED`, all with `data.preOrderId`.
- Errors:
  - 400 `PREORDER_NOT_ALLOWED`, `INVALID_VARIANT` or `INVALID_SPECIFICATIONS`;
  - 409 `PREORDER_LOCKED`, `TOO_MANY_IMAGES`, `INVALID_PREORDER_STATUS` or `PREORDER_CHANGED`.

Admin console:

- Mark a product as pre-orderable: `PATCH /marketplace/products/:id` `{ allowsPreOrder: true, preOrderLeadDays: 14 }`.
- Designs:
  - `POST /marketplace/products/:id/variants` `{ name, description?, priceDelta?, imageUrl? (https), isActive?, sortOrder? }`;
  - `PATCH /marketplace/variants/:id`;
  - `DELETE /marketplace/variants/:id`.
- Requests:
  - `GET /admin/preorders?status=SUBMITTED`, and `GET /admin/preorders/:id` (with the customer's contact details and photo links).
  - `POST /admin/preorders/:id/quote` `{ price, estimatedDate, note? }`. The price is the total for the request; it works while `SUBMITTED` or `QUOTED`, so you can re-quote.
  - `PATCH /admin/preorders/:id/status` `{ status: "FULFILLED" | "CANCELLED", note? }`. Fulfilled only from `ACCEPTED`.
- Admins are notified of new requests (`PREORDER_SUBMITTED`) and of the customer's decision (`PREORDER_ACCEPTED`, `PREORDER_DECLINED`, `PREORDER_CANCELLED`).

## Laundry with several vendors (2.15)

Needs migration `20261111060000_laundry_multivendor`. It creates the vendor **Fastermall Laundry** (`id: "fastermall-laundry"`, approved) and moves every existing catalog item and laundry order onto it. Laundry staff with no vendor count as Fastermall Laundry's. Nothing changes for current customers. Fastermall still runs every pickup and delivery.

**Not built yet:** commission and vendor payouts. `commissionRate` is stored but nothing is calculated or paid.

Customer app (signed in, like the rest of `/laundry`):

- `GET /laundry/vendors` lists approved vendors with `{ id, name, description, logoUrl, location, phone, isOpen, rating, reviewCount }`, open ones first, then best rated. `rating` is the 1–5 average, or `null` without reviews.
- `GET /laundry/vendors/:id` returns one vendor and its `catalogItems`. `GET /laundry/vendors/:id/catalog` returns just the catalog.
- `GET /laundry/catalog` (unchanged) is Fastermall Laundry's catalog. Use `?vendorId=` for another vendor's.
- `POST /laundry/orders`: items must all come from **one** vendor. Optionally send `vendorId` too; it must match the items.
  - 400 `MIXED_LAUNDRY_VENDORS` or `WRONG_LAUNDRY_VENDOR`.
  - 409 `LAUNDRY_VENDOR_CLOSED`.
  - 404 if the vendor isn't approved.
- Laundry orders now include `vendor: { id, name, logoUrl }`.
- Reviews:
  - `GET /laundry/vendors/:id/reviews?page&pageSize` (author is the first name only).
  - `POST /laundry/vendors/:id/reviews` `{ rating 1–5, comment? }` is one per customer per vendor; posting again edits it. It needs a COMPLETED order with that vendor (403 `REVIEW_NOT_ALLOWED`).
  - `DELETE /laundry/vendors/:id/reviews/me`.

Laundry staff app:

- `GET /laundry/staff/orders?status=` returns their vendor's orders (admins: all, or `?vendorId=`).
- Staff can only open and move their own vendor's orders; others answer 404.

Admin console:

| Route | Body / query | Notes |
| --- | --- | --- |
| `GET /admin/laundry/vendors` | `?status=PENDING\|APPROVED\|SUSPENDED` | With counts of services, orders, staff |
| `GET /admin/laundry/vendors/:id` | | With catalog (incl. inactive) and staff |
| `POST /admin/laundry/vendors` | `name`, `description?`, `logoUrl?` (https), `location?`, `phone?`, `isOpen?`, `commissionRate?` 0–100, `status?` (`PENDING` default, or `APPROVED`) | |
| `PATCH /admin/laundry/vendors/:id` | the same fields except status | `isOpen: false` stops new orders but keeps it listed |
| `PATCH /admin/laundry/vendors/:id/status` | `{ status }` | `SUSPENDED` hides it from customers and stops new orders |
| `POST /admin/laundry/vendors/:id/catalog` | `{ name, description?, unitPrice, isActive? }` | The vendor's own services and prices |
| `PATCH /admin/laundry/catalog/:itemId` | any of those | `isActive: false` switches a service off; past orders keep their price |
| `PATCH /admin/laundry/staff/:staffId/vendor` | `{ vendorId }` (null = Fastermall Laundry) | LAUNDRY_STAFF only |
| `DELETE /admin/laundry/reviews/:id` | | Moderation; the rating is recalculated |

`GET /admin/laundry-orders` rows now include `vendor`.

## Partner applications

Needs migration `20261112090000_add_partner_applications` (a new enum and table only).

Delivery app (no sign-in):

- `POST /partner-applications` `{ fullName, email, phone, dateOfBirth: "YYYY-MM-DD", address, partnerType: "WALKING" | "MOTORCYCLE", plateNumber? }`. Returns `{ id, status: "PENDING", createdAt }`. Limited to 5 a minute.
  - `plateNumber` is required for motorcycles. Phone numbers in any common Ghana form become `0241234567`; the email becomes the sign-in email.
  - 400 `TOO_YOUNG` (under 18) or `INVALID_DATE_OF_BIRTH`; 409 `ACCOUNT_EXISTS` (email or phone already has a staff account) or `APPLICATION_PENDING`.
- Documents are not part of the application: once approved, the partner signs in and uploads them from Documents.

Admin console:

- `GET /admin/partner-applications?status=PENDING|APPROVED|REJECTED` (newest first, at most 200).
- `POST /admin/partner-applications/:id/approve` (no body needed; a `password` from older consoles is ignored) creates the DELIVERY_PARTNER account (email, phone, name, partner type from the application) in the same transaction as marking it approved. Returns `{ application, account, emailSent }`. 409 `APPLICATION_REVIEWED` or `ACCOUNT_EXISTS`.
- `POST /admin/partner-applications/:id/reject` `{ reason }`.
- On approval nobody chooses a password: the account gets a one-time **setup code**, valid 7 days, emailed to the partner. In the Delivery app they enter email + code + their own password with `POST /staff/password/reset` (the normal staff reset). If the code runs out or the email never arrived, `POST /staff/password/forgot` emails a fresh 15-minute code. When `emailSent` is false (SMTP not set up or failing), the partner can still use that, or an admin can set a password for them in Staff.

## Customers cancel their own orders

No migration.

- `POST /orders/:id/cancel` (customer, own marketplace or food order). Allowed while the order is `PENDING` or `CONFIRMED`, before the vendor starts preparing it. Stock goes back, the delivery is released, and a partner who had already taken it is told (`DELIVERY_CANCELLED`).
- Returns `{ id, status: "CANCELLED", refund }`, where `refund` is:
  - `NOT_PAID`: nothing was paid.
  - `REFUNDED`: the online payment was refunded through the provider.
  - `PENDING_ADMIN`: the provider refused the automatic refund. The order stays cancelled and the payment stays `SUCCESSFUL`. Every admin gets a `REFUND_NEEDED` notification (`data.orderId`, `data.paymentId`), and the payment is listed by `GET /admin/payments?needsRefund=true`; `GET /admin/dashboard` returns the count as `refundsNeeded`.
- Errors: 404 for someone else's order; 409 `ORDER_NOT_CANCELLABLE` (already preparing or cancelled) or `ORDER_CHANGED` (it moved on at the same moment).
- Laundry orders still can't be cancelled in the app.

## Audit fixes (13 Nov 2026)

- **Customer-only routes refuse staff tokens with 403** (`Only customer accounts can use this route`) instead of a 500: `POST/GET /orders`, `GET /orders/:id`, the delivery-window routes, `POST /orders/:id/cancel`, `POST/GET /laundry/orders`, `POST/DELETE /laundry/vendors/:id/reviews`, `POST /payments/initialize`, `GET /payments/verify/:reference`, `GET /payments` and every `/preorders` route. Customer apps are unaffected. `GET /laundry/orders/:id` stays open to laundry staff and admins.
- **Admin console:** `GET /admin/payments?needsRefund=true` lists successful payments whose order was cancelled (money still owed). It overrides `status`. `GET /admin/dashboard` adds `refundsNeeded`. A new staff notification type, `REFUND_NEEDED`, is sent to every admin when a customer's automatic refund fails.
- **Refunds:** `POST /payments/:id/refund` now marks the payment `REFUNDED` before calling Paystack and puts it back to `SUCCESSFUL` if Paystack refuses. A second refund of the same payment at the same moment gets a 409 and never reaches Paystack.
- `ORDER_PAYMENT_TIMEOUT_MINUTES` is now read (default 30).

## Legal pages: privacy policy and terms of use (13 Nov 2026)

Needs migration `20261113150000_add_legal_pages` (new table; it starts with the drafts from `legal/`). Admins edit the text in the console; nothing in the apps needs a release to pick up a change.

Apps and anyone (no login):

- `GET /legal/privacy` and `GET /legal/terms` return `{ slug, title, content, version, publishedAt }`. `content` is Markdown (headings, lists, tables, links). Cached 5 minutes.
- `GET /legal/privacy/page` and `GET /legal/terms/page` return the same page as a self-contained, mobile-friendly web page (light and dark). Set `PRIVACY_URL` / `TERMS_URL` in Render to these, so `GET /app/config` hands them to both apps; the apps open them in a browser.
- Unknown page: 404.

Admin console:

- `GET /admin/legal` lists both pages, with `version`, `publishedAt`, `updatedById`, `updatedAt`.
- `PUT /admin/legal/:slug` with `{ title?, content }` publishes at once as the next version (`publishedAt` = now). Sending the same text again changes nothing. `content` must be 50 to 100,000 characters. Each publish is in the audit log as `admin.legal.put`.
- Raw HTML in the text is shown as text, never run; links may only be web, email, phone or relative; images are dropped.

