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
} satisfies Record<ComposerToolsKey, string>
