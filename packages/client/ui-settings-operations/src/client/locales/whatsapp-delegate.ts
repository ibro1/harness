/** Locale bundles for the WhatsApp delegate card. The Chinese bundle keeps the English copy: the card serves one English-speaking owner. */

/** The settings fields that carry a label and a hint. */
export type WadFieldKey =
  | 'enabled' | 'digest' | 'notifyTo' | 'timeZone' | 'transcriptionModel' | 'groqApiKey' | 'model' | 'fallbackModelPick'
  | 'quietSeconds' | 'maxWaitSeconds' | 'ownerActiveMinutes' | 'maxReplies' | 'rateWindowMinutes' | 'contextMessages' | 'maxReplyChars'
  | 'pollSeconds' | 'fallbackCooldownMinutes'

/** The contact form's project fields. */
type WadProjectField = 'workspacePath' | 'repoUrl' | 'deployBranch' | 'liveUrl'

/** Locale keys the card renders. */
export type WadLocaleKey =
  | 'wadTitle' | 'wadDescription' | 'wadInvalid' | 'wadStatusLoading' | 'wadStatusUnknown'
  | 'wadOff' | 'wadWorking' | 'wadPaused' | 'wadNoWhatsApp' | 'wadNoOwnerChat' | 'wadNoGroq' | 'wadGroqFromEnv'
  | 'wadPauseAll' | 'wadResume' | 'wadCheckNow' | 'wadRefresh'
  | 'wadContactOff' | 'wadContactPaused' | 'wadContactWorking' | 'wadContactWaiting' | 'wadContactIdle'
  | 'wadApprovals' | 'wadNoApprovals' | 'wadDraft' | 'wadWhy' | 'wadEditLabel' | 'wadSend' | 'wadEdit' | 'wadDrop' | 'wadSendEdited' | 'wadCancel'
  | 'wadContacts' | 'wadNoContacts' | 'wadAddContact' | 'wadRemoveContact' | 'wadConfirmRemove' | 'wadNewContact'
  | 'wadContact.name' | 'wadContact.enabled' | 'wadContact.numbers' | 'wadContact.numbers.hint' | 'wadContact.number.placeholder'
  | 'wadAddNumber' | 'wadRemoveNumber' | 'wadContact.notes' | 'wadContact.notes.placeholder' | 'wadContact.project.hint'
  | 'wadContact.paused' | 'wadContact.paused.hint'
  | `wadContact.${WadProjectField}` | `wadContact.${WadProjectField}.placeholder`
  | 'wadIssue.name' | 'wadIssue.numbers' | 'wadIssue.number' | 'wadIssue.duplicate'
  | 'wadRecent' | 'wadNoActivity' | 'wadMore' | 'wadShowLog' | 'wadHideLog' | 'wadSettings'
  | 'wadBatch.running' | 'wadBatch.done' | 'wadBatch.handed-off' | 'wadBatch.failed' | 'wadBatch.interrupted'
  | 'wadAction.reply' | 'wadAction.queued' | 'wadAction.no-reply' | 'wadAction.tell-owner' | 'wadAction.refused'
  | `wad.${WadFieldKey}` | `wad.${WadFieldKey}.hint` | 'wad.model.none' | 'wad.fallbackModelPick.none'

