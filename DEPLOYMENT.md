# Deploying the backend

Everything needed to put this backend live on Render (Supabase Postgres + Storage), and what to do in the apps and admin console afterwards. Written for the November 2026 release (work breakdown features + partner applications); the steps hold for later releases too.

Production API: `https://fastermall-super-app-backend.onrender.com/api/v1`

### Release checklist

- [ ] Database backed up (section 1)
- [ ] `npm test` and `npm run build` pass on the commit being deployed (section 1)
- [ ] New migrations tried on a copy of the database (section 1)
- [ ] Environment variables set in Render (section 2)
- [ ] Render build, pre-deploy, start and health check set (section 3)
- [ ] Migrations applied; `npx prisma migrate status` says up to date (section 3)
- [ ] Paystack webhook and callback URLs point at this API (section 4)
- [ ] Seed FAQs; `partner-documents` bucket exists (section 4)
- [ ] Smoke tests pass (section 5)
- [ ] Admin console content filled in (section 6)
- [ ] Known issues read (section 8)

---

## 1. Before you deploy

1. **Back up the database.** Supabase → Database → Backups (or `pg_dump` with `DIRECT_URL`). Every migration in this release only adds tables, columns and enums, but take the backup anyway.
2. **Check what's pending.** From your machine, with the production `DATABASE_URL` / `DIRECT_URL` in `.env`:
   ```bash
   npx prisma migrate status
   ```
   It lists the migrations not yet applied (see section 3).
3. **Set any new environment variables** (section 2) in Render *before* the deploy, so the new code starts with them.
4. **Run the tests and the build** on the exact commit you are deploying:
   ```bash
   npm ci && npx prisma generate && npm test && npm run build
   ```
   On 13 Nov 2026 (`c26445c`): 708/708 tests pass and the build is clean.
5. **Try the new migrations on a copy first.** `20261111000000_add_menu_item_options`, `20261111030000_add_pre_orders` and `20261111060000_laundry_multivendor` have only been checked by unit tests, never against a real Postgres (see `BACKEND_WORK_LOG.md`). Restore the backup into a spare Supabase project or a local Postgres, point `DATABASE_URL` / `DIRECT_URL` at it, and run `npx prisma migrate deploy` there. Then run `npx prisma migrate diff --from-url "$DIRECT_URL" --to-schema-datamodel prisma/schema.prisma --exit-code`, which should report no difference.

---

## 2. Environment variables (Render → Environment)

**New or newly important in this release are marked ★.** Names only; never commit real values.

### Required

| Variable | What it is |
| --- | --- |
| `NODE_ENV` | `production` |
| `DATABASE_URL` | Supabase **transaction pooler** URL |
| `DIRECT_URL` | Supabase **direct** connection URL (used by migrations) |
| `JWT_SECRET` | 32+ random characters; the server refuses to start in production otherwise |
| `DELIVERY_CODE_ENCRYPTION_KEY` | 64 hex characters (32 bytes) |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Storage: product, promotion, pre-order and document files |
| `SUPABASE_ANON_KEY` | Supabase project anon key |
| `PAYMENT_PROVIDER` | `paystack` (`mock` is refused in production) |
| `PAYSTACK_SECRET_KEY` | Paystack live secret key |
| `PAYMENT_CALLBACK_URL` | This API's payment callback route |
| ★ `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | Email. Now also sends **partner approval emails with the setup code**. Without it, approved partners get no email and can't set a password themselves (an admin must set one in Staff). |
| ★ `EMAIL_FROM` | Sender, e.g. `Fastermall <hello@fastermall.app>`. Falls back to `SMTP_USER`. |

### Optional (defaults shown)

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `3000` | Render sets this |
| `JWT_EXPIRES_IN` | `7d` | Customer tokens |
| `STAFF_ACCESS_TOKEN_EXPIRES_IN` / `STAFF_REFRESH_TOKEN_DAYS` | `12h` / `30` | |
| `CORS_ORIGINS` | *(any)* | Set to the admin console's origin(s), comma-separated |
| `PAYMENT_CURRENCY` | `GHS` | |
| `PAYSTACK_BASE_URL` | `https://api.paystack.co` | Leave unset; only for pointing at a test double |
| `MARKETPLACE_DELIVERY_FEE` | `5` | Starting value; admins change it in Settings |
| `GOOGLE_WEB_CLIENT_ID`, `GOOGLE_IOS_CLIENT_ID` | | Google sign-in |
| `ADMIN_BOOTSTRAP_SECRET` | | Only to create the very first admin |
| `CASH_OUT_MIN_PESEWAS` / `CASH_OUT_FEE_PESEWAS` | `1000` / `0` | Partner wallet |
| `MAX_ACTIVE_FOOD_DELIVERIES` | `3` | Food jobs one partner can carry at once |
| `PARTNER_REQUIRE_VERIFICATION` | `false` | ★ Turn on once partners have uploaded documents (the Delivery app now uploads them for real). Then only partners with approved documents can accept jobs. |
| `PARTNER_AUTO_OFFLINE` / `PARTNER_OFFLINE_AFTER_SECONDS` | `false` / `180` | Leave off: live location was removed |
| `DOCUMENTS_BUCKET` / `DOCUMENT_MAX_BYTES` | `partner-documents` / 5 MB | Private bucket |
| ★ `PRODUCT_IMAGES_BUCKET` / `PRODUCT_IMAGE_MAX_BYTES` / `PRODUCT_IMAGES_MAX` | `product-images` / 5 MB / `5` | Public bucket |
| ★ `PROMOTION_IMAGES_BUCKET` | `promotion-images` | Public bucket |
| ★ `PREORDER_IMAGES_BUCKET` / `PREORDER_IMAGES_MAX` | `preorder-references` / `5` | Private bucket |
| `APP_MIN_VERSION_PARTNER`, `APP_MIN_VERSION_CUSTOMER`, `APP_UPDATE_URL_PARTNER`, `APP_UPDATE_URL_CUSTOMER` | | Force-update prompt in the apps (see section 7) |
| `MAINTENANCE_MODE`, `MAINTENANCE_MESSAGE`, `SUPPORT_PHONE`, `SUPPORT_EMAIL`, `PRIVACY_URL`, `TERMS_URL` | | Served at `GET /app/config` |

