# Checkout

`completeCheckout` (`src/server/services/checkout.ts`) runs the whole checkout in **one database transaction**:

1. Lock the reservation row. If it is already checked out, return the first result and change nothing (a double click or a second tab cannot take a second payment or make a second task).
2. Post any remaining room nights.
3. Refuse if room nights could not be posted, or if a company folio still holds uninvoiced charges.
4. Record up to three payments (split tender). Each has its own idempotency key. Payments above the balance are refused.
5. If a balance remains: refuse, unless a manager (`billing.waive`) records an exception with a reason (company credit, or approved unpaid). Nothing is written off silently.
6. Issue the final invoice (unless there is nothing to invoice or it was skipped).
7. Mark the stay checked out and record `actualDeparture` and `checkedOutBy`; release the room assignment; set the room Vacant – Dirty and clear Do Not Disturb; create the departure housekeeping task linked to the reservation; write the notification and audit entries.

If any step fails, none of it is saved. There is no state where a payment or invoice exists without the checkout, or where the guest is checked out with the room still occupied.

`checkOut` and `settleAndCheckOut` call the same code, so older callers behave the same way. The checkout page (`/app/reservations/[id]/checkout`) shows the five steps: verify the stay, review the folio, settle, documents, confirm. A confirmation tick is required. The completion page lists the invoice and a receipt per payment.

## Limits
- Payments are recorded when staff confirm the money was received. Card and UPI gateway status is not verified automatically.
- "Unresolved payment" is not modelled because payments are recorded only once received.
- A late-checkout request is shown; the fee is added by hand on the folio.
- Documents are sent to the guest from the reservation page (WhatsApp, with consent). Email is not delivered by this system.

## Documents by email
The completion page and reservation page offer the confirmation by email (with the PDF attached) when the guest has agreed to email and has a valid address. See `docs/DELIVERY.md`.
