# Housekeeping

A room has separate conditions, and none stands in for another:

| Condition | Where it lives |
|---|---|
| Occupied | an active room assignment of a checked-in reservation |
| Cleanliness | `rooms.housekeeping`: DIRTY, CLEANING, CLEAN, INSPECTED |
| Do Not Disturb | `rooms.dnd` |
| Out of order / out of service | open maintenance blocks (`maintenance_requests`) and `rooms.outOfOrder` |
| Cleaning work | `housekeeping_tasks` |

## Status codes
`housekeepingCode` (`src/server/domain/housekeeping.ts`) derives the familiar code for display only. Precedence: Out of Order (OOO), Out of Service (OOS), Do Not Disturb (DND), then occupancy and cleanliness:

| Code | Meaning |
|---|---|
| VD | Vacant, dirty (also while being cleaned) |
| VC | Vacant, clean |
| VI | Inspected |
| OD / OC | Occupied, dirty / clean |
| Stayover | Occupied with an open stayover (pickup) task |

Names can be changed per property in Settings > Rooms (`housekeeping.codeLabels`).

## Ready means
`roomReady`: never when occupied, out of order or out of service. Clean counts only when inspection is not required; with `housekeeping.inspectionRequired` on, the room must be inspected. Check-in, the arrivals list, the housekeeping board and alerts all use this one rule. Cleaning an occupied room makes it Occupied – Clean; it never becomes available. Clearing an out-of-order room still needs `rooms.resolve`.

## Task flow
`taskStep` is the single transition table: start, complete, request inspection, pass or fail inspection, reopen, cancel. Completing with inspection required leaves the task awaiting inspection and the room clean but not ready; a failed inspection sends the task back to pending and the room to dirty. Every change carries the task `version`; a stale version is refused with the name of whoever changed it, so simultaneous updates never overwrite each other. A housekeeper cannot work a task assigned to someone else.

Tasks are created by checkout (departure, linked to the reservation), by a supervisor (priority), or by "Generate stayover tasks" (idempotent per day, skips Do Not Disturb rooms). There is no scheduler: stayover generation is a button.

## Who can do what
| Action | Permission |
|---|---|
| View the board | `housekeeping.view` |
| Start, complete, request inspection, note, Do Not Disturb | `housekeeping.update` |
| Inspect, assign, change priority, reopen, cancel, create tasks, generate stayovers | `housekeeping.manage` |
| Report a maintenance issue (no room block) | `maintenance.report` (housekeeping, front desk, managers) |
| Block a room or mark it out of order | `rooms.block` |

Housekeepers see rooms and tasks. Reservation references and guest names appear only for staff with `reservations.view` and `guests.view`.

## Notifications
In-app notifications (`app_notifications`) are written in the same transaction as the change and deduplicated by key. Events: room checked out, inspection requested, inspection failed, room ready for today's arrival, maintenance reported or room blocked. Each has an audience permission; read state is per user. They appear in the bell count and on the Alerts page. Derived alerts add overdue cleaning, arrivals whose room is not ready, and rooms awaiting inspection.
