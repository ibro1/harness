/**
 * Render a vertical product video from the listing's images (and its demo
 * video, when it has one) and a voiceover script, with ffmpeg only, cut the
 * way TikTok creators cut:
 *
 * - The picture changes every couple of seconds. Each spoken line is split
 *   into shots, and the shots rotate through every image and three framings:
 *   the whole product over a blurred fill, the frame filled edge to edge, and
 *   a close crop panning across a detail. Every shot opens with a short zoom
 *   punch. Every third shot is a clip of the demo video, when there is one.
 * - The spoken words appear as they are said, two or three at a time, low in
 *   the frame; the line's short caption sits at the top as a label, the hook
 *   over the first line and the end card over the last.
 *
 * Shots are rendered silent and joined; one last pass lays the voice and the
 * text over them. Each line's time on screen is its spoken length, so the
 * picture follows the voice and nothing is time-stretched.
 */

import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** One spoken line and what the screen shows while it plays. */
export interface ScriptLine {
  /** What the voice says. */
  voice: string
  /** What the screen says: shorter than the voice, at most a few words. */
  caption: string
}

/** Everything one video is made from. */
export interface RenderJob {
  /** Local image files; shots use them in turn. */
  images: string[]
  /** The listing's demo video, as a local file, when it has one. */
  video?: string
  /** The spoken lines, in order; at least one. */
  lines: ScriptLine[]
  /** Headline over the first segment: the hook. */
  hook: string
  /** Headline over the last segment, such as the price and where to tap. */
  endCard: string
  /** Directory for intermediate files. */
  workDir: string
  /** The finished MP4. */
  outPath: string
}

/** The programs and voice the renderer uses. */
export interface RenderTools {
  ffmpeg: string
  ffprobe: string
  /** Bold font file for the burned-in text. */
  font: string
  /** Speak one line into a WAV file. */
  speak: (text: string, outWav: string, signal: AbortSignal) => Promise<void>
  /**
   * Speak every line in one request, with a pause between lines, into one WAV file. Optional: when given, the
   * renderer splits that file at its pauses, and falls back to one request per line only when it cannot find a
   * pause for every boundary. One request per video matters on quotas counted in requests.
   */
  speakAll?: (lines: string[], outWav: string, signal: AbortSignal) => Promise<void>
}

/** Output size and frame rate: TikTok's full-screen vertical format. */
const WIDTH = 1080
const HEIGHT = 1920
const FPS = 30

/** Silence after each line, in seconds, so cuts do not clip the last word. */
const LINE_GAP = 0.3
/** How long the end card stays after the last word, in seconds. */
const END_HOLD = 1.2
/** Characters per label line at the label size. */
const LABEL_CHARS = 24
/** Characters per headline line at the headline size. */
const HEADLINE_CHARS = 17
/** About how long one shot lasts, in seconds. */
const SHOT_SECONDS = 1.8
/** Most characters in one on-screen group of spoken words. */
const WORDS_CHARS = 16

/** Quietest level counted as a pause, and the shortest pause that can separate two lines. */
const SILENCE_DB = -35
const SILENCE_MIN = 0.25

/** ffmpeg's stderr, where filters such as silencedetect report. */
function runStderr(program: string, args: string[], signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(program, args, { signal, maxBuffer: 16 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error) reject(new Error(`${program} failed: ${(stderr || error.message).trim().split('\n').slice(-3).join(' ')}`))
      else resolve(stderr)
    })
  })
}

/** A stretch of a recording, in seconds. */
export interface Span {
  start: number
  end: number
}

/**
 * Where each line lies in one recording of several: the longest pauses, one per boundary, separate the lines, and
 * each line runs from the end of the pause before it to the start of the pause after it.
 * @param pauses - every pause inside the speech.
 * @param lines - how many lines were spoken.
 * @param total - the recording's length.
 * @returns one span per line, or undefined when there are fewer pauses than boundaries.
 */
