/** Locale bundles for the Dokploy, Cloudflare and Postgres settings pages. */

import type { SettingsFormLabels } from '@deepseek-ai/dsh-client-ui-primitives'

/** Locale keys the pages render. */
export type OperationsSettingsLocaleKey =
  | 'dokployTitle' | 'dokployDescription' | 'dokployServers' | 'dokployServersHint' | 'dokployInvalid' | 'dokployServersPlaceholder'
  | 'postgresTitle' | 'postgresDescription' | 'postgresDatabases' | 'postgresDatabasesHint' | 'postgresInvalid' | 'postgresDatabasesPlaceholder'
  | 'cloudflareTitle' | 'cloudflareDescription' | 'cloudflareZones' | 'cloudflareZonesHint' | 'cloudflareInvalid' | 'cloudflareZonesPlaceholder'
  | 'cloudflareAccounts' | 'cloudflareAccountsHint' | 'cloudflareAccountsInvalid' | 'cloudflareAccountsPlaceholder'
  | 'overridden' | 'reset' | 'readOnly' | 'unavailable'
  | 'save' | 'saving' | 'saveFailed'

/** English copy. */
export const en: Record<OperationsSettingsLocaleKey, string> = {
  dokployTitle: 'Dokploy',
  dokployDescription: 'The Dokploy servers an agent may query and deploy through.',
  dokployServers: 'Servers',
  dokployServersHint: 'A JSON array of servers, each with a name, a url, and either apiKeyEnv (the name of an environment variable holding the key — kept out of settings) or apiKey (the key itself, stored here).',
  dokployInvalid: 'Not a valid servers list: a JSON array of objects, each with a string name and url, and either apiKeyEnv or apiKey.',
  dokployServersPlaceholder: '[\n  { "name": "main", "url": "https://server.example.com", "apiKey": "your-dokploy-key" }\n]',
  cloudflareTitle: 'Cloudflare',
  cloudflareDescription: 'The Cloudflare zones an agent may purge cache and edit DNS on.',
  cloudflareZones: 'Zones',
  cloudflareZonesHint: 'A JSON array of zones, each with a name, a zoneId, and either apiTokenEnv (the name of an environment variable holding the token — kept out of settings) or apiToken (the token itself, stored here).',
  cloudflareInvalid: 'Not a valid zones list: a JSON array of objects, each with a string name and zoneId, and either apiTokenEnv or apiToken.',
  cloudflareZonesPlaceholder: '[\n  { "name": "site", "zoneId": "your-cloudflare-zone-id", "apiToken": "your-cloudflare-token" }\n]',
  cloudflareAccounts: 'Accounts (optional)',
  cloudflareAccountsHint: 'Only needed to add a domain to an account or list every zone on it. A JSON array of accounts, each with a name, an id, and either apiTokenEnv or apiToken. Each token needs Zone → Zone → Edit across the account, which reaches every domain in it — the per-zone tokens above do not, so leave this empty unless you want zone creation.',
  cloudflareAccountsInvalid: 'Not a valid accounts list: a JSON array of objects, each with a string name and id, and either apiTokenEnv or apiToken. Leave it empty to turn the account tools off.',
  cloudflareAccountsPlaceholder: '[\n  { "name": "main", "id": "your-cloudflare-account-id", "apiToken": "your-account-scoped-token" }\n]',
  postgresTitle: 'Postgres',
  postgresDescription: 'The Postgres databases an agent may read. Reads are enforced read-only by the server; a database must opt in before an agent can write to it.',
  postgresDatabases: 'Databases',
  postgresDatabasesHint: 'A JSON array of databases, each with a name and either dsnEnv (the name of an environment variable holding the connection string — kept out of settings) or dsn (the connection string itself, stored here). Optional per database: readOnly (defaults to true; set it to false to allow writes) and statementTimeoutMs (defaults to 15000).',
  postgresInvalid: 'Not a valid databases list: a JSON array of objects, each with a string name, either dsnEnv or dsn, an optional boolean readOnly, and an optional positive statementTimeoutMs.',
  postgresDatabasesPlaceholder: '[\n  { "name": "main", "dsnEnv": "PG_DSN_MAIN", "readOnly": true }\n]',
  overridden: 'Overridden',
  reset: 'Reset to default',
  readOnly: 'This deployment stores settings read-only.',
  unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
  save: 'Save',
  saving: 'Saving…',
  saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
}

