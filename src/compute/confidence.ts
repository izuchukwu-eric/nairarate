import type { Confidence } from '../types/rates'

/**
 * Freshness thresholds, in minutes, for the 15-minute Monierate sync.
 * A sync that has missed one cycle is still `high`; two is `medium`.
 */
export const MONIERATE_FRESH_MINUTES = 20
export const MONIERATE_STALE_MINUTES = 60
export const MONIERATE_DEGRADED_MINUTES = 120

export function ageMinutes(from: Date | string | null, now: Date): number | null {
  if (from === null) return null
  const t = typeof from === 'string' ? Date.parse(from) : from.getTime()
  if (Number.isNaN(t)) return null
  return Math.max(0, Math.round((now.getTime() - t) / 60_000))
}

/**
 * The most recent instant CBN was expected to have published, given it publishes
 * weekdays at 07:00 UTC (08:00 Lagos).
 *
 * Deriving the expectation rather than using a fixed age threshold is what makes
 * weekends behave correctly: at 09:00 UTC on a Sunday the last expected
 * publication is still Friday 07:00, so Friday's data is current, not stale.
 *
 * Nigerian public holidays are not modelled — CBN does not publish on them, so a
 * holiday reads as one stale cycle. That is intentional: it downgrades confidence
 * rather than fabricating freshness, and rates are still served.
 */
export function lastExpectedCbnPublication(now: Date): Date {
  const candidate = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 7, 0, 0, 0),
  )
  // Today's 07:00 UTC hasn't happened yet — step back a day.
  if (candidate.getTime() > now.getTime()) candidate.setUTCDate(candidate.getUTCDate() - 1)
  // Walk back off Saturday (6) and Sunday (0).
  while (candidate.getUTCDay() === 0 || candidate.getUTCDay() === 6) {
    candidate.setUTCDate(candidate.getUTCDate() - 1)
  }
  return candidate
}

/** True when CBN data is as fresh as the publication schedule allows. */
export function isCbnCurrent(lastOk: string | null, now: Date): boolean {
  if (!lastOk) return false
  const t = Date.parse(lastOk)
  if (Number.isNaN(t)) return false
  return t >= lastExpectedCbnPublication(now).getTime()
}

export function isMonierateHealthy(lastOk: string | null, now: Date): boolean {
  const age = ageMinutes(lastOk, now)
  return age !== null && age <= MONIERATE_STALE_MINUTES
}

export interface ConfidenceInput {
  /** Age of the Monierate payload, minutes. Null when we have never fetched it. */
  monierateAgeMinutes: number | null
  /** Whether CBN data is current for the publication schedule. */
  cbnCurrent: boolean
  /** Whether the last sync of each source errored. */
  monierateErrored: boolean
  cbnErrored: boolean
  /** Tickers that failed on the most recent Monierate run. */
  failedTickers?: readonly string[]
}

export interface ConfidenceResult {
  confidence: Confidence
  warnings: string[]
}

/**
 * Score confidence across both sources.
 *
 * Deliberately pessimistic — the worse of the two sources sets the level, and any
 * partial coverage is surfaced as a warning rather than being averaged away. A
 * caller pricing an NGN transaction needs to know a source is missing, not a
 * blended score that hides it.
 */
export function computeConfidence(input: ConfidenceInput): ConfidenceResult {
  const warnings: string[] = []
  const { monierateAgeMinutes: age, cbnCurrent, monierateErrored, cbnErrored } = input

  let level: Confidence

  if (age === null) {
    level = 'degraded'
    warnings.push(
      'No parallel or crypto street data available — the Monierate sync has never succeeded. ' +
        'Only official CBN rates are present.',
    )
  } else if (age > MONIERATE_DEGRADED_MINUTES) {
    level = 'degraded'
    warnings.push(
      `Parallel market data is ${age} minutes old — Monierate has been unreachable for over ` +
        `${MONIERATE_DEGRADED_MINUTES} minutes. Rates are last known values.`,
    )
  } else if (age > MONIERATE_STALE_MINUTES || monierateErrored) {
    level = 'low'
    if (age > MONIERATE_STALE_MINUTES) {
      warnings.push(`Parallel market data is ${age} minutes old.`)
    }
    if (monierateErrored) warnings.push('The most recent Monierate sync errored.')
  } else if (age > MONIERATE_FRESH_MINUTES || !cbnCurrent) {
    level = 'medium'
    if (age > MONIERATE_FRESH_MINUTES) {
      warnings.push(`Parallel market data is ${age} minutes old.`)
    }
    if (!cbnCurrent) {
      warnings.push(
        'Official CBN rates are behind the expected publication — CBN publishes weekdays at ' +
          '07:00 UTC and does not publish on weekends or Nigerian public holidays.',
      )
    }
  } else {
    level = 'high'
  }

  if (cbnErrored) {
    warnings.push('The most recent CBN sync errored; official rates are last known values.')
    if (level === 'high') level = 'medium'
  }

  const failed = input.failedTickers ?? []
  if (failed.length > 0) {
    warnings.push(
      `No fresh quote for ${failed.length} pair(s): ${failed.join(', ')}. ` +
        'Affected currencies carry last known values or null.',
    )
    if (level === 'high') level = 'medium'
  }

  return { confidence: level, warnings }
}
