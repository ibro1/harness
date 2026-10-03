---
description: "Fork-local meeting reminders: posts recurring WhatsApp reminders of monthly meetings to group chats on a schedule, with the Hijri date as the main date."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-meeting-reminders

## Summary

Posts reminders of monthly meetings ("first Saturday", "last Friday") to WhatsApp groups without anyone pressing send. Each rule names the group, the meeting's nth weekday, its time and venue, and when to remind (days before and a local time); the message leads with the Islamic (Hijri) date and gives the English date beside it. Each reminder goes out at most once. The settings page shows each rule's next meeting, previews its message, and sends one by hand.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

The web-app bundle inserts it when `DSH_DEPLOY=1` (`DSH_MEETING_REMINDERS=0` leaves it out), sending through the WhatsApp plugin's command route (`WA_COMMAND_URL`, `WA_AGENT_TOKEN`). It sends nothing until rules are saved at **Plugins → Meeting reminders**, where the rules are one JSON array, with the time zone (default `Africa/Lagos`), the Hijri day adjustment, the alert recipient and the default message.

A rule:

| Field | Meaning |
|---|---|
| `id` | short id you choose; sent reminders are recorded under it, so changing it lets a reminder go again |
| `label` | the meeting's name in the message |
| `chat` | the group's JID, ending `@g.us`; each message `whatsapp_read` returns carries its chat's JID |
| `meeting` | `{ "nth": 1–5 or "last", "weekday": "sun"…"sat" }`; the first Saturday is the Saturday among days 1–7 |
| `time`, `venue` | printed as written |
| `reminders` | `[{ "daysBefore": 2, "at": "09:00" }, …]`, local times |
| `template` | optional; empty uses the page's default message |
| `enabled` | `false` keeps the rule without sending |
| `override` | optional, one month: `{ "month": "2026-11", "skip": true }`, or a changed `time` or `venue` for that month's meeting |

Template placeholders: `{hijriDate}` (`22 Rabi' al-Thani 1448 AH`), `{date}` (`3rd October 2026`), `{weekday}`, `{when}` (`today`, `tomorrow`, `on Saturday`, counted from the day it is sent), `{time}`, `{venue}`, `{label}`. The default message prints the date line as `📅 *Date:* {weekday}, {hijriDate} ({date})`.

The AMYA rules, with the group JIDs filled in:

```json
[
  {
    "id": "amya-exco",
    "label": "AMYA Exco meeting",
    "chat": "<exco group JID>@g.us",
    "meeting": { "nth": 1, "weekday": "sat" },
    "time": "8:15 PM (shortly after Isha prayer)",
    "venue": "WhatsApp group call or Aso'C Central Masjid",
    "reminders": [{ "daysBefore": 2, "at": "09:00" }, { "daysBefore": 0, "at": "09:00" }],
    "enabled": true
  },
  {
    "id": "amya-general",
    "label": "AMYA general meeting",
    "chat": "<general group JID>@g.us",
    "meeting": { "nth": 1, "weekday": "sun" },
    "time": "11:00 AM",
    "venue": "Aso'C Central Masjid",
    "reminders": [{ "daysBefore": 1, "at": "18:00" }, { "daysBefore": 0, "at": "08:00" }],
    "enabled": true
  }
]
```

Set **Hijri day adjustment** to `1` or `-1` when the local moon sighting puts the month a day off Umm al-Qura; **Preview** shows the result before anything is sent.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`schedule.ts` holds the calendar arithmetic without clocks or I/O. Dates are local calendar dates in the configured zone; a month's meeting is the nth weekday by day of month and weekday together (the repository's cron ORs day-of-month and day-of-week, so it is not used). The Hijri date comes from `Intl` with the `islamic-umalqura` calendar, after adding `hijriOffset` days.

`reminders.ts` runs once a minute. A reminder is due from its local time until `lateWindowMinutes` (default 360) after it, and only while the meeting day lasts, so one missed while the server was down goes out late within that window or not at all. Each send is keyed `ruleId|meetingDate|daysBefore`; the key is written as `sending` before the message goes, then `sent`, so a crash mid-send never sends twice. A failed send releases the key for the next tick; the `maxAttempts`th failure (default 3) records `gave-up` and tells `notifyTo` over WhatsApp. State is `<DSH home>/meeting-reminders/state.json` (mode 0600, atomic replace, writes serialized), with the last 50 attempts in `sent`; keys of meetings more than 60 days past are dropped.

`sender.ts` posts `{ name: 'whatsapp_send', args: { to, text, send_now: true } }` to the command route with the bearer token. The route wraps the tool's answer in `{ result }`, so success is `result.sent === true` and a refusal is `result.error`; anything else counts as a failure. Every send and failure is logged to stderr with the `meeting-reminders:` prefix.

Signed-in routes under `path` (default `/meeting-reminders`): `GET status` (each rule's problems, next meeting with Hijri and English dates, reminder times and states, and recent sends), `POST preview` `{ ruleId }` (the message as it would be sent today), `POST send-now` `{ ruleId, daysBefore?, force? }`. A manual send is recorded under `daysBefore`'s key (default: the next reminder not yet sent), so the scheduled one with that key does not repeat; a key already sent answers 409 unless `force`.

</details>

-----

<a id="model-experience"></a>
## Model Experience

None, as the plugin registers no tools, prompts or Session content and only posts to WhatsApp on a timer.

#### KV Cache effect

None; model requests are unchanged.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The Hijri date is computed, not sighted.** Umm al-Qura plus a fixed day adjustment; the adjustment must be changed by hand when the local sighting differs from one month to the next.
- **One override per rule.** A changed or skipped meeting applies to one named month; a second change waits until the first month has passed.
- **Delivery is the WhatsApp service's word.** `sent` means the sidecar accepted the message; delivery to each member is not checked.
- **Runtime invariant:** No companion is published; the state file is the only record and nothing else observes it independently.
