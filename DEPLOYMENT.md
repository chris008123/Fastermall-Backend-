# Deploying the backend

Everything needed to put this backend live on Render (Supabase Postgres + Storage), and what to do in the apps and admin console afterwards. Written for the November 2026 release (work breakdown features + partner applications); the steps hold for later releases too.

Production API: `https://fastermall-super-app-backend.onrender.com/api/v1`

---

## 1. Before you deploy

1. **Back up the database.** Supabase → Database → Backups (or `pg_dump` with `DIRECT_URL`). Every migration in this release only adds tables, columns and enums, but take the backup anyway.
2. **Check what's pending.** From your machine, with the production `DATABASE_URL` / `DIRECT_URL` in `.env`:
   ```bash
   npx prisma migrate status
   ```
   It lists the migrations not yet applied (see section 3).
3. **Set any new environment variables** (section 2) in Render *before* the deploy, so the new code starts with them.

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

---

## 3. Database migrations

Render must run `prisma migrate deploy` **before** the new code starts. Set in Render:

- **Build command:** `npm ci && npm run build`
- **Pre-deploy command:** `npx prisma migrate deploy`
- **Start command:** `npm run start:prod`

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

1. **Starter FAQs** (8 questions; only added if missing, never overwrites edits). `ts-node` is a dev dependency, so run it from your machine with production env vars, not on Render:
   ```bash
   npx prisma db seed
   ```
2. **Storage buckets.** Public buckets (`product-images`, `promotion-images`) and the private pre-order bucket are created automatically on first upload. Create the **private** `partner-documents` bucket yourself in Supabase → Storage if it doesn't exist (do **not** make it public).

---

## 5. Smoke tests after deploy

```bash
API=https://fastermall-super-app-backend.onrender.com/api/v1

curl -s "$API/settings"            # 200: fees, whatsappUrl (null until set), acceptedPaymentMethods (no CASH)
curl -s "$API/faqs"                # 200: { items, categories } (empty until seeded)
curl -s "$API/promotions/active"   # 200: [] until an admin adds one
curl -s -X POST -H "Content-Type: application/json" -d '{}' "$API/partner-applications"   # 400 (validation), not 404
```

Then, in the admin console:

- **Partner application end to end:** apply in the Delivery app (or with `POST /partner-applications`) using an email you can read → approve in **Delivery Partners** → the toast should say the code was emailed → in the Delivery app use **Set up account or reset password** with that code → sign in → deactivate the test account in **Staff**.
- Place one marketplace order with Mobile Money or card (cash is refused) and check it shows a delivery window.

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

## 8. If something goes wrong

- **Code problem:** redeploy the previous commit in Render. The migrations are additive, so older code keeps working with the newer database.
- **Migration failed part-way:** `npx prisma migrate status` shows which one. Fix the cause, then `npx prisma migrate resolve --rolled-back <name>` and deploy again. Restore the backup only if data is damaged.
- **No emails:** check the `SMTP_*` variables and the Render logs (`Failed to send partner approval email`). Approvals still succeed; set a password for the partner in **Staff** meanwhile.

More detail per feature: `APP_CHANGES.md` (API contracts) and `BACKEND_WORK_LOG.md` (what was built and why).
