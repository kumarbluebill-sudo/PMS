# Subscriptions, plans and the platform console

This is the software provider's own billing (MK Solutions billing a hotel). It is kept apart from the hotel's guest billing: its own tables, its own invoice series (`MKS/<financial year>/<number>`), its own tax settings, and no report mixes the two.

## What is a plan

Plans are rows in the `plans` table, edited at **/platform/plans**. Nothing about prices, limits or features is hardcoded; the public pricing page and the sign-up trial read these rows. Four are seeded on first migration: Starter, Professional, Growth, Enterprise (custom priced). Each has monthly and yearly price (yearly derived from a discount unless set), trial days, limits (null means unlimited) and a feature map.

| Limit | Enforced in |
|---|---|
| Properties | `createProperty` |
| Rooms | `createRoom`, `createRoomsBulk`, room import, `reactivateRoom` |
| Users | `inviteMember` (pending invitations count) |
| Rate plans (feature) | `createRatePlan` |

Storage and integrations are in the plan but there is nothing yet to count, so they show no usage. Limits are checked inside the creating transaction, so two requests cannot both pass. The message says what to do: "Your Starter plan allows 15 rooms. Upgrade your plan to add more."

## Status machine (`domain/subscription.ts`)

Trial, Active, Payment due, Past due, Suspended, Cancelled, Expired.

- **Trial** ends into **Expired** unless a plan is paid for.
- **Active** with a period end: a renewal invoice is issued `renewalLeadDays` before the end (status Payment due).
- **Payment due** past the end unpaid: **Past due**, with `graceDays` of grace.
- **Past due** after the grace: **Suspended**. After `expireAfterSuspendedDays`: **Expired**.
- Cancel: the plan runs to the end of the paid period, then **Cancelled**.
- Hotels that existed before subscriptions were added are backfilled as Active on Enterprise with a fixed price of zero and no end date. The job never changes them.

The daily job (`GET /api/cron/subscriptions`, 01:00 UTC in `vercel.json`, needs `CRON_SECRET`) moves subscriptions along, issues renewal invoices, and sends each email once (idempotency key per subscription, event and period). Running it twice a day changes nothing the second time.

## Read-only mode

Suspended, Expired and Cancelled hotels are read-only (Past due too if the platform setting says so). It is enforced in one place, `authorize()`, which every service calls: any permission that is not a view, export or the subscription pages is refused with a clear message. Nothing is deleted. The owner can always view everything, export all data to Excel (Subscription page, "Export all my data"), and pick a plan to get back in.

## Money

Money is integer paise. Prices are before GST; the GST rate, SAC code and the provider's GSTIN are platform settings, set by the provider's accountant. This software does not decide them.

- **Upgrade mid-period:** takes effect now. The unused part of the old plan is credited and the unused part of the new plan charged, both by whole days left, each rounded to the paisa; never negative.
- **Downgrade:** starts at the next renewal and is refused while usage is over the smaller plan's limits (the screen lists what to reduce). The renewal invoice is priced on the new plan.
- **Monthly to yearly** changes at renewal.
- **Coupons:** percentage or fixed amount, optional dates, use limit, eligible plans, and a number of invoices. Attached once; the use is counted when attached.
- **Payments are recorded by a platform administrator** (bank transfer, UPI, cash, cheque). There is no payment gateway. A repeated submission with the same key records one payment. A failed attempt is kept, moves the reminder date, and the reminder repeats until paid.

## Platform console

`/platform` is a separate area. `requirePlatform()` admits only `PLATFORM_SUPER_ADMIN` (everything) and `SAAS_SUPPORT_ADMIN` (view, extend a trial, add a note); both must have MFA. Everyone else sees "not found". Create the first administrator yourself:

```
DATABASE_URL=<admin url> PLATFORM_EMAIL=you@example.com PLATFORM_PASSWORD=<12+ chars> npx tsx scripts/create-platform-admin.ts
```

They join a dedicated "MK Solutions Platform" account with no hotel data and are sent to `/platform` after sign-in. Every action requires a reason and is written to the audit log against the affected hotel.

Cross-hotel reads happen only through `withPlatform()`, which sets a transaction flag that a second row-level-security policy checks; hotel requests use `withTenant()` and cannot see other hotels' subscriptions, invoices, payments or events.

## Public site

`/pricing` (monthly/yearly toggle by link, plan cards, comparison table, add-ons, FAQ with FAQ and Offer structured data), `/contact` and `/contact?demo=1` (stored as a lead after validation, a hidden honeypot field, a per-visitor and overall rate limit; the visitor's address is stored only as a hash; an email goes to the sales address if one is set), `/register?plan=<code>` starts that plan's trial, `robots.txt` and `sitemap.xml`. The FAQ states plainly that channel manager connections are not available yet and that payment is by bank transfer or UPI.

## Limits (honest list)

- No payment gateway: a person records each payment.
- The provider's SAC code and tax rate must be confirmed by their accountant.
- Storage and integration usage read zero until those features exist.
- The rate limits are in memory per server instance.
- Emails go through the existing email delivery; with no `RESEND_API_KEY` they are recorded as TEST and not sent.
