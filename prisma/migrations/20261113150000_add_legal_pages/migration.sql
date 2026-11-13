-- Privacy policy and terms of use, edited in the admin console.
-- Starts with the drafts in legal/ (13 Nov 2026); admins publish the final text.
CREATE TABLE "legal_pages" (
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "legal_pages_pkey" PRIMARY KEY ("slug")
);

INSERT INTO "legal_pages" ("slug", "title", "content", "updatedAt") VALUES
('privacy', $legal$Fastermall Privacy Policy$legal$, $legal$> **Draft.** This page is still being finalised and may change before launch.

## 1. Who we are

Fastermall ("we", "us") runs the Fastermall customer app (marketplace, food delivery, laundry), the Fastermall Delivery app for delivery partners, and an admin console used by our staff. This policy explains what personal information we collect through them, why, who we share it with, and the choices you have.

The data controller is [registered business name], [registered address], Ghana. Contact: [privacy email], [phone]. [If registered: Data Protection Commission registration number ______.]

## 2. Information we collect

**If you use the customer app:**

- **Account details:** your name, email address and phone number. Your password is stored only in scrambled (hashed) form; we cannot read it. If you sign in with Google, we receive your name and email address from Google.
- **Addresses:** the delivery addresses you save, including a map pin if you add one.
- **Orders:** what you order (marketplace, food, laundry and custom pre-orders), prices, delivery fees, delivery windows, notes you add, and each order's status history.
- **Payments:** the amount, method (Mobile Money or card), status and payment reference. Your card or Mobile Money details are entered on Paystack's page, not ours, and we never receive or store them.
- **Reviews and ratings** you post about products and laundries.
- **Support messages** you send us.
- **Photos you upload** with a custom pre-order request.
- **Notifications:** the messages we send you, and a push token for your phone so we can send them.

**If you apply to deliver, or deliver, for us:**

- **Application:** name, email, phone, date of birth, home address, whether you deliver on foot or by motorcycle, and your plate number if you ride.
- **Verification documents** you upload, such as ID, licence and a photo of yourself.
- **Work records:** the jobs you claim and complete, earnings, cash-out requests and payouts.
- **Payout details:** your Mobile Money network and number.
- **Activity:** whether you are online, and when the Delivery app was last active. We do **not** track or store your live location.
- **Your notification preferences.**

**If you are a member of staff:** your name, email, phone, role, login sessions and, for administrators, a log of the changes you make in the admin console.

**Collected automatically:** your IP address (used to limit repeated login attempts and protect the service), the app version, and technical logs of requests and errors. We do not use advertising trackers.

## 3. How we use information

We use it to:

- create and secure your account (sign-up codes, password resets, locking an account after repeated wrong passwords);
- take, price, deliver and support your orders, including assigning delivery windows and handover codes;
- take payments and make refunds through Paystack;
- review delivery partner applications and documents, pay partners, and keep work records;
- send notifications about your orders, deliveries, support tickets and, if you allow them, promotions;
- prevent fraud and abuse, keep the service running, and fix problems;
- meet legal, tax and accounting duties.

We do not sell your personal information, and we do not use it for automated decisions that have legal effects on you.

## 4. Who we share information with

| Who | What they see | Why |
| --- | --- | --- |
| The delivery partner carrying your order | Your name, delivery address and **phone number**, and what is being delivered | So they can find you and call you if needed |
| Food vendors, shops and laundries | Your order details and the name and address needed to fulfil it | So they can prepare your order |
| Paystack | Order amount, your email and a payment reference | To take payments and refunds |
| Supabase (database and file storage) | All data described above | To host our database and files |
| Render | Data passing through our servers | To host our backend |
| Expo, Google and Apple push services | Your phone's push token and the notification text | To deliver notifications |
| Our email provider [name] | Your email address and the code or message | To send sign-up, reset and approval emails |
| Google | Only if you choose "Sign in with Google" | To confirm your identity |
| Authorities | Only what the law requires | To comply with a valid legal request |

Each provider may only use your information to provide its service to us.

**Delivery codes:** each order has a 6-digit handover code. Only you can see it in your app; the partner enters it to confirm delivery. We store it in scrambled and encrypted form.

## 5. Payments

Card and Mobile Money payments are processed by Paystack ([Paystack privacy policy](https://paystack.com/privacy)). We never see your full card number or Mobile Money PIN. We keep a record of each payment (amount, status, reference, date) for refunds, accounting and disputes.

## 6. Photos and documents

- **Product and promotion photos** uploaded by our staff are public. They are converted on our servers, and hidden data such as the GPS location where a photo was taken is removed.
- **Your pre-order reference photos** and **delivery partners' verification documents** are stored privately. Only our staff can open them, through short-lived links that expire within minutes (one minute for documents, ten for pre-order photos).

## 7. Where data is stored and how it is protected

Our database and files are hosted by Supabase in the European Union (Ireland), and our servers by Render [region]. This means your information is transferred outside Ghana; we use providers that protect it with industry-standard security.

Safeguards include encrypted connections (HTTPS); passwords and codes stored only in scrambled form; limits on login and code attempts; staff access restricted by role, with sessions that can be ended at once; and a log of administrator changes.

No system is perfectly secure. If a breach affects your personal information, we will tell you and the Data Protection Commission as the law requires.

## 8. How long we keep data, and deleting your account

- You can delete your customer account in the app ([Profile → Delete account]). We then remove your name, email, phone, password, saved addresses and phone push tokens. We keep the order and payment records themselves, without your contact details, for [6] years for accounting and tax purposes.
- Delivery partner records (jobs, earnings, payouts) are kept for [6] years after you stop working with us. Verification documents are deleted [within 12 months] after that, unless the law requires otherwise.
- Applications that are rejected are deleted after [6 months].
- Technical logs are kept for [30 days].

## 9. Your rights

Under Ghana's Data Protection Act, 2012 (Act 843), you can ask us to:

- tell you what personal information we hold about you and give you a copy;
- correct information that is wrong (you can also edit your name and phone in the app);
- delete your information, where we are not required to keep it;
- stop using your information for a particular purpose, including promotions (you can also turn these off in your phone's notification settings).

Contact [privacy email]. We will reply within [21] days. If you are unhappy with our answer, you can complain to the Data Protection Commission of Ghana ([dataprotection.org.gh](https://www.dataprotection.org.gh)).

## 10. Children

Fastermall is not meant for anyone under [18]. We do not knowingly collect information from children. If you believe a child has given us information, contact us and we will delete it.

## 11. Changes and contact

We may update this policy. If the changes are significant, we will tell you in the app before they take effect; the date at the top always shows the latest version.

Questions or requests: [privacy email] · [phone] · [WhatsApp] · [postal address]
$legal$, CURRENT_TIMESTAMP),
('terms', $legal$Fastermall Terms of Use$legal$, $legal$> **Draft.** This page is still being finalised and may change before launch.

## 1. About these terms

These terms are an agreement between you and [registered business name] ("Fastermall", "we") for using the Fastermall customer app and, for delivery partners, the Fastermall Delivery app. By creating an account or placing an order, you accept them. Our [Privacy Policy](../privacy/page) explains how we handle your information.

## 2. Your account

- You must be at least [18] years old and give accurate details.
- Keep your password private. You are responsible for what happens on your account.
- After 5 wrong passwords, your account is locked for 15 minutes to protect it.
- You can delete your account in the app at any time (see the Privacy Policy for what we keep).

## 3. Orders and prices

- Prices, stock and fees are those shown in the app when you order. The total is worked out by our servers.
- **Delivery fees:** marketplace orders have a flat delivery fee (currently GH₵ [5]); food orders use each vendor's own delivery fee; laundry has a pickup fee (currently GH₵ [5]). Fees can change, but never on an order already placed.
- A food order can only contain items from one vendor. Choices and add-ons you pick are priced as shown.
- We may refuse or cancel an order if an item is unavailable or the price was clearly wrong; you get a full refund if you already paid.

## 4. Paying

- We accept Mobile Money and card, through Paystack. **Cash is not accepted.**
- **An order you don't pay for is cancelled automatically:** after [30] minutes if no payment was started, or after 24 hours if a payment was started but not finished. Any items we were holding for you go back on sale.

## 5. Delivery

- **Marketplace orders** are delivered in a time window decided by when you order: before 9:00, the same morning; 9:00 to 14:59, the same afternoon; 15:00 or later, the next morning. You can move your delivery to one of the next two windows, until your current window starts and before the order is picked up.
- **Food orders** are delivered as soon as they are ready.
- **Handover code:** each order has a 6-digit code shown only in your app. Give it to the delivery partner only when you have your order in hand. Sharing it earlier means you confirm delivery. Too many wrong codes lock it for a while.
- The delivery partner carrying your order can see your phone number, so they can call you to find you.
- Please be reachable at the address you give. [What happens after a failed delivery attempt, e.g. re-delivery fee or return.]

## 6. Cancelling and refunds

- You can cancel a marketplace or food order in the app **until the vendor starts preparing it.** After that, contact support.
- If you cancel a paid order, we refund it to the original payment method automatically. If the automatic refund fails, our team is told and refunds it by hand.
- Refunds are full refunds of what you paid. They usually reach you within [5–10] working days, depending on your bank or Mobile Money provider.
- If something arrives damaged, wrong or missing, contact support within [48 hours] with photos. [Our policy: replacement, refund or credit.]

## 7. Laundry

- You choose a laundry from the approved laundries in the app. Each sets its own price list. The laundry is responsible for cleaning; Fastermall handles the order and delivery.
- Please check pockets and point out delicate items in your instructions.
- [Liability for lost or damaged clothes: e.g. up to [10] times the cleaning price of the item, claims within [48 hours] of return.]
- You can rate a laundry after a completed order.

## 8. Custom pre-orders

- You can ask for a product in a chosen design, or something custom, and attach reference photos.
- We reply with a price and an estimated ready date (a quote). Nothing is owed until you accept the quote. You can cancel a request until you accept it.
- [How an accepted quote is paid, e.g. deposit or full payment, and whether it can be cancelled after acceptance.]

## 9. Reviews and content

- Reviews must be honest and about your own experience. No abuse, personal information, spam or illegal content.
- We may remove reviews and other content that breaks these rules.

## 10. Delivery partners

If you deliver with Fastermall, these extra terms apply:

- You apply in the Delivery app. We may approve or refuse any application and may ask for documents such as ID and a licence, which we check.
- Jobs: the first partner to claim a job gets it. Walking partners take jobs up to 2 km; longer ones go to motorcycle partners. You move each job through its steps in order and complete it only with the customer's handover code.
- Pay: you earn a fixed amount per completed delivery, set by Fastermall (currently GH₵ [amount]). You can cash out to your Mobile Money number once your balance is at least GH₵ 10. [Cash-out fee, if any, and payout timing.]
- Use customers' phone numbers and addresses only for the delivery you are carrying. Contacting customers for anything else is not allowed.
- We may deactivate a partner account for safety, fraud, repeated complaints or breaking these terms. [Employment status: partners are independent contractors, not employees, if that applies.]

## 11. Things you must not do

Do not misuse the apps: no fake orders, no trying to get into other people's accounts, no automated scraping, no attempts to bypass payments or delivery codes, and no harassment of customers, partners, vendors or staff.

## 12. Our responsibility

- We do our best to keep the apps running and orders on time, but we can't promise there will be no delays or interruptions.
- Vendors and laundries are responsible for the products and services they provide; Fastermall is responsible for taking your order, payment and delivery.
- [Limitation of liability wording, for the lawyer.] Nothing in these terms limits rights you have under Ghanaian consumer law.

## 13. Changes, law and contact

- We may change these terms. If a change is significant, we will tell you in the app before it takes effect.
- These terms are governed by the laws of Ghana. [Courts or dispute process.]
- Contact: [support email] · [support phone] · [WhatsApp] · [postal address]
$legal$, CURRENT_TIMESTAMP)
ON CONFLICT ("slug") DO NOTHING;
