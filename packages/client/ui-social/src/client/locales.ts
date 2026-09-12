/**
 * Social card dictionaries: what the agent can post to, which credentials are
 * about to lapse, which targets skip the approval prompt, and disconnecting an
 * account.
 */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'title': '社交账号',
  'description': '查看智能体可以发布到哪些账号、主页和频道，以及其中哪些即将失效。',
  'expand': '展开',
  'collapse': '收起',
  'loading': '加载中…',
  'statusError': '无法读取社交账号状态。',
  'retry': '重试',
  'emptyTitle': '还没有连接任何社交账号。',
  'emptyHow': '在对话中让智能体登录你要使用的平台，它会走完授权流程。凭据不在这里填写。',
  'targetsHeading': '可发布的目标',
  'acceptsLabel': '接受：',
  'acceptsText': '文本',
  'acceptsImage': '图片',
  'acceptsVideo': '视频',
  'acceptsNothing': '无',
  'stateReady': '可用',
  'stateWarning': '即将失效',
  'stateBlocked': '不可用',
  'exemptHeading': '无需批准即可发布',
  'exemptHint': '发布到这些目标不会征求你的批准。这是组合配置中按 id 逐个设置的。',
  'disconnect': '断开连接',
  'disconnectAsk': '断开 {provider} 的连接？这会删除已保存的凭据，之后需要重新让智能体登录。',
  'disconnectShared': '同一份凭据也在为 {providers} 提供授权，断开会一并影响它们。',
  'confirm': '确认断开',
  'cancel': '取消',
  'disconnecting': '正在断开…',
  'disconnectUnavailable': '无法从这里断开：没有找到对应的凭据记录，请让智能体处理，或在此插件的 credentialKeys 配置中指明。',
  'disconnectFailed': '断开失败：{reason}',
  'disconnectDone': '已断开 {provider}，并删除凭据 {key}。',
  'disconnectNothing': '{provider} 没有已保存的凭据，无需断开。',
} satisfies Record<string, string>

/** The social namespace key union. */
export type SocialKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'title': 'Social accounts',
  'description': 'See what the agent can post to, and whether any of it is about to stop working.',
  'expand': 'Expand',
  'collapse': 'Collapse',
  'loading': 'Loading…',
  'statusError': 'Could not read the social account status.',
  'retry': 'Retry',
  'emptyTitle': 'No social account is connected yet.',
  'emptyHow': 'Ask the agent in chat to sign in to the platform you want, and it will walk the authorization flow. Credentials are not entered here.',
  'targetsHeading': 'Where it can post',
  'acceptsLabel': 'Accepts:',
  'acceptsText': 'text',
  'acceptsImage': 'images',
  'acceptsVideo': 'video',
  'acceptsNothing': 'nothing',
  'stateReady': 'Ready',
  'stateWarning': 'Expiring',
  'stateBlocked': 'Not ready',
  'exemptHeading': 'Posts without asking you',
  'exemptHint': 'Publishing to these targets skips the approval prompt. It is set in the composition, one exact id at a time.',
  'disconnect': 'Disconnect',
  'disconnectAsk': 'Disconnect {provider}? This removes the stored credential, and reconnecting means asking the agent to sign in again.',
  'disconnectShared': 'The same credential also authorizes {providers}, which this disconnects too.',
  'confirm': 'Yes, disconnect',
  'cancel': 'Cancel',
  'disconnecting': 'Disconnecting…',
  'disconnectUnavailable': 'Cannot disconnect from here: no stored credential record is addressed to this provider. Ask the agent, or name the record in this plugin\'s credentialKeys config.',
  'disconnectFailed': 'Disconnect failed: {reason}',
  'disconnectDone': 'Disconnected {provider} and removed the credential {key}.',
  'disconnectNothing': '{provider} had no stored credential, so there was nothing to remove.',
} satisfies Record<SocialKey, string>
