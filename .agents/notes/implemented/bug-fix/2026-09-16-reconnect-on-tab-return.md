# Agent Note: A tab coming back into view is a reconnect signal

Status: implemented

English | [中文](2026-09-16-reconnect-on-tab-return.zh.md)

## Problem

An operator leaves the web GUI open, does something else, and comes back to a `disconnected` badge. Sending a message appears to do nothing — but it is received and processed. Reloading the page by hand shows the connection healthy and the answer already waiting.

`ConnectionController` retries forever with backoff, and `watchBrowserNetwork` feeds it `online`/`offline`, so on paper this recovers itself. It does not, because neither event describes what happened: the network never went down, the **tab** went to sleep. A hidden tab has its timers clamped, and after a few minutes backgrounded they are frozen outright, so the retry that would have replaced the dead socket is not late — it is stopped, with nothing scheduled to start it again.

Sends keep working throughout because they travel over HTTP, independent of the event stream. Only the channel that would have shown the reply is gone, which is why the reply is sitting there the moment the page is rebuilt.

## Decision

`watchPageVisibility` reconnects when the page returns to view:

- **`visibilitychange`** to visible — the ordinary case of switching back to the tab.
- **`pageshow`** — the only signal a back/forward-cache restore gives. That page resumes fully frozen, with a dead socket and no visibility transition at all.

It calls the existing `ConnectionController.reconnect()`, which already resets the attempt counter and aborts the pending delay, so nothing new had to be invented for the recovery itself — only for noticing that recovery was wanted.

**Guarded on not being connected.** A tab switched away from and back within a second has a perfectly good socket, and replacing it would spend a connection generation for nothing.

## Alternatives considered

**Shorten `backoffMaxMs` so a frozen tab recovers sooner on its own.** Does not work: the problem is not the length of the wait but that the timer is not running. It would also make a genuinely unreachable Host retry harder forever, which is the case the 10s cap exists for.

**Ping on an interval and reconnect on a missed beat.** Same defect — the interval is a timer, and it is frozen with everything else. It would also add traffic to every idle session to detect a condition the browser announces for free.

**Reconnect on every visibility change.** Simpler by one condition, and wrong: most returns are to a healthy connection, and each needless reconnect costs a generation and a visible `connecting` flicker.

## Consequences

- Returning to a slept tab recovers without a manual reload.
- A reload is still the only recovery from a page whose JavaScript has itself been evicted; this addresses a live page with a dead socket, which is the reported case.
- The watcher attaches only when both `window` and `document` exist, so it is inert under the node test environment and in any non-browser embedding.