`ORDER_PAYMENT_TIMEOUT_MINUTES` is mentioned in `APP_CHANGES.md` but the code doesn't read it yet: unpaid orders always expire after 30 minutes (24 hours once a payment was started). Setting it in Render has no effect until it is added to `src/config/configuration.ts` (see section 8).

---

## 3. Database migrations

Render must run `prisma migrate deploy` **before** the new code starts. Set in Render:

- **Build command:** `npm ci && npm run build`
- **Pre-deploy command:** `npx prisma migrate deploy`
- **Start command:** `npm run start:prod`
- **Health check path:** `/api/v1/settings` (public and cheap; it answers 200 once the app has started). It falls back to default settings if the database is unreachable, so also check the Render logs after a deploy.
- **Node version:** 20 or newer (`package.json` requires 18+). Pin it with `NODE_VERSION=20` in the environment or an `.nvmrc`, so Render doesn't change it underneath you.

(No pre-deploy command on your plan? Run `npx prisma migrate deploy` from your machine against production first, then deploy.)

Migrations added in this release, all additive (new tables, nullable or defaulted columns, new enums):

| Migration | Adds |
| --- | --- |
| `20261110120000_merge_support_messages_into_replies` | Support replies (from the partner-app merge) |
| `20261110150000_add_faqs` | FAQ table |
| `20261110180000_add_delivery_windows` | Delivery window columns on orders |
| `20261110210000_add_product_images` | Product photos table |
| `20261110230000_add_promotions` | Promotions table + 2 enums |
| `20261111000000_add_menu_item_options` | Food choices / add-ons (2 tables, 1 column) |
| `20261111030000_add_pre_orders` | Pre-orders, designs (variants), reference images |
| `20261111060000_laundry_multivendor` | Laundry vendors + reviews; creates **Fastermall Laundry** (`fastermall-laundry`) and moves existing catalog and orders onto it |
| `20261112090000_add_partner_applications` | Partner applications table + enum |

Check afterwards: `npx prisma migrate status` should say *Database schema is up to date*.

---

## 4. One-off data steps

1. **Starter FAQs** (8 questions; only added if missing, never overwrites edits). Use `SEED_ONLY=faqs`: a full seed would also add the demo catalog and bring back demo items an admin deleted. `ts-node` is a dev dependency, so run it from your machine with production env vars, not on Render:
   ```bash
   SEED_ONLY=faqs npx prisma db seed
   ```
   (PowerShell: `$env:SEED_ONLY='faqs'; npx prisma db seed`.) Since this release the seed never overwrites existing rows, so a mistaken full run doesn't undo admin edits.
2. **Paystack URLs** (Paystack dashboard → Settings → API Keys & Webhooks, in **Live** mode):
   - **Webhook URL:** `https://fastermall-super-app-backend.onrender.com/api/v1/payments/webhook`. The backend checks Paystack's signature with `PAYSTACK_SECRET_KEY` and then re-confirms each payment with Paystack. Without the webhook, a payment is only marked paid when the app calls `GET /payments/verify/:reference`, so a customer who closes the app mid-payment never gets a delivery.
   - **Callback URL:** the same value as `PAYMENT_CALLBACK_URL` (`…/api/v1/payments/callback`).
   - Test keys (`sk_test_…`) and live keys have separate webhook settings. Set the one matching the key in Render.
3. **First admin (new environment only).** If the database has no admin yet, set `ADMIN_BOOTSTRAP_SECRET` (32+ random characters) and call once:
   ```bash
   API=https://fastermall-super-app-backend.onrender.com/api/v1
   curl -s -X POST "$API/staff/bootstrap-admin" -H "Content-Type: application/json" \
     -d '{"secret":"<ADMIN_BOOTSTRAP_SECRET>","email":"you@example.com","password":"<8+ chars, use a long one>","fullName":"Your Name"}'
   ```
   It refuses once any admin exists. Remove `ADMIN_BOOTSTRAP_SECRET` from Render afterwards. Production already has an admin, so skip this there.
