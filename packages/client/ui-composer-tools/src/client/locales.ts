/** Composer-tools dictionaries (workspace file upload + voice prompting). */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'upload': '上传文件到工作区',
  'pct': '{pct}%',
  'uploadFailed': '上传失败',
  'remove': '移除 {name}',
  'voice.record': '语音输入',
  'voice.stop': '停止录音',
  'voice.recording': '正在录音…点击停止',
  'voice.transcribing': '正在转写…',
  'voice.error': '语音失败：{message}',
  'voice.errorMic': '未获得麦克风权限',
  'voice.errorKey': '语音转写未配置（缺少 Groq 密钥）',
  'voice.errorNetwork': '语音失败：网络错误',
  'voice.empty': '未检测到语音',
  'outputs': '会话文件',
  'outputs.title': '本次会话的产物',
  'outputs.close': '关闭',
  'outputs.refresh': '刷新',
  'outputs.loading': '加载中…',
  'outputs.error': '无法加载文件',
  'outputs.empty': '暂无文件——本次会话尚未生成任何内容。',
  'outputs.mb': '{n} MB',
  'outputs.kb': '{n} KB',
  'outputs.b': '{n} B',
  'outputs.download': '下载 {name}',
} satisfies Record<string, string>

/** The composer-tools namespace key union. */
export type ComposerToolsKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'upload': 'Upload files to workspace',
  'pct': '{pct}%',
  'uploadFailed': 'Upload failed',
  'remove': 'Remove {name}',
  'voice.record': 'Voice input',
  'voice.stop': 'Stop recording',
  'voice.recording': 'Recording… click to stop',
  'voice.transcribing': 'Transcribing…',
  'voice.error': 'Voice failed: {message}',
  'voice.errorMic': 'Microphone access denied',
  'voice.errorKey': 'Voice transcription is not configured (no Groq key)',
  'voice.errorNetwork': 'Voice failed: network error',
  'voice.empty': 'No speech detected',
  'outputs': 'Session files',
  'outputs.title': 'Session outputs',
  'outputs.close': 'Close',
  'outputs.refresh': 'Refresh',
  'outputs.loading': 'Loading…',
  'outputs.error': 'Could not load files',
  'outputs.empty': 'No files yet — the agent has not produced anything in this session.',
  'outputs.mb': '{n} MB',
  'outputs.kb': '{n} KB',
  'outputs.b': '{n} B',
  'outputs.download': 'Download {name}',
} satisfies Record<ComposerToolsKey, string>
