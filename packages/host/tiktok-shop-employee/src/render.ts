/**
 * Render a vertical product video from still images and a voiceover script,
 * with ffmpeg only: each spoken line becomes one segment showing one product
 * image over a blurred copy of itself, slowly zooming, with the line's caption
 * burned in; the first segment carries the hook as a headline, the last the
 * end card. Segments are encoded alike and joined without re-encoding.
 *
 * The voice is generated per line by a caller-supplied function (the deploy
 * uses video-use's `speak.py`), and each segment lasts as long as its line, so
 * the picture follows the voice and nothing is time-stretched.
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
  /** Local image files; segments use them in turn. */
  images: string[]
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
}

/** Output size and frame rate: TikTok's full-screen vertical format. */
const WIDTH = 1080
const HEIGHT = 1920
const FPS = 30

/** Silence after each line, in seconds, so cuts do not clip the last word. */
const LINE_GAP = 0.3
/** How long the end card stays after the last word, in seconds. */
const END_HOLD = 1.2
/** Characters per caption line at the caption size: about 80% of the frame width in DejaVu Sans Bold. */
const CAPTION_CHARS = 20
/** Characters per headline line at the headline size. */
const HEADLINE_CHARS = 17

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
 * Drawtext filters for a block of lines, centred horizontally, each line read from its own file so no text is
 * ever parsed as filter syntax.
 * @returns the filters, joined with commas.
 */
async function textBlock(
  dir: string, name: string, lines: string[], font: string, size: number, top: number, color: string,
): Promise<string> {
  const filters: string[] = []
  for (const [i, line] of lines.entries()) {
    const file = join(dir, `${name}-${String(i)}.txt`)
    await writeFile(file, line)
    filters.push(`drawtext=fontfile='${filterPath(font)}':textfile='${filterPath(file)}':fontsize=${String(size)}:fontcolor=${color}`
      + `:borderw=${String(Math.round(size / 11))}:bordercolor=black@0.85:x=(w-text_w)/2:y=${String(Math.round(top + i * size * 1.22))}`)
  }
  return filters.join(',')
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
  const segments: string[] = []
  let total = 0
  for (const [i, line] of job.lines.entries()) {
    const wav = join(job.workDir, `line-${String(i)}.wav`)
    await tools.speak(line.voice, wav, signal)
    const last = i === job.lines.length - 1
    const seconds = (await duration(tools, wav, signal)) + LINE_GAP + (last ? END_HOLD : 0)
    const frames = Math.ceil(seconds * FPS)
    const image = job.images[i % job.images.length] ?? job.images[0] ?? ''
    // Alternate zooming in and out so consecutive segments do not feel identical.
    const zoom = i % 2 === 0 ? `1+0.07*on/${String(frames)}` : `1.07-0.07*on/${String(frames)}`
    const texts = [await textBlock(job.workDir, `cap-${String(i)}`, wrap(line.caption, CAPTION_CHARS), tools.font, 66, HEIGHT * 0.68, 'white')]
    if (i === 0 && job.hook.trim() !== '') texts.push(await textBlock(job.workDir, 'hook', wrap(job.hook, HEADLINE_CHARS), tools.font, 82, HEIGHT * 0.1, 'yellow'))
    if (last && job.endCard.trim() !== '') texts.push(await textBlock(job.workDir, 'end', wrap(job.endCard, HEADLINE_CHARS), tools.font, 78, HEIGHT * 0.1, 'yellow'))
    const graph = [
      `[0:v]scale=${String(WIDTH)}:${String(HEIGHT)}:force_original_aspect_ratio=increase,crop=${String(WIDTH)}:${String(HEIGHT)},boxblur=28:4,eq=brightness=-0.12[bg]`,
      `[0:v]scale=${String(WIDTH - 80)}:${String(Math.round(HEIGHT * 0.62))}:force_original_aspect_ratio=decrease[fg]`,
      `[bg][fg]overlay=(W-w)/2:(H-h)/2-120,zoompan=z='${zoom}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${String(frames)}:s=${String(WIDTH)}x${String(HEIGHT)}:fps=${String(FPS)},`
        + `${texts.filter(t => t !== '').join(',')},format=yuv420p[v]`,
      `[1:a]apad,atrim=0:${seconds.toFixed(3)},aformat=sample_rates=44100:channel_layouts=stereo[a]`,
    ].join(';')
    const out = join(job.workDir, `seg-${String(i)}.mp4`)
    await run(tools.ffmpeg, [
      '-y', '-loglevel', 'error', '-i', image, '-i', wav, '-filter_complex', graph, '-map', '[v]', '-map', '[a]',
      '-t', seconds.toFixed(3), '-r', String(FPS), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-c:a', 'aac', '-b:a', '160k', out,
    ], signal)
    segments.push(out)
    total += seconds
  }
  const list = join(job.workDir, 'segments.txt')
  await writeFile(list, segments.map(s => `file '${s.replace(/'/gu, "'\\''")}'`).join('\n'))
  await run(tools.ffmpeg, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', job.outPath], signal)
  return total
}
