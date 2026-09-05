/** Shell chrome and General-nav dictionaries; feature rows own their copy. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'trigger': '设置',
  'title': '设置',
  'signOut': '退出登录',
  'account.sessions.title': '会话',
  'account.sessions.detail': '已登录此账户的浏览器。可撤销某个会话，或登出其他所有浏览器。',
  'account.gitKey.title': 'Git 访问密钥',
  'account.gitKey.detail': 'Agent 访问你仓库所用的 SSH 公钥。可添加为部署密钥或账户密钥。',
  'account.open': '打开 ↗',
  'close': '关闭',
  'openDocument': '打开配置文件',
  'openDocument.error': '无法打开配置文件',
  'general.nav': '通用设置',
  'connection.error': '连接异常',
  'connection.retry': '立即重连',
  'connection.connecting': '连接中',
  'connection.connected': '连接成功',
  'connection.reconnect': '连接异常，点击立即重连',
  'connection.restart': '连接中，点击立即重连',
} satisfies Record<string, string>

/** The settings namespace key union. */
export type SettingsKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'trigger': 'Settings',
  'title': 'Settings',
  'signOut': 'Sign out',
  'account.sessions.title': 'Sessions',
  'account.sessions.detail': 'Browsers signed in to this account. Revoke one, or sign out every other browser.',
  'account.gitKey.title': 'Git access key',
  'account.gitKey.detail': 'The SSH public key agents use to reach your repositories. Add it as a deploy key or an account key.',
  'account.open': 'Open ↗',
  'close': 'Close',
  'openDocument': 'Open configuration file',
  'openDocument.error': 'Could not open configuration file',
  'general.nav': 'General',
  'connection.error': 'Disconnected',
  'connection.retry': 'Reconnect now',
  'connection.connecting': 'Connecting',
  'connection.connected': 'Connected',
  'connection.reconnect': 'Disconnected, reconnect now',
  'connection.restart': 'Connecting, restart now',
} satisfies Record<SettingsKey, string>
