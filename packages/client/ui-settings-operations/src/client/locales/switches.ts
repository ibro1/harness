/** Locale bundles for the cards of the deployment plugins that have only an on/off switch. */

/** The plugins that report through `/plugin-switch/<id>`, in the order their cards appear. */
export const SWITCH_IDS = ['psd-tools', 'capture', 'outputs', 'composer-tools', 'session-tools', 'agent-tools', 'bg-notify', 'llm-gateway'] as const

/** One switch id. */
export type SwitchId = typeof SWITCH_IDS[number]

/** The facts a plugin may report, each named on the card. */
export const SWITCH_FACTS = [
  'browser', 'photopea', 'lastCall', 'directory', 'maxFile', 'maxTotal', 'maxUpload', 'voice', 'token', 'route', 'tools', 'bridge.agy', 'bridge.opencode',
] as const

/** One fact key. */
export type SwitchFactKey = typeof SWITCH_FACTS[number]

/** Locale keys the switch cards render. */
export type SwitchLocaleKey =
  | `switch.${SwitchId}.title` | `switch.${SwitchId}.description` | `switch.${SwitchId}.off`
  | `switch.fact.${SwitchFactKey}`
  | 'switchOn' | 'switchOff' | 'switchLabel' | 'switchLoading' | 'switchUnknown' | 'switchProblem' | 'switchHealthy'
  | 'switchYes' | 'switchNo' | 'switchNever' | 'switchTest' | 'switchTesting' | 'switchTestOk' | 'switchTestFailed' | 'switchRefresh' | 'switchSaveFailed'

/** English dictionary. */
export const switchesEn: Record<SwitchLocaleKey, string> = {
  'switch.psd-tools.title': 'PSD tools',
  'switch.psd-tools.description': 'Open, edit and export Photoshop files through Photopea, with a preview after every change.',
  'switch.psd-tools.off': 'Off: new sessions get no PSD tools, and calls from open sessions are refused.',
  'switch.capture.title': 'Page capture',
  'switch.capture.description': 'Screenshot a web page and measure it: overflow, broken images, the box of an element.',
  'switch.capture.off': 'Off: new sessions get no capture tool, and calls from open sessions are refused.',
  'switch.outputs.title': 'Session outputs',
  'switch.outputs.description': 'The tool the agent uses to hand you finished files in the session outputs drawer.',
  'switch.outputs.off': 'Off: the agent cannot publish files itself. The drawer still lists what other tools deliver.',
  'switch.composer-tools.title': 'Composer uploads',
  'switch.composer-tools.description': 'Upload files into the session workspace and dictate voice notes from the message box.',
  'switch.composer-tools.off': 'Off: uploads and voice notes are refused. Downloads from the outputs drawer keep working.',
  'switch.session-tools.title': 'Session tools for agy and opencode',
  'switch.session-tools.description': 'Gives the agy and opencode models the outputs, page capture and PSD tools.',
  'switch.session-tools.off': 'Off: agy and opencode sessions see none of these tools.',
  'switch.agent-tools.title': 'Agent Teams tools for agy and opencode',
  'switch.agent-tools.description': 'Lets agy and opencode sessions spawn teammates, message them and share a task board.',
  'switch.agent-tools.off': 'Off: agy and opencode sessions cannot use Agent Teams.',
  'switch.bg-notify.title': 'Background-job notifier',
  'switch.bg-notify.description': 'Wakes a session when a long job it started (a render, a batch) finishes, so the agent reports the result.',
  'switch.bg-notify.off': 'Off: finished jobs no longer wake their session; you have to ask for the result.',
  'switch.llm-gateway.title': 'LLM gateway',
  'switch.llm-gateway.description': 'Lets other services on this server use the agy and opencode models with a dedicated token.',
  'switch.llm-gateway.off': 'Off: every gateway request is refused.',
  'switch.fact.browser': 'Browser',
  'switch.fact.photopea': 'Photopea',
  'switch.fact.lastCall': 'Last call',
  'switch.fact.directory': 'Folder',
  'switch.fact.maxFile': 'Largest file',
  'switch.fact.maxTotal': 'Largest folder per session',
  'switch.fact.maxUpload': 'Largest upload',
  'switch.fact.voice': 'Voice transcription key',
  'switch.fact.token': 'Token',
  'switch.fact.route': 'Route',
  'switch.fact.tools': 'Tools',
  'switch.fact.bridge.agy': 'agy bridge',
  'switch.fact.bridge.opencode': 'opencode bridge',
  'switchOn': 'On',
  'switchOff': 'Off',
  'switchLabel': 'Switch this plugin on or off',
  'switchLoading': 'Loading…',
  'switchUnknown': 'Could not read this plugin’s status.',
  'switchProblem': 'Not working:',
  'switchHealthy': 'Ready',
  'switchYes': 'set',
  'switchNo': 'not set',
  'switchNever': 'none since the last restart',
  'switchTest': 'Test',
  'switchTesting': 'Testing…',
  'switchTestOk': 'Test passed:',
  'switchTestFailed': 'Test failed:',
  'switchRefresh': 'Refresh',
  'switchSaveFailed': 'The switch was not saved:',
}

