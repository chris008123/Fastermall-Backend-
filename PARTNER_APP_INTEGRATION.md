# Partner app: what changed in the backend and how to use it

Written from the backend code as it stands after Tasks 1 to 13. Everything below is in the code and covered by tests, but none of it has been run against a live database or storage bucket yet. Check each flow once on staging.

Base path: `/api/v1`. Every success is wrapped as `{ "success": true, "data": ... }`.

---

## 1. Rules that apply everywhere

**Errors** always look like this. Branch on `code`, not on `message`.

```json
{ "success": false, "message": "Readable text", "code": "JOB_ALREADY_TAKEN",
  "errors": [{ "field": "number", "message": "number must be 10 digits" }],
  "requestId": "…", "statusCode": 409 }
```

`errors` only appears for validation failures (`code: VALIDATION_FAILED`). Every response carries an `X-Request-Id` header. Show it to the partner on "something went wrong" screens so support can find the request.

**401 versus 403.** 401 means the session has ended (bad, expired or revoked token, or a disabled account). 403 means "signed in but not allowed". The app should only sign out on 401. A wrong password in a form is **400**, never 401.

**Retry safety.** Send an `Idempotency-Key` header (a fresh UUID per user action, reused when retrying that same action) on accept, advance stage, verify code and cash-out. A repeat returns the first result with `Idempotent-Replayed: true`. Cash-out **requires** the header.

**Rate limits.** 429 with `Retry-After` seconds. `ACCOUNT_LOCKED` (5 wrong passwords, 15 minutes) uses the same shape.

**Money** is whole pesewas as integers with a `currency` (`GHS`). 2550 means GHS 25.50. Never send or show decimals from these fields.

---

## 2. Sessions (items 2 and 3)

| Call | Notes |
|---|---|
| `POST /staff/login` `{email,password}` | Returns `accessToken` (15 min), `refreshToken` (30 days, single use), `expiresIn` (seconds), `user`. Disabled account: 403 `ACCOUNT_DISABLED`. |
| `POST /staff/refresh` `{refreshToken}` | Returns a new pair. Store both. A used token again returns 401 `SESSION_REUSED` and ends every session. |
| `POST /staff/logout` `{pushToken?}` | Ends this device's session and removes its push token. |
| `POST /staff/password/forgot` `{email}` | Always the same answer. Emails a 6-digit code (15 min). |
| `POST /staff/password/reset` `{email,code,newPassword}` | 8 to 72 characters. Signs out every device. |
| `POST /staff/password/change` `{currentPassword,newPassword}` | Other devices are signed out, this one stays. |

**App change:** in `authStore.expireSession`, on a 401 call `/staff/refresh` once, store the new pair and retry the failed request once. Sign out only if refresh itself fails. Without this, partners are signed out every 15 minutes. Two-factor authentication is **not built**.

---

## 3. Jobs (items 4, 5 and 6)

| Call | Notes |
|---|---|
| `GET /logistics/me` | Profile with `isAvailable`, `lastSeenAt`, masked `payoutDestination`. |
| `PATCH /logistics/me` `{isAvailable}` | Returns the saved profile. Going online while a deletion is pending: 409 `ACCOUNT_DELETION_PENDING`. |
| `GET /logistics/deliveries/unassigned` | Jobs to accept. |
| `GET /logistics/me/deliveries` | The partner's own jobs and history. |
| `GET /logistics/deliveries/:id` | One job with `stageHistory`. Opens a waiting food job too (for push taps). |
| `POST /logistics/deliveries/:id/accept` | Same as `…/claim`. 409 `JOB_ALREADY_TAKEN`. 403 `NOT_VERIFIED` only if verification is switched on. |
| `PATCH /logistics/deliveries/:id/status` `{status}` | Order: `EN_ROUTE_TO_PICKUP` → (`PAY_VENDOR`) → `PICKED_UP` → `EN_ROUTE_TO_CUSTOMER`. `PAY_VENDOR` is optional. Bad move: 400 `INVALID_STAGE_TRANSITION` with `allowed`. Two taps at once: 409 `DELIVERY_STATE_CHANGED`. |
| `POST /logistics/deliveries/:id/verify-code` `{code}` | Only after pickup. Five wrong tries lock the job for 5 minutes. This is the only way to reach `DELIVERED`. |

