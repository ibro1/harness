/**
 * Operations settings pages, node half. The empty apply exists so the plugin
 * appears in the host cordis.yml / Loader; the browser half owns the pages
 * through exports["./client"], discovered from the package.json dsh.client
 * declaration. The `dokploy`, `cloudflare` and `postgres` namespaces the pages
 * edit are registered by those plugins, so this package registers none.
 */

/** Host plugin body — no host-side behavior for this surface plugin. */
export function apply(): void {}
