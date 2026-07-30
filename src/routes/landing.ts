import type { Context } from 'hono'

import { getCachedRates } from '../cache/kv'
import indexHtml from '../site/index.html'
import type { Env } from '../types/rates'

/**
 * The landing page, with its headline ticker filled from live data.
 *
 * The ticker heading says "USD parallel vs official right now", but the three
 * numbers under it were literal text in the HTML, frozen at deploy time. They read
 * correctly the day they shipped and drifted afterwards while still claiming "right
 * now" — a stale rate on the front page of a rate-accuracy product.
 *
 * Cost: one extra KV read per page render, and none of it touches an upstream. The
 * values come from `latest:rates`, which the cron already maintains for /v1/rates,
 * so the billable Monierate path is not involved at any traffic level. Combined
 * with the 60s edge cache below, a traffic spike collapses to roughly one read per
 * minute per location rather than one per visitor.
 *
 * If KV is empty or unreadable the baked-in values are served unchanged, with the
 * "as of last deploy" caption left in place. A missing rate must never blank the
 * page or show a zero.
 */

/** Edge cache for the rendered page. Short enough that the ticker stays honest. */
const PAGE_CACHE_SECONDS = 60

function naira(v: number): string {
  return `₦${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** Replace the text content of a single known element id. */
function setText(html: string, id: string, value: string): string {
  const re = new RegExp(`(id="${id}"[^>]*>)[^<]*(<)`)
  return html.replace(re, `$1${value}$2`)
}

export async function landingHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  let html = indexHtml
  let live = false

  try {
    const payload = await getCachedRates(c.env)
    const usd = payload?.rates['USD']
    const spread = payload?.spreads['USD']?.parallel_vs_official_pct

    // Every piece must be present. A partially-filled ticker is worse than an
    // honestly-labelled stale one.
    if (
      usd?.parallel?.mid != null &&
      usd.official?.mid != null &&
      typeof spread === 'number'
    ) {
      html = setText(html, 'spread', `${spread >= 0 ? '+' : ''}${spread.toFixed(2)}%`)
      html = setText(html, 'parallel', naira(usd.parallel.mid))
      html = setText(html, 'official', naira(usd.official.mid))
      // The caption exists to warn that the numbers are frozen. They are not now.
      html = html.replace('>Rates as of last deploy<', '>Live, refreshed every 15 minutes<')
      live = true
    }
  } catch (err: unknown) {
    // Serving the page matters more than serving fresh numbers.
    console.error('landing: could not read latest:rates, serving baked-in values', err)
  }

  return c.html(html, 200, {
    'cache-control': `public, max-age=${live ? PAGE_CACHE_SECONDS : 0}${live ? '' : ', must-revalidate'}`,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
  })
}