**List options** (both lists): `?status=DELIVERED` or a comma list, `?limit=20&cursor=…` (answer becomes `{items,nextCursor}`), and on `me/deliveries` `?updatedSince=<X-Server-Time of last answer>` (merge the changed jobs by id). With none of these the answer is the same array as before. Responses carry `ETag`, so send `If-None-Match` on the 30-second refresh and a 304 costs almost nothing.

Each job has `stageHistory: [{stage, at}]`. The timeline should read from it instead of keeping `PAY_VENDOR` only on the phone. Partners no longer receive the handover code hash.

---

### Editing the profile (item 20)

`PATCH /logistics/me` also accepts `vehiclePlate`, `vehicleType` (`WALKING` or `MOTORCYCLE`) and `phone` (10 digits starting with 0). Send only what changed; validation errors use the standard `errors` list.

- **Plate or vehicle type change:** the approved vehicle registration and insurance are sent back as `REJECTED` with a reason, so the partner uploads new ones for an admin to approve. The answer says so: `reverification: { required: true, documentsReset: [...] }`. Show this to the partner. Blocked while a job is running (409 `ACTIVE_DELIVERIES`). A motorcycle needs a plate (`PLATE_REQUIRED`); a walking partner cannot have one.
- **Phone change:** needs `currentPassword` (`PASSWORD_REQUIRED`); 409 `PHONE_IN_USE` if taken. No re-verification.
- **Photo:** it is the `PROFILE_PHOTO` document (section 7). `GET /logistics/me/photo` returns a 5-minute link to show it.

---

## 4. Wallet and payouts (items 7 and 8)

| Call | Notes |
|---|---|
| `GET /logistics/me/wallet` | `balancePesewas`, `pendingPesewas`, `earnedPesewas`, `paidOutPesewas`, minimum and fee, masked destination. |
| `GET /logistics/me/wallet/ledger?limit=&cursor=` | Earnings are positive, cash-outs negative. |
| `POST /logistics/me/cash-out` `{amountPesewas}` | **Needs `Idempotency-Key`.** Errors: `INSUFFICIENT_BALANCE`, `BELOW_MINIMUM`, `NO_PAYOUT_DESTINATION`. Creates a `PENDING` request. |
| `GET/PUT/DELETE /logistics/me/payout-destination` | `PUT {network,number,password}`; network is `MTN`, `TELECEL` or `AIRTELTIGO`; number is 10 digits starting with 0. Password needed to change or remove. |
| `GET /logistics/me/earnings` | Now also has `totalPesewas` and `amountPesewas` per entry. |

Cash-outs are **paid by hand**. An admin marks them `PAID` or `FAILED` (`PATCH /logistics/admin/payouts/:id`). The app should show "Pending" until then. `FAILED` gives the money back.

---

## 5. Notifications, push and preferences (items 9 and 18)

- Register the phone with `POST /devices` `{token}` on every login or launch. Remove it with `DELETE /devices?token=…` or pass `pushToken` to `/staff/logout`.
- New-job push: `data.type = "DELIVERY_AVAILABLE"`, with `data.jobId` (same as `deliveryId`). Open `GET /logistics/deliveries/:id` on tap. Document review push: `DOCUMENT_REVIEWED`. Support reply push: `SUPPORT_REPLY` with `ticketId`.
- `GET /notifications` (optional `?unread=true&limit=&cursor=`), `GET /notifications/unread-count`, `PATCH /notifications/:id` `{isRead}`, `PATCH /notifications/read-all`, `DELETE /notifications/:id`.
- `GET/PUT /logistics/me/preferences`: `PUT` changes only what you send. The response has an `active` block saying what the backend really acts on. **Live today:** `notifications.newJobs` and `notifications.sound`. **Saved only:** everything under `delivery`, plus `navigation`, `vibration`, `jobUpdates`, `payments`, `promotions`. Keep showing "not active yet" for those.

---

## 6. Location and presence (items 16, 19 and 21)

- `PUT /logistics/me/location` `{latitude,longitude,accuracyMeters?}` about every 60 seconds **while online**. Offline gives 409 `PARTNER_OFFLINE`. Only the latest position is stored, and it is cleared when going offline.
- `POST /logistics/me/heartbeat` if the app has no location permission.
- The 30-second job refresh already counts as a heartbeat.
- The app needs a location permission and a privacy explanation before sending positions.
- Auto-offline exists but is **off** (`PARTNER_AUTO_OFFLINE=false`). Turn it on only after the app sends location or heartbeats, otherwise partners with the app closed are taken offline, which also stops their new-job pushes.