4. **Storage buckets.** Public buckets (`product-images`, `promotion-images`) and the private pre-order bucket are created automatically on first upload. Create the **private** `partner-documents` bucket yourself in Supabase → Storage if it doesn't exist (do **not** make it public).

---

## 5. Smoke tests after deploy

```bash
API=https://fastermall-super-app-backend.onrender.com/api/v1

curl -s "$API/settings"            # 200: fees, whatsappUrl (null until set), acceptedPaymentMethods (no CASH)
curl -s "$API/faqs"                # 200: { items, categories } (empty until seeded)
curl -s "$API/promotions/active"   # 200: [] until an admin adds one
curl -s -X POST -H "Content-Type: application/json" -d '{}' "$API/partner-applications"   # 400 (validation), not 404
curl -s -X POST -H "Content-Type: application/json" -d '{}' "$API/payments/webhook"        # 401: unsigned webhooks are refused
curl -s "$API/app/config"          # 200: minimum versions, maintenance, support contacts
```

Then, in the admin console:

- **Partner application end to end:** apply in the Delivery app (or with `POST /partner-applications`) using an email you can read → approve in **Delivery Partners** → the toast should say the code was emailed → in the Delivery app use **Set up account or reset password** with that code → sign in → deactivate the test account in **Staff**.
- Place one marketplace order with Mobile Money or card (cash is refused) and check it shows a delivery window. Pay it, check the payment shows as successful in **Payments** (this proves the webhook works), then cancel it from the app: it should be refunded. If Paystack refuses the refund, the app is told `refund: "PENDING_ADMIN"` but nothing appears in the console (see section 8): refund it by hand in **Payments**.

---

## 6. Admin console tasks after deploy

The new features are empty until someone fills them in:

1. **Settings → Platform settings → Support and WhatsApp number.** Until set, the apps hide *Call us*, *WhatsApp*, and the partner safety call.
2. **Settings → fees.** Check the marketplace delivery fee and laundry pickup fee; the apps now show the server's values.
3. **FAQ**: review the seeded answers.
4. **Promotions**: add any live promotion (with theme/animation); it pops up on app launch.
5. **Products**: add photos (up to 5 each); mark made-to-order products as pre-orderable and add designs.
6. **Food**: add option groups / add-ons to dishes (add *required* groups only after the new customer app is out, or old versions can't order those dishes).
7. **Laundry vendors**: add and approve vendors with their own price lists.
8. **Delivery Partners → Applications**: review pending applications.
9. **Privacy policy:** mention that the rider carrying an order sees the customer's phone number.

---

## 7. Apps

Both mobile apps need new builds (EAS) for this release:

- **Super App:** `expo-location` and `react-native-maps` were removed; cash, maps, delivery windows, promotions, food options, pre-orders, laundry vendors and product galleries depend on this backend.
- **Delivery app:** `expo-notifications` was added (push), plus real documents, applications and set-up/reset password.

Once the new builds are in the stores, set `APP_MIN_VERSION_PARTNER` / `APP_MIN_VERSION_CUSTOMER` (and the `APP_UPDATE_URL_*`) so older versions are asked to update.

The admin console deploys itself from `main` on Vercel.

---

## 8. Known issues in this release

From the audit of 13 Nov 2026 (`presentation/` has the full write-up). None blocks the release, but know them before going live:

| Issue | Effect | Workaround until fixed |
| --- | --- | --- |
| 16 known vulnerabilities in dependencies (`npm audit --omit=dev`: 2 critical, 7 high) | Third-party code with published weaknesses (proxy-addr, tar, multer, body-parser and others) | Run `npm audit fix` and the tests in a separate commit; plan the NestJS major upgrade for the rest |
| Failed automatic refunds are only logged | A customer who cancels a paid order may not get their money back if Paystack refuses | After deploy, check the Render logs for `automatic refund failed` and refund those in **Payments** |
| `ORDER_PAYMENT_TIMEOUT_MINUTES` is ignored | Unpaid orders always expire after 30 minutes | None needed unless you want a different timeout |
| Staff accounts on customer-only routes get a 500 instead of a 403 | Confusing error if a staff login places an order | Use a customer account for test orders |
| Unpaid-order and partner-offline sweeps run inside the web server | They pause while the Render service is asleep (free plan) | Use a plan that doesn't sleep, or accept a delay after wake-up |

## 9. If something goes wrong

- **Code problem:** redeploy the previous commit in Render. The migrations are additive, so older code keeps working with the newer database.
- **Migration failed part-way:** `npx prisma migrate status` shows which one. Fix the cause, then `npx prisma migrate resolve --rolled-back <name>` and deploy again. Restore the backup only if data is damaged.
- **No emails:** check the `SMTP_*` variables and the Render logs (`Failed to send partner approval email`). Approvals still succeed; set a password for the partner in **Staff** meanwhile.

More detail per feature: `APP_CHANGES.md` (API contracts) and `BACKEND_WORK_LOG.md` (what was built and why).