/** English dictionary. */
export const wadEn: Record<WadLocaleKey, string> = {
  'wadTitle': 'WhatsApp delegate',
  'wadDescription': 'Answers your work contacts on WhatsApp as you: fixes what they report, replies, and asks you before it commits you to anything.',
  'wadInvalid': 'This value is not valid.',
  'wadStatusLoading': 'Loading…',
  'wadStatusUnknown': 'Could not read the delegate\'s status.',
  'wadOff': 'Off. Switch it on below and save to start answering.',
  'wadWorking': 'Working: reading your contacts\' chats.',
  'wadPaused': 'Paused ({reason}). Nothing is read or sent.',
  'wadNoWhatsApp': 'WhatsApp is not connected to the delegate. Link WhatsApp under Plugins → WhatsApp.',
  'wadNoOwnerChat': 'Set "Your WhatsApp number" below, or drafts that need your OK cannot reach you.',
  'wadNoGroq': 'No Groq key: voice notes will reach the session without a transcript.',
  'wadGroqFromEnv': 'Using the server\'s Groq key',
  'wadPauseAll': 'Pause everything',
  'wadResume': 'Resume',
  'wadCheckNow': 'Check chats now',
  'wadRefresh': 'Refresh',
  'wadContactOff': '{name}: switched off',
  'wadContactPaused': '{name}: paused',
  'wadContactWorking': '{name}: working on their messages now',
  'wadContactWaiting': '{name}: {n} new message(s), waiting for them to finish typing',
  'wadContactIdle': '{name}: nothing new',
  'wadApprovals': 'Waiting for your OK',
  'wadNoApprovals': 'Nothing is waiting for you.',
  'wadDraft': '#{code} to {name}',
  'wadWhy': 'Why it waits: {why}',
  'wadEditLabel': 'Your version',
  'wadSend': 'Send',
  'wadEdit': 'Edit',
  'wadDrop': 'Don\'t send',
  'wadSendEdited': 'Send my version',
  'wadCancel': 'Cancel',
  'wadContacts': 'Contacts',
  'wadNoContacts': 'No contacts yet. Only the people listed here are ever answered.',
  'wadAddContact': 'Add contact',
  'wadRemoveContact': 'Remove contact',
  'wadConfirmRemove': 'Remove {name}? The delegate stops answering them once you save.',
  'wadNewContact': 'New contact',
  'wadContact.name': 'Name',
  'wadContact.enabled': 'Answer this contact',
  'wadContact.numbers': 'WhatsApp numbers',
  'wadContact.numbers.hint': 'Every number they write from, with the country code, such as +234 803 123 4567.',
  'wadContact.number.placeholder': '+234 803 123 4567',
  'wadAddNumber': 'Add number',
  'wadRemoveNumber': 'Remove',
  'wadContact.notes': 'Who they are',
  'wadContact.notes.placeholder': 'Client on the Zenith Carex project. Friendly, writes in English and some Hausa. Prefers short updates.',
  'wadContact.workspacePath': 'Project folder on the server',
  'wadContact.workspacePath.placeholder': '/workspace/zenith-carex',
  'wadContact.repoUrl': 'Repository',
  'wadContact.repoUrl.placeholder': 'https://github.com/you/project',
  'wadContact.deployBranch': 'Branch that deploys',
  'wadContact.deployBranch.placeholder': 'deploy',
  'wadContact.liveUrl': 'Live address',
  'wadContact.liveUrl.placeholder': 'https://app.example.com',
  'wadContact.project.hint': 'Leave the project empty for someone who only needs answers. With a project, the delegate fixes what they report, pushes to that branch and checks the live address.',
  'wadContact.paused': 'Ignore completely',
  'wadContact.paused.hint': 'Their messages are not read at all until you switch this off.',
  'wadIssue.name': 'Give the contact a name.',
  'wadIssue.numbers': 'Add at least one WhatsApp number.',
  'wadIssue.number': 'Number {n} is not a phone number with its country code.',
  'wadIssue.duplicate': 'Another contact has the same name; change one of them.',
  'wadRecent': 'What it did recently',
  'wadNoActivity': 'Nothing handled yet.',
  'wadMore': '…and {n} more',
  'wadShowLog': 'Show full log',
  'wadHideLog': 'Hide full log',
  'wadSettings': 'Settings',
  'wadBatch.running': 'working on it',
  'wadBatch.done': 'done',
  'wadBatch.handed-off': 'left to you',
  'wadBatch.failed': 'failed',
  'wadBatch.interrupted': 'interrupted by a restart',
  'wadAction.reply': 'Replied',
  'wadAction.queued': 'Asked you (#{code})',
  'wadAction.no-reply': 'No reply',
  'wadAction.tell-owner': 'Told you',
  'wadAction.refused': 'Stopped',
  'wad.enabled': 'Delegate on',
  'wad.enabled.hint': 'Off, it reads nothing and sends nothing. When switched on it starts from new messages; old ones are never answered.',
  'wad.digest': 'Send me a summary',
  'wad.digest.hint': 'After it handles a batch, one WhatsApp message to you: what they wrote and what it replied or did.',
  'wad.notifyTo': 'Your WhatsApp number',
  'wad.notifyTo.hint': 'Where drafts and summaries go, and where you answer "ok 7", "edit 7: your text" or "no 7". Your own number makes it your "message yourself" chat. "pause delegate" and "resume delegate" work there too, and "@Name …" passes an instruction to that contact\'s session.',
  'wad.timeZone': 'Time zone',
  'wad.timeZone.hint': 'The session is told the local time in this zone.',
  'wad.quietSeconds': 'Wait after their last message (seconds)',
  'wad.quietSeconds.hint': 'People send several messages in a row; the delegate answers once they stop.',
  'wad.maxWaitSeconds': 'Longest wait (seconds)',
  'wad.maxWaitSeconds.hint': 'Answer after this long even if they keep typing.',
  'wad.ownerActiveMinutes': 'Stay out after you type (minutes)',
  'wad.ownerActiveMinutes.hint': 'When you reply in a chat yourself, the delegate leaves that conversation to you for this long.',
  'wad.maxReplies': 'Most messages to one contact',
  'wad.maxReplies.hint': 'In the time below; more are refused.',
  'wad.rateWindowMinutes': '…in this many minutes',
  'wad.rateWindowMinutes.hint': 'The window for the limit above.',
  'wad.contextMessages': 'Earlier messages it reads',
  'wad.contextMessages.hint': 'How much of the chat the session sees with each batch.',
  'wad.maxReplyChars': 'Longest single message (characters)',
  'wad.maxReplyChars.hint': 'Longer replies are split into several messages.',
  'wad.pollSeconds': 'Check chats every (seconds)',
  'wad.pollSeconds.hint': 'How often new messages are read.',
  'wad.fallbackCooldownMinutes': 'Back-up model rest (minutes)',
  'wad.fallbackCooldownMinutes.hint': 'After the main model fails, the back-up answers for this long.',
  'wad.groqApiKey': 'Groq key for voice notes',
  'wad.groqApiKey.hint': 'Voice notes are transcribed with Groq Whisper. Leave empty to use the server\'s key.',
  'wad.transcriptionModel': 'Transcription model',
  'wad.transcriptionModel.hint': 'Groq\'s Whisper model.',
  'wad.model': 'Model',
  'wad.model.hint': 'The model that reads and answers. Pick a capable coding model: it fixes and deploys.',
  'wad.model.none': 'Harness default',
  'wad.fallbackModelPick': 'Back-up model',
  'wad.fallbackModelPick.hint': 'Used when the main model fails or runs out of quota.',
  'wad.fallbackModelPick.none': 'No back-up',
}

/** Chinese dictionary; English copy. */
export const wadZh: Record<WadLocaleKey, string> = { ...wadEn }