---

## 7. Documents (item 10)

1. `POST /logistics/me/documents` `{type, contentType, sizeBytes, expiresAt?}` returns `upload.url`, `upload.token`, `upload.path`.
2. Upload the file with supabase-js `uploadToSignedUrl(path, token, file)`.
3. `POST /logistics/me/documents/:id/complete`. The real file is checked. 422 `FILE_NOT_ACCEPTED` if it does not match.
4. `GET /logistics/me/documents` returns the list plus `verification` (`VERIFIED` or `INCOMPLETE`, `missing`, `expiringSoon`).

Types: `ID_CARD`, `PROFILE_PHOTO`, `DRIVERS_LICENSE`, `VEHICLE_REGISTRATION`, `INSURANCE`. JPEG, PNG, WebP or PDF up to 5 MB; photos only for `PROFILE_PHOTO`. Licence, registration and insurance need `expiresAt`. A rejected document carries `rejectionReason` to show.

---

## 8. Support, app config, account (items 1, 11 and 14)

- `POST /support/tickets` `{subject,message,deliveryId?}`, `GET /support/tickets`, `GET /support/tickets/:id`, `POST /support/tickets/:id/messages` `{body}`.
- `GET /app/config?app=partner&version=1.4.2` (no sign-in): `updateRequired`, `updateUrl`, `maintenance`, `support.phone/email`, `legal.privacyUrl/termsUrl`. Call it on launch and replace the hard-coded placeholders. Set the values on the host first.
- Delete account: `POST /staff/me/deletion-request` `{password}` starts a 14-day grace period; `GET` shows `completesBy`; `DELETE` cancels. Blocked with 409 while a job is running (`ACTIVE_DELIVERIES`) or money is owed (`WALLET_NOT_EMPTY`). Export: `POST /staff/me/data-export` `{password}` returns the data as JSON.

---

## 9. Status against your list

| # | Item | Status |
|---|---|---|
| 1 | Account deletion, export | Built. Legal retention rules need your confirmation. |
| 2 | Sessions, logout, refresh | Built. |
| 3 | Login protection, password recovery | Built. Two-factor not built. |
| 4 | Server-side rules | Built. |
| 5 | Idempotency | Built for accept, advance, verify code, cash-out. |
| 6 | Stages, history, filters, paging | Built. |
| 7 | Payout destination | Built. |
| 8 | Wallet, cash-out | Built. Payment to the partner is manual. |
| 9 | Notifications, push | Built. |
| 10 | Documents | Built. No virus scanning. |
| 11 | Support | Built. Real phone and email come from app config. |
| 12 | Demand map | **Not built.** |
| 13 | Error format | Built. |
| 14 | App config | Built. |
| 15 | Environments, hosting | Not code. Needs a staging API, always-on hosting, HTTPS. |
| 16 | Availability, auto-offline | Built. Auto-offline off by default. |
| 17 | Privacy and terms pages | **Yours to publish.** |
| 18 | Preferences | Built. Only notification settings are acted on. |
| 19 | Location | Built. Radius matching not built. |
| 20 | Profile edits (plate, vehicle type, phone, photo) | Built. A new plate or vehicle type needs re-verification. |
| 21 | `lastSeenAt` | Built. |

## 10. Settings to add on the host before relying on this

`STAFF_ACCESS_TOKEN_EXPIRES_IN`, `STAFF_REFRESH_TOKEN_DAYS`, `CASH_OUT_MIN_PESEWAS`, `CASH_OUT_FEE_PESEWAS`, `DOCUMENTS_BUCKET`, `PARTNER_REQUIRE_VERIFICATION`, `PARTNER_AUTO_OFFLINE`, `ACCOUNT_DELETION_GRACE_DAYS`, and the app-config values (`APP_MIN_VERSION_PARTNER`, `SUPPORT_PHONE`, `SUPPORT_EMAIL`, `PRIVACY_URL`, `TERMS_URL`, `MAINTENANCE_MODE`, and so on). All are listed in `.env.example`.
