/**
 * The owner's review page for one video, opened from the WhatsApp link on a
 * phone: the video, a download button, the caption to copy, the product to
 * tag, the two labels to switch on in TikTok, and the buttons that record
 * what the owner did. The link is signed, so it works without the harness
 * sign-in; every action posts the same signature back.
 */

import type { TrackedProduct, VideoRecord } from './store.ts'

function html(value: string): string {
  return value.replace(/[&<>"']/gu, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[c] ?? c)
}

/**
 * The review page.
 * @param video - the video.
 * @param product - its product, when still known.
 * @param links - the signed media and action addresses.
 * @returns the HTML document.
 */
export function reviewPage(video: VideoRecord, product: TrackedProduct | undefined, links: { media: string; action: string }): string {
  const status = {
    rendering: 'Still rendering. Refresh in a minute.',
    failed: `The render failed: ${video.error ?? 'unknown error'}`,
    ready: 'Ready to post.',
    posted: `Posted${video.postedAt === undefined ? '' : ` on ${video.postedAt.slice(0, 10)}`}.`,
    skipped: 'Skipped.',
  }[video.status]
  const playable = video.file !== undefined && video.status !== 'rendering' && video.status !== 'failed'
  const results = video.results
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TikTok Shop video</title>
<style>
:root{color-scheme:light dark;--bg:#f6f5f2;--fg:#17171a;--muted:#5d5d66;--line:#d9d7d1;--card:#fff;--accent:#fe2c55}
@media (prefers-color-scheme:dark){:root{--bg:#121214;--fg:#f1f1f3;--muted:#a3a3ad;--line:#2c2c33;--card:#1b1b1f}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,sans-serif}
main{max-width:520px;margin:0 auto;padding:16px}h1{font-size:20px;margin:4px 0 2px}p{margin:6px 0}.muted{color:var(--muted);font-size:14px}
video{width:100%;max-height:70vh;border-radius:12px;background:#000;display:block;margin:12px 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px;margin:12px 0}
textarea{width:100%;min-height:96px;font:inherit;border:1px solid var(--line);border-radius:8px;padding:8px;background:transparent;color:inherit}
button,a.button{display:inline-block;font:inherit;font-weight:600;border:0;border-radius:999px;padding:10px 18px;margin:6px 6px 0 0;cursor:pointer;text-decoration:none;text-align:center}
.primary{background:var(--accent);color:#fff}.ghost{background:transparent;color:inherit;border:1px solid var(--line)}
ol{padding-left:20px;margin:6px 0}li{margin:4px 0}input{font:inherit;width:7em;padding:6px;border:1px solid var(--line);border-radius:8px;background:transparent;color:inherit}
</style></head><body><main>
<p class="muted">TikTok Shop employee · ${html(video.format)}</p>
<h1>${html(product?.title ?? video.productId)}</h1>
<p>${html(status)}</p>
${playable ? `<video src="${html(links.media)}" controls playsinline preload="metadata"></video>
<a class="button primary" href="${html(links.media)}&download=1">Download video</a>` : ''}
<div class="card"><strong>Caption</strong>
<textarea id="caption" readonly>${html(video.caption)}</textarea>
<button class="ghost" type="button" onclick="navigator.clipboard.writeText(document.getElementById('caption').value).then(()=>{this.textContent='Copied'})">Copy caption</button></div>
<div class="card"><strong>When you post in TikTok</strong><ol>
<li>Upload the video and paste the caption.</li>
<li>Add link → Products → find <em>${html(product?.title ?? 'the product')}</em>${product?.id === undefined ? '' : ` (id ${html(product.id)})`} and add it.</li>
<li>More options → turn on <strong>AI-generated content</strong> (the voice is AI) and <strong>Content disclosure → Promotional content</strong>.</li>
<li>Add a trending sound at low volume if you like.</li></ol></div>
${video.status === 'ready' ? `<form method="post" action="${html(links.action)}"><button class="primary" name="do" value="posted">I posted it</button><button class="ghost" name="do" value="skipped">Skip this one</button></form>` : ''}
${video.status === 'posted' ? `<form class="card" method="post" action="${html(links.action)}"><strong>How did it do?</strong>
<p class="muted">After a few days, from the video's analytics. The employee writes more like the ones that sell.</p>
<p><label>Views <input name="views" inputmode="numeric" value="${html(String(results?.views ?? ''))}"></label>
<label>Sales <input name="sales" inputmode="numeric" value="${html(String(results?.sales ?? ''))}"></label></p>
<button class="primary" name="do" value="results">Save results</button></form>` : ''}
</main></body></html>`
}
