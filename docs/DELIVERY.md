# Email, group confirmations, category changes and the daily stayover job

## Email (Resend)
Set in Vercel: `RESEND_API_KEY`, `EMAIL_FROM` (an address on a domain verified in Resend, for example `Palm Resort <bookings@yourdomain.com>`), and optionally `RESEND_WEBHOOK_SECRET`. Without the first two, emails are recorded as **TEST** and nothing is sent; the screen says so.

| Status | Meaning |
|---|---|
| TEST | No provider connected. Nothing was sent. |
| ACCEPTED | Resend accepted the message. This is **not** delivery. |
| DELIVERED / BOUNCED | Reported by Resend's signed webhook. |
| FAILED | Resend refused it or could not be reached; the reason is on the row. |

For delivered and bounced to appear, add a webhook in Resend pointing to `https://<your-site>/api/webhooks/resend` for the delivered, bounced and complained events, and put its signing secret in `RESEND_WEBHOOK_SECRET`. The handler checks the Svix signature and refuses old timestamps. Status only moves forward and a final state is never overwritten.

Guest emails need the guest's recorded email consent (separate from WhatsApp) and a valid address; the same confirmation is not sent twice unless staff resend deliberately. Account emails (verification, password reset) are now sent through the same path; a sending problem never blocks sign-up or reset.

## Group confirmation
For a booking of several rooms, the PDF and the emailed attachment cover every room (one section each, with the group total). "This room only" gives one.

## Changing a room category
Pending or confirmed bookings only. A free room of the new category replaces the old one and the stay is priced again at the new category's current rates and plans. Any discount on the old booking is not carried over. The old and new totals are shown before saving, and the change is audited with the reason.

## Daily stayover job
Switch on "Create stayover tasks automatically every morning" under Settings > Rooms. `vercel.json` runs `/api/cron/stayover` once a day at 00:30 UTC (about 06:00 in India). Set `CRON_SECRET` in Vercel; the job refuses any request without it. Vercel's free plan runs a cron once a day at a fixed time. The "Generate stayover tasks" button still works at any time, and the job never creates a second task for a room on the same day.

## Not included
No payment-gateway verification: payments are recorded when staff confirm receipt.
