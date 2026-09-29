// Stall and run-length guard for one CLI run behind the agy and opencode bridges.
//
// The bridges keep the harness's stream alive with heartbeats so a long, busy
// run is not cut off, which also means a run that hangs (a browser call that
// never returns, a page waiting on a captcha) would otherwise go on forever
// with a spinner. The guard watches the CLI's own output: no event for the
// stall window, or a run past the hard cap, kills the process and records why,
// and the bridge ends the stream with that reason as an error the chat shows.
//
//   BRIDGE_STALL_MINUTES    default 10; 0 turns the stall check off
//   BRIDGE_MAX_RUN_MINUTES  default 45; 0 turns the cap off

/** Minutes from an environment variable, or the fallback when unset or invalid. */
function minutes(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

/**
 * Watch one CLI run.
 * @param {import('node:child_process').ChildProcess} proc - the CLI process.
 * @param {string} cli - its name, for the message.
 * @param {() => string | undefined} lastAction - the last tool the run started, if any.
 * @param {(reason: string) => void} onKill - ends the caller's response at once: a killed CLI can
 *   leave children holding its output open, so its exit is not waited for.
 * @returns {{ touch: () => void, stop: () => void, reason: () => string | undefined }}
 *   `touch` on every CLI event; `stop` when the run ends; `reason` is set once the guard killed it.
 */
export function watchRun(proc, cli, lastAction, onKill) {
  const stallMs = minutes('BRIDGE_STALL_MINUTES', 10) * 60_000
  const maxMs = minutes('BRIDGE_MAX_RUN_MINUTES', 45) * 60_000
  const started = Date.now()
  let last = started
  let reason
  const kill = (why) => {
    if (reason !== undefined) return
    // Word characters only: the harness classifies provider errors by words in
    // the message ("fetch", "timeout", "connection" read as retryable), and a
    // stopped run must fail visibly, not be started again on its own.
    const action = lastAction()?.replace(/[^A-Za-z0-9_]/gu, '_')
    reason = `${why}${action === undefined ? '' : ` (last action: ${action})`}. The run was stopped; ask again to retry.`
    console.error(`[${cli}] watchdog: ${reason}`)
    proc.kill('SIGTERM')
    setTimeout(() => { if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL') }, 5_000).unref()
    clearInterval(timer)
    onKill(reason)
  }
  const span = (ms) => ms >= 60_000 ? `${String(Math.round(ms / 60_000))} minutes` : `${String(Math.round(ms / 1000))} seconds`
  const timer = setInterval(() => {
    const now = Date.now()
    if (stallMs > 0 && now - last >= stallMs) kill(`${cli} made no progress for ${span(stallMs)}`)
    else if (maxMs > 0 && now - started >= maxMs) kill(`${cli} ran longer than the ${span(maxMs)} limit`)
  }, 15_000)
  timer.unref()
  return {
    touch: () => { last = Date.now() },
    stop: () => { clearInterval(timer) },
    reason: () => reason,
  }
}