export function lineSpans(pauses: readonly Span[], lines: number, total: number): Span[] | undefined {
  if (lines < 1 || pauses.length < lines - 1) return undefined
  const gaps = [...pauses].sort((a, b) => (b.end - b.start) - (a.end - a.start)).slice(0, lines - 1).sort((a, b) => a.start - b.start)
  return Array.from({ length: lines }, (_, i) => ({
    start: i === 0 ? 0 : gaps[i - 1]?.end ?? 0,
    end: i === lines - 1 ? total : gaps[i]?.start ?? total,
  }))
}

/**
 * Speak all lines in one request and cut the recording into one file per line.
 * @returns the line files, or undefined when the pauses could not be found and each line must be spoken alone.
 */
async function speakInOne(job: RenderJob, tools: RenderTools, signal: AbortSignal): Promise<string[] | undefined> {
  if (tools.speakAll === undefined || job.lines.length < 2) return undefined
  const full = join(job.workDir, 'all-lines.wav')
  await tools.speakAll(job.lines.map(l => l.voice), full, signal)
  const detect = `silencedetect=noise=${String(SILENCE_DB)}dB:d=${String(SILENCE_MIN)}`
  const report = await runStderr(tools.ffmpeg, ['-hide_banner', '-i', full, '-af', detect, '-f', 'null', '-'], signal)
  const starts = [...report.matchAll(/silence_start: ([\d.]+)/gu)].map(m => Number(m[1]))
  const ends = [...report.matchAll(/silence_end: ([\d.]+)/gu)].map(m => Number(m[1]))
  const total = await duration(tools, full, signal)
  // Pauses inside the speech only: not the silence before the first word or after the last.
  const pauses = starts.map((start, i) => ({ start, end: ends[i] ?? total })).filter(p => p.start > 0.2 && p.end < total - 0.2)
  const spans = lineSpans(pauses, job.lines.length, total)
  if (spans === undefined) return undefined
  const files: string[] = []
  for (const [i, span] of spans.entries()) {
    const file = join(job.workDir, `line-${String(i)}.wav`)
    await run(tools.ffmpeg, ['-y', '-loglevel', 'error', '-i', full, '-ss', span.start.toFixed(3), '-to', span.end.toFixed(3), file], signal)
    files.push(file)
  }
  return files
}

