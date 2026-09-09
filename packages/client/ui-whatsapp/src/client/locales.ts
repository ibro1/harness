/** WhatsApp card dictionaries (link by QR + approve outbound messages). */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'title': 'WhatsApp',
  'description': '关联你的 WhatsApp，让智能体可以查看消息，并在你批准后代发消息。',
  'expand': '展开',
  'collapse': '收起',
  'loading': '加载中…',
  'statusError': '无法连接 WhatsApp 服务。',
  'retry': '重试',
  'link': '关联 WhatsApp',
  'linking': '正在生成二维码…',
  'scanHint': '打开 WhatsApp → 已连接的设备 → 关联设备，扫描此二维码。',
  'qrRefresh': '二维码会自动刷新。',
  'connectedAs': '已关联：{name}',
  'disconnect': '断开连接',
  'disconnecting': '正在断开…',
  'pendingTitle': '待批准的消息',
  'pendingEmpty': '没有等待批准的消息。',
  'pendingTo': '发给 {name}',
  'approve': '批准并发送',
  'discard': '丢弃',
} satisfies Record<string, string>

/** The whatsapp namespace key union. */
export type WhatsAppKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'title': 'WhatsApp',
  'description': 'Link your WhatsApp so the agent can read messages and, with your approval, send them.',
  'expand': 'Expand',
  'collapse': 'Collapse',
  'loading': 'Loading…',
  'statusError': 'Could not reach the WhatsApp service.',
  'retry': 'Retry',
  'link': 'Link WhatsApp',
  'linking': 'Preparing QR…',
  'scanHint': 'Open WhatsApp → Linked devices → Link a device, and scan this code.',
  'qrRefresh': 'The code refreshes automatically.',
  'connectedAs': 'Connected as {name}',
  'disconnect': 'Disconnect',
  'disconnecting': 'Disconnecting…',
  'pendingTitle': 'Pending sends',
  'pendingEmpty': 'No messages waiting for your approval.',
  'pendingTo': 'To {name}',
  'approve': 'Approve & send',
  'discard': 'Discard',
} satisfies Record<WhatsAppKey, string>
