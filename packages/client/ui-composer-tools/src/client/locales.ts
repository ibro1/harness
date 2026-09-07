/** Composer-tools dictionaries (workspace file upload). */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'upload': '上传到工作区',
  'uploading': '正在上传 {name}… {pct}%',
  'done': '已上传 {name} 至工作区',
  'error': '上传失败：{message}',
  'errorHttp': '上传失败（HTTP {status}）',
  'errorNetwork': '上传失败：网络错误',
} satisfies Record<string, string>

/** The composer-tools namespace key union. */
export type ComposerToolsKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'upload': 'Upload to workspace',
  'uploading': 'Uploading {name}… {pct}%',
  'done': 'Uploaded {name} to the workspace',
  'error': 'Upload failed: {message}',
  'errorHttp': 'Upload failed (HTTP {status})',
  'errorNetwork': 'Upload failed: network error',
} satisfies Record<ComposerToolsKey, string>