/** Simplified Chinese copy. */
export const zh: Record<OperationsSettingsLocaleKey, string> = {
  dokployTitle: 'Dokploy',
  dokployDescription: 'Agent 可查询并通过其部署的 Dokploy 服务器。',
  dokployServers: '服务器',
  dokployServersHint: '服务器的 JSON 数组，每项包含 name、url，以及 apiKeyEnv（保存密钥的环境变量名，密钥不写入设置）或 apiKey（直接填写密钥，将保存在此处）。',
  dokployInvalid: '不是有效的服务器列表：应为对象的 JSON 数组，每项需包含字符串 name 和 url，以及 apiKeyEnv 或 apiKey 之一。',
  dokployServersPlaceholder: '[\n  { "name": "main", "url": "https://server.example.com", "apiKey": "your-dokploy-key" }\n]',
  cloudflareTitle: 'Cloudflare',
  cloudflareDescription: 'Agent 可清除缓存并修改 DNS 的 Cloudflare 站点（zone）。',
  cloudflareZones: '站点',
  cloudflareZonesHint: '站点的 JSON 数组，每项包含 name、zoneId，以及 apiTokenEnv（保存令牌的环境变量名，令牌不写入设置）或 apiToken（直接填写令牌，将保存在此处）。',
  cloudflareInvalid: '不是有效的站点列表：应为对象的 JSON 数组，每项需包含字符串 name 和 zoneId，以及 apiTokenEnv 或 apiToken 之一。',
  cloudflareZonesPlaceholder: '[\n  { "name": "site", "zoneId": "your-cloudflare-zone-id", "apiToken": "your-cloudflare-token" }\n]',
  cloudflareAccounts: '账户（可选）',
  cloudflareAccountsHint: '仅在向账户添加域名或列出账户下全部站点时需要。账户的 JSON 数组，每项包含 name、id，以及 apiTokenEnv 或 apiToken。每个令牌都需要整个账户的 Zone → Zone → Edit 权限，可触及该账户下的每一个域名——上面的按站点令牌则不会；除非要创建站点，否则请留空。',
  cloudflareAccountsInvalid: '不是有效的账户列表：应为对象的 JSON 数组，每项需包含字符串 name 和 id，以及 apiTokenEnv 或 apiToken 之一。留空即关闭账户相关工具。',
  cloudflareAccountsPlaceholder: '[\n  { "name": "main", "id": "your-cloudflare-account-id", "apiToken": "your-account-scoped-token" }\n]',
  postgresTitle: 'Postgres',
  postgresDescription: 'Agent 可读取的 Postgres 数据库。读取由服务器强制为只读；数据库需显式开启后 Agent 才能写入。',
  postgresDatabases: '数据库',
  postgresDatabasesHint: '数据库的 JSON 数组，每项包含 name，以及 dsnEnv（保存连接串的环境变量名，连接串不写入设置）或 dsn（直接填写连接串，将保存在此处）。每项可选：readOnly（默认为 true；设为 false 才允许写入）和 statementTimeoutMs（默认 15000）。',
  postgresInvalid: '不是有效的数据库列表：应为对象的 JSON 数组，每项需包含字符串 name，以及 dsnEnv 或 dsn 之一；readOnly 可选且为布尔值，statementTimeoutMs 可选且为正数。',
  postgresDatabasesPlaceholder: '[\n  { "name": "main", "dsnEnv": "PG_DSN_MAIN", "readOnly": true }\n]',
  overridden: '已覆盖',
  reset: '恢复默认',
  readOnly: '本部署的设置为只读。',
  unavailable: '该插件当前未加载，暂时无法配置。',
  save: '保存',
  saving: '保存中…',
  saveFailed: '本部署没有接受这些值，已保留供你修改。',
}

/**
 * The shared form frame's copy, drawn from this dictionary.
 * @param t - the bound translator for this namespace.
 * @returns the labels the form frame renders.
 */
export function formLabels(t: (key: OperationsSettingsLocaleKey) => string): SettingsFormLabels {
  return { unavailable: t('unavailable'), readOnly: t('readOnly'), saveFailed: t('saveFailed'), save: t('save'), saving: t('saving') }
}
