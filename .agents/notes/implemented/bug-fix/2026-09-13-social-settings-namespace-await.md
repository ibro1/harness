# Agent Note: The social settings card needs an awaited settings scope, not a sampled one

Status: implemented

English | [中文](2026-09-13-social-settings-namespace-await.zh.md)

## Problem

`tool-social` shipped with its Settings → Plugins card unreachable. The plugin activated, both `/social/*` routes answered, the browser half was composed, and the card never appeared in any deployment.

The Settings → Plugins tab dispatches a card only when its key is also a settings namespace the Host serves — the intersection of two ledgers, which `ConfigurablePluginsTabController` computes. `tool-social` served its half with:

```ts
ctx.get('settings')?.register('social', z.object({}) …, { base: {} })
```

The settings service is file-backed and resolves its `Service.init` off disk, so it is not in the service store when a plugin composed alongside it applies. `ctx.get` read `undefined` on every boot and the optional call registered nothing. Nothing failed, nothing logged, and the only visible symptom was an absent card — the failure mode the seam's own listing rules call worse than a loud refusal.

A probe in the built plugin, booted through the shipped Web profile with `deploy/plugins/social.cordis.yml`, printed `settings = UNDEFINED` at `apply`.

## Decision

Await the service in a scope rather than sampling the store once:

```ts
ctx.inject(['settings'], (settingsCtx: Context) => {
  settingsCtx.settings.register('social', z.object({}) …, { base: {} })
})
```

`settings` stays out of `inject`. The property it was chosen for is still the right one — a composition with no settings service should lose the card, not the tools and not the catalog — and a scoped inject keeps exactly that property while waiting for the service instead of racing it. This is the shape `bash-local`, `pwsh-local`, `agent-presets`, and `ui-theme` already use for the same service.

`approval` and `credentials` keep `ctx.get`, which remains correct for them: each is read inside an operation that can refuse in front of a person, long after activation settles.

### Verification

`tests/settings-card.spec.ts` composes a real `Context`, applies the plugin with no settings service present, asserts the tools registered and the namespace did not, then provides the service and asserts the namespace arrives. It fails against the `ctx.get` form and passes against the scoped inject; the stub contexts in the other two suites cannot express the distinction, because a stub that already holds the service when `apply` runs is the one condition no real boot is in.

## Alternatives considered

**Declare `settings` in `inject`.** What `deploy/plugins/whatsapp.mjs` does, and its comment calls the dependency load-bearing. It is correct there — that plugin's entire purpose is the card. Here it would tie the model-facing tools to a service they never touch, so a composition that omits settings would lose `social_post` as well as the card.

**Register the namespace from the browser half.** The served set is a Host fact by construction; a client package asserting it would let a card list itself in a deployment that does not compose its plugin.

## Consequences

- The card is listed once the settings service finishes loading, which is the same instant every other settings surface becomes available.
- A composition with no settings service still gets the tools and the routes, and no card. That is now the only way to lose the card.
- The general hazard stands wherever a plugin samples an async-init service at `apply`: the seam is silent by construction, and only a context where the service lands afterwards can catch it. `ctx.get` remains right for use-site reads and wrong for activation-time registration.