/** Simplified Chinese dictionary. */
export const switchesZh: Record<SwitchLocaleKey, string> = {
  'switch.psd-tools.title': 'PSD 工具',
  'switch.psd-tools.description': '通过 Photopea 打开、编辑和导出 Photoshop 文件，每次修改后生成预览。',
  'switch.psd-tools.off': '关闭后：新会话不再获得 PSD 工具，已打开会话的调用会被拒绝。',
  'switch.capture.title': '页面截图',
  'switch.capture.description': '截取网页并测量：横向溢出、加载失败的图片、元素的位置。',
  'switch.capture.off': '关闭后：新会话不再获得截图工具，已打开会话的调用会被拒绝。',
  'switch.outputs.title': '会话产出',
  'switch.outputs.description': '智能体把完成的文件放进会话产出抽屉所用的工具。',
  'switch.outputs.off': '关闭后：智能体无法自行发布文件，抽屉仍会列出其他工具交付的文件。',
  'switch.composer-tools.title': '输入框上传',
  'switch.composer-tools.description': '从输入框把文件上传到会话工作区，并录制语音转文字。',
  'switch.composer-tools.off': '关闭后：上传和语音会被拒绝，产出抽屉的下载不受影响。',
  'switch.session-tools.title': 'agy 和 opencode 的会话工具',
  'switch.session-tools.description': '让 agy 和 opencode 模型使用会话产出、页面截图和 PSD 工具。',
  'switch.session-tools.off': '关闭后：agy 和 opencode 会话看不到这些工具。',
  'switch.agent-tools.title': 'agy 和 opencode 的 Agent Teams 工具',
  'switch.agent-tools.description': '让 agy 和 opencode 会话创建队友、给队友发消息并共享任务板。',
  'switch.agent-tools.off': '关闭后：agy 和 opencode 会话无法使用 Agent Teams。',
  'switch.bg-notify.title': '后台任务通知',
  'switch.bg-notify.description': '会话启动的长任务（渲染、批处理）完成时唤醒该会话，让智能体汇报结果。',
  'switch.bg-notify.off': '关闭后：任务完成不再唤醒会话，需要你主动询问结果。',
  'switch.llm-gateway.title': 'LLM 网关',
  'switch.llm-gateway.description': '让本服务器上的其他服务凭专用令牌使用 agy 和 opencode 模型。',
  'switch.llm-gateway.off': '关闭后：网关的所有请求都会被拒绝。',
  'switch.fact.browser': '浏览器',
  'switch.fact.photopea': 'Photopea',
  'switch.fact.lastCall': '最近一次调用',
  'switch.fact.directory': '文件夹',
  'switch.fact.maxFile': '单个文件上限',
  'switch.fact.maxTotal': '每个会话的文件夹上限',
  'switch.fact.maxUpload': '上传上限',
  'switch.fact.voice': '语音转写密钥',
  'switch.fact.token': '令牌',
  'switch.fact.route': '路由',
  'switch.fact.tools': '工具',
  'switch.fact.bridge.agy': 'agy 桥接',
  'switch.fact.bridge.opencode': 'opencode 桥接',
  'switchOn': '开启',
  'switchOff': '关闭',
  'switchLabel': '开启或关闭此插件',
  'switchLoading': '加载中…',
  'switchUnknown': '无法读取此插件的状态。',
  'switchProblem': '无法工作：',
  'switchHealthy': '就绪',
  'switchYes': '已设置',
  'switchNo': '未设置',
  'switchNever': '自上次重启以来没有',
  'switchTest': '测试',
  'switchTesting': '测试中…',
  'switchTestOk': '测试通过：',
  'switchTestFailed': '测试失败：',
  'switchRefresh': '刷新',
  'switchSaveFailed': '开关未保存：',
}
