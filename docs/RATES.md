# Rates, rate plans and how a booking is priced

Four things stay separate:

1. **Category default rate** (`room_types.baseRateMinor`): what a night costs when no plan applies. Also the category's extra-adult and extra-child charges.
2. **Rate plans** (`rate_plans`, `rate_plan_rates`): optional offers that replace the default for chosen categories and dates (seasonal, weekend, one-adult, meal plan, stay limits).
3. **Tax**: GST is calculated from the tax rules on top of the rate, by tariff band. A plan's `taxNote` is only a reminder for staff.
4. **The booking's own price**: frozen onto the reservation when it is made.

All amounts are whole paise and before tax.

## Which rate applies to a night

Done by `effectiveNightRates` in `src/server/domain/rates.ts`, the same function the booking quote and the preview use.

1. Candidate plans are active, linked to the category, open on that date (`validFrom` to `validTo`, either may be blank) and allow the stay length (`minStay`, `maxStay`).
2. If several are candidates, the winner is the one with the **highest priority**, then the **narrower date window**, then the **newer plan**.
3. Inside the winning plan: one adult alone gets the one-adult rate if set; otherwise a night on one of the plan's weekend days (default Friday and Saturday) gets the weekend rate if set; otherwise the weekday rate.
4. With no candidate plan, the category default rate applies.
5. Discounts are applied per night on that night's rate, and the property's maximum discount applies to every night.
6. Extra-person charges use the winning plan's extra-adult and extra-child rates if set, else the category's.

A guest may choose a specific plan on the booking form; otherwise the best applicable one is used.

## Overlaps

Two active plans conflict when they cover the same category on overlapping dates **at the same priority**, because nothing says which should win. Saving such a plan is refused and names the plan it clashes with. Overlaps at different priorities are allowed on purpose, for example a festival plan (priority 5) over a standard plan (priority 0). A duplicated plan starts archived for this reason.

## Existing bookings never change

When a booking is saved, the server stores on each reservation:

- `agreedRateMinor`: the first night's rate after any discount,
- `rateSnapshot`: the rate of every night, plus the extra-person rates and standard occupancy,
- `ratePlanId`: the plan that set the rate.

Room nights are posted to the folio at checkout using `rateSnapshot`, then `agreedRateMinor`, and only then the category's current rate (for very old bookings). So editing a category rate or a rate plan never changes a booking that already exists. The migration `20261017100000_property_management` froze today's rates onto bookings that were still open (tentative, confirmed or in house), so nothing visible changed when this went live.

A stay extended past its original last night is charged at the booking's agreed rate for the extra nights, not repriced.

## Who can change what

| Action | Permission |
|---|---|
| View plans and the preview | `rooms.view` |
| Create, edit, duplicate, archive, delete plans | `rates.manage` (owners, managers, revenue manager) |
| Edit category rates | `rooms.manage` |

Every change is written to the audit log with before and after values.

## Limits

- Occupancy pricing is one adult versus the standard rate plus extra-person charges, not a full matrix.
- No hourly rates, no channel-manager rate push, no restriction by booking source.
- The extra nights of an extended stay are not repriced from a plan.
- Analytics estimates for unposted nights use each booking's agreed rate, not the per-night snapshot.