function run(program: string, args: string[], signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(program, args, { signal, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${program} failed: ${(stderr || error.message).trim().split('\n').slice(-3).join(' ')}`))
      else resolve(stdout)
    })
  })
}

/**
 * Break text into lines of at most `width` characters at word boundaries; a longer word stands alone.
 * @param text - the text.
 * @param width - most characters per line.
 * @returns the lines.
 */
export function wrap(text: string, width: number): string[] {
  const lines: string[] = []
  let current = ''
  for (const word of text.trim().split(/\s+/u)) {
    if (word === '') continue
    if (current === '') current = word
    else if (current.length + 1 + word.length <= width) current += ` ${word}`
    else { lines.push(current); current = word }
  }
  if (current !== '') lines.push(current)
  return lines
}

/**
 * Seconds of audio in a file.
 * @param tools - the renderer's programs.
 * @param file - the media file.
 * @param signal - cancels the probe.
 * @returns the duration.
 */
async function duration(tools: RenderTools, file: string, signal: AbortSignal): Promise<number> {
  const out = await run(tools.ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], signal)
  const seconds = Number.parseFloat(out.trim())
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`could not read the length of ${file}`)
  return seconds
}

/** ffmpeg filter-option value with the characters that end it escaped. */
function filterPath(path: string): string {
  return path.replace(/\\/gu, '\\\\').replace(/:/gu, '\\:').replace(/'/gu, "\\'")
}

/**
 * Drawtext filters for a block of lines, centred horizontally and shown for a stretch of time, each line read from
 * its own file so no text is ever parsed as filter syntax.
 * @returns the filters, joined with commas.
 */
async function textBlock(
  dir: string, name: string, lines: string[], font: string, size: number, top: number, color: string,
  when: { from: number; to: number }, box: boolean,
): Promise<string> {
  const filters: string[] = []
  for (const [i, line] of lines.entries()) {
    const file = join(dir, `${name}-${String(i)}.txt`)
    await writeFile(file, line)
    const look = box
      ? `:box=1:boxcolor=black@0.55:boxborderw=${String(Math.round(size / 3))}`
      : `:borderw=${String(Math.round(size / 10))}:bordercolor=black@0.9`
    filters.push(`drawtext=fontfile='${filterPath(font)}':textfile='${filterPath(file)}':fontsize=${String(size)}:fontcolor=${color}${look}`
      + `:x=(w-text_w)/2:y=${String(Math.round(top + i * size * (box ? 1.5 : 1.22)))}`
      // Half-open, so the frame on a boundary shows only the text that starts there.
      + `:enable='gte(t,${when.from.toFixed(3)})*lt(t,${when.to.toFixed(3)})'`)
  }
  return filters.join(',')
}

/**
 * The spoken words in on-screen groups of two or three, each timed by its share of the line's characters.
 * @param text - what the voice says.
 * @param seconds - how long it takes to say.
 * @returns the groups with their start and end within the line.
 */
export function wordGroups(text: string, seconds: number): { text: string; start: number; end: number }[] {
  const groups: string[] = []
  let current: string[] = []
  for (const word of text.trim().split(/\s+/u).filter(w => w !== '')) {
    const joined = [...current, word].join(' ')
    if (current.length > 0 && (current.length >= 3 || joined.length > WORDS_CHARS)) { groups.push(current.join(' ')); current = [word] }
    else current.push(word)
    // A group ends at a sentence or clause end, as speech pauses there.
    if (/[.,!?;:]$/u.test(word)) { groups.push(current.join(' ')); current = [] }
  }
  if (current.length > 0) groups.push(current.join(' '))
  const weight = groups.reduce((n, g) => n + g.length + 2, 0)
  let at = 0
  return groups.map((g) => {
    const length = seconds * (g.length + 2) / weight
    const group = { text: g, start: at, end: at + length }
    at += length
    return group
  })
}

/** How one shot frames its picture. */
export type Framing = 'whole' | 'fill' | 'detail' | 'clip'

/** One shot: its length, which image it shows (-1 for the demo video) and how it frames it. */
export interface Shot {
  seconds: number
  image: number
  framing: Framing
}

/**
 * The shots for the whole video: how many per line, which picture each uses and how it frames it.
 * @param lineSeconds - each line's time on screen.
 * @param images - how many images there are.
 * @param video - whether there is a demo video.
 * @returns per shot: its length, image index (or -1 for the demo video) and framing.
 */
export function planShots(lineSeconds: readonly number[], images: number, video: boolean): Shot[] {
  const framings: Framing[] = ['whole', 'fill', 'detail']
  const shots: Shot[] = []
  let n = 0
  let still = 0
  for (const seconds of lineSeconds) {
    const count = Math.max(1, Math.round(seconds / SHOT_SECONDS))
    for (let i = 0; i < count; i++) {
      // The video opens on the whole product; after that every third shot is the demo video, when there is one.
      if (video && n % 3 === 2) shots.push({ seconds: seconds / count, image: -1, framing: 'clip' })
      else {
        shots.push({ seconds: seconds / count, image: images === 0 ? 0 : still % images, framing: framings[still % framings.length] ?? 'whole' })
        still++
      }
      n++
    }
  }
  return shots
}

/** The silent filter chain for one still shot. */
function stillShot(framing: Framing, frames: number, variant: number): string {
  const size = `${String(WIDTH)}x${String(HEIGHT)}`
  // A quick punch in the first quarter second, then a slow push.
  const punch = (base: number): string => `if(lt(on,8),${String(base + 0.14)}-0.14*on/8,${String(base)}+0.05*(on-8)/${String(frames)})`
  const centre = 'x=\'iw/2-(iw/zoom/2)\':y=\'ih/2-(ih/zoom/2)\''
  const big = `scale=${String(WIDTH * 2)}:${String(HEIGHT * 2)}:force_original_aspect_ratio=increase,crop=${String(WIDTH * 2)}:${String(HEIGHT * 2)}`
  if (framing === 'fill') return `[0:v]${big},zoompan=z='${punch(1)}':${centre}:d=${String(frames)}:s=${size}:fps=${String(FPS)}[v]`
  if (framing === 'detail') {
    // A close crop that drifts across the product: left to right, or top to bottom.
    const pan = variant % 2 === 0
      ? `x='(iw-iw/zoom)*(0.2+0.6*on/${String(frames)})':y='ih/2-(ih/zoom/2)'`
      : `x='iw/2-(iw/zoom/2)':y='(ih-ih/zoom)*(0.25+0.5*on/${String(frames)})'`
    return `[0:v]${big},zoompan=z='${punch(1.6)}':${pan}:d=${String(frames)}:s=${size}:fps=${String(FPS)}[v]`
  }
  return [
    `[0:v]scale=${String(WIDTH)}:${String(HEIGHT)}:force_original_aspect_ratio=increase,crop=${String(WIDTH)}:${String(HEIGHT)},boxblur=30:4,eq=brightness=-0.15[bg]`,
    `[0:v]scale=${String(WIDTH - 40)}:${String(Math.round(HEIGHT * 0.56))}:force_original_aspect_ratio=decrease[fg]`,
    `[bg][fg]overlay=(W-w)/2:(H-h)/2-110,scale=${String(WIDTH * 2)}:${String(HEIGHT * 2)},zoompan=z='${punch(1)}':${centre}:d=${String(frames)}:s=${size}:fps=${String(FPS)}[v]`,
  ].join(';')
}

/**
 * Render the video.
 * @param job - images, lines, headlines and paths.
 * @param tools - ffmpeg, ffprobe, the font and the voice.
 * @param signal - cancels every step.
 * @returns the video's length in seconds.
 * @throws when there is no image or line, or a program fails.
 */
export async function renderVideo(job: RenderJob, tools: RenderTools, signal: AbortSignal): Promise<number> {
  if (job.images.length === 0) throw new Error('a video needs at least one image')
  if (job.lines.length === 0) throw new Error('a video needs at least one line')
  await mkdir(job.workDir, { recursive: true })
  const encode = ['-r', String(FPS), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p']

  // The voice: each line, then a short gap, the last held for the end card.
  const spoken = await speakInOne(job, tools, signal)
  const wavs: string[] = []
  const speech: number[] = []
  const onScreen: number[] = []
  for (const [i, line] of job.lines.entries()) {
    const wav = spoken?.[i] ?? join(job.workDir, `line-${String(i)}.wav`)
    if (spoken === undefined) await tools.speak(line.voice, wav, signal)
    const seconds = await duration(tools, wav, signal)
    wavs.push(wav)
    speech.push(seconds)
    onScreen.push(seconds + LINE_GAP + (i === job.lines.length - 1 ? END_HOLD : 0))
  }
  const total = onScreen.reduce((a, b) => a + b, 0)
  const voice = join(job.workDir, 'voice.m4a')
  await run(tools.ffmpeg, [
    '-y', '-loglevel', 'error', ...wavs.flatMap(w => ['-i', w]), '-filter_complex',
    `${wavs.map((_, i) => `[${String(i)}:a]aformat=sample_rates=44100:channel_layouts=stereo,apad,atrim=0:${(onScreen[i] ?? 0).toFixed(3)}[a${String(i)}]`).join(';')};`
      + `${wavs.map((_, i) => `[a${String(i)}]`).join('')}concat=n=${String(wavs.length)}:v=0:a=1[a]`,
    '-map', '[a]', '-c:a', 'aac', '-b:a', '160k', voice,
  ], signal)

  // The pictures: silent shots, joined.
  let videoLength = 0
  if (job.video !== undefined) {
    try { videoLength = await duration(tools, job.video, signal) } catch (_error) { videoLength = 0 }
  }
  const shots = planShots(onScreen, job.images.length, videoLength >= 2)
  const shotFiles: string[] = []
  let clipAt = 0
  let shotStart = 0
  for (const [i, shot] of shots.entries()) {
    // Frames from the running total, so rounding never lets the pictures drift from the voice.
    const frames = Math.max(1, Math.round((shotStart + shot.seconds) * FPS) - Math.round(shotStart * FPS))
    shotStart += shot.seconds
    const out = join(job.workDir, `shot-${String(i)}.mp4`)
    if (shot.framing === 'clip' && job.video !== undefined) {
      // Walk through the demo video, wrapping round when it runs out.
      if (clipAt + shot.seconds > videoLength) clipAt = 0
      await run(tools.ffmpeg, [
        '-y', '-loglevel', 'error', '-ss', clipAt.toFixed(3), '-i', job.video, '-an', '-frames:v', String(frames),
        '-vf', `scale=${String(WIDTH)}:${String(HEIGHT)}:force_original_aspect_ratio=increase,crop=${String(WIDTH)}:${String(HEIGHT)},fps=${String(FPS)},setsar=1`,
        ...encode, out,
      ], signal)
      clipAt += shot.seconds
    } else {
      const image = job.images[shot.image] ?? job.images[0] ?? ''
      await run(tools.ffmpeg, [
        '-y', '-loglevel', 'error', '-i', image, '-filter_complex', `${stillShot(shot.framing, frames, i)};[v]setsar=1[out]`,
        '-map', '[out]', '-frames:v', String(frames), ...encode, out,
      ], signal)
    }
    shotFiles.push(out)
  }
  const list = join(job.workDir, 'shots.txt')
  await writeFile(list, shotFiles.map(s => `file '${s.replace(/'/gu, "'\\''")}'`).join('\n'))
  const pictures = join(job.workDir, 'pictures.mp4')
  await run(tools.ffmpeg, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', pictures], signal)

  // The text, timed to the voice.
  const texts: string[] = []
  let at = 0
  for (const [i, line] of job.lines.entries()) {
    const from = at
    const to = at + (onScreen[i] ?? 0)
    const top = i === 0 && job.hook.trim() !== ''
      ? { text: job.hook, size: 82, color: 'yellow', chars: HEADLINE_CHARS, box: false }
      : i === job.lines.length - 1 && job.endCard.trim() !== ''
        ? { text: job.endCard, size: 78, color: 'yellow', chars: HEADLINE_CHARS, box: false }
        : { text: line.caption, size: 60, color: 'white', chars: LABEL_CHARS, box: true }
    texts.push(await textBlock(job.workDir, `top-${String(i)}`, wrap(top.text, top.chars), tools.font, top.size, HEIGHT * 0.09, top.color, { from, to }, top.box))
    for (const [g, group] of wordGroups(line.voice, speech[i] ?? 0).entries()) {
      texts.push(await textBlock(job.workDir, `words-${String(i)}-${String(g)}`, [group.text], tools.font, 88, HEIGHT * 0.75, 'white', { from: from + group.start, to: from + group.end }, false))
    }
    at = to
  }
  await run(tools.ffmpeg, [
    '-y', '-loglevel', 'error', '-i', pictures, '-i', voice, '-filter_complex', `[0:v]${texts.filter(t => t !== '').join(',')},format=yuv420p[v]`,
    '-map', '[v]', '-map', '1:a', '-t', total.toFixed(3), ...encode, '-c:a', 'copy', '-movflags', '+faststart', job.outPath,
  ], signal)
  return total
}
