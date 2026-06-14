// Decay math reference implementation — confidence and maturity.
// Specification: docs/specs/atomic-instinct-schema.md (Maturity Transitions)
// Decision driver: lamarck's 90-day half-life with 4× harmful multiplier.
//
// Pure functions. No I/O. Unit-testable in isolation. Re-export point
// for the v2 implementation once td-839bd1 lands.

import {
  CONFIDENCE_MAX,
  CONFIDENCE_MIN,
  type Maturity,
  type MaturityState,
  type Observation,
} from "../instinct/schema.js";

// ---- Tunables. Stable across reference and production. ----------------

/** Half-life of an observation's contribution to confidence, in days. */
export const HALF_LIFE_DAYS = 90;

/** Positive observation base delta (before decay). */
export const REINFORCE_BASE_DELTA = 0.04;

/** Negative observation multiplier (lamarck's "harmful weight 4×"). */
export const CORRECTION_MULTIPLIER = 4;

/** Initial confidence when an instinct is first created. */
export const INITIAL_CONFIDENCE = 0.5;

// ---- Pure helpers. ----------------------------------------------------

const MS_PER_DAY = 86_400_000;

/**
 * Exponential decay factor for an observation made `ageDays` ago.
 * decay(0) = 1, decay(HALF_LIFE_DAYS) = 0.5.
 */
export function decayFactor(ageDays: number): number {
  if (ageDays <= 0) return 1;
  return 0.5 ** (ageDays / HALF_LIFE_DAYS);
}

export function daysBetween(from: string, to: string): number {
  const dt = new Date(to).getTime() - new Date(from).getTime();
  return dt / MS_PER_DAY;
}

export function clampConfidence(value: number): number {
  if (value < CONFIDENCE_MIN) return CONFIDENCE_MIN;
  if (value > CONFIDENCE_MAX) return CONFIDENCE_MAX;
  return value;
}

/**
 * Compute the confidence value implied by the observation log, evaluated
 * at instant `now`. The schema's `confidence` field is a cached view of
 * this function's output; the log is canonical.
 */
export function confidenceFromObservations(
  observations: readonly Observation[],
  now: string,
): number {
  let value = INITIAL_CONFIDENCE;
  for (const o of observations) {
    const ageDays = daysBetween(o.at, now);
    const weight = decayFactor(ageDays);
    if (o.reinforcing) {
      value += REINFORCE_BASE_DELTA * weight;
    } else {
      value -= REINFORCE_BASE_DELTA * CORRECTION_MULTIPLIER * weight;
    }
  }
  return clampConfidence(value);
}

/**
 * Reduce a list of observations to maturity-eligibility inputs.
 * `survivedContradiction` is true if at least one correction was followed
 * by ≥2 reinforcing observations.
 */
export function maturityStateFrom(
  observations: readonly Observation[],
  now: string,
): MaturityState {
  const reinforcing = observations.filter((o) => o.reinforcing).length;
  const correction = observations.length - reinforcing;
  const ageDays =
    observations.length > 0 ? Math.max(...observations.map((o) => daysBetween(o.at, now))) : 0;
  const survived = survivedContradiction(observations);
  return {
    confidence: confidenceFromObservations(observations, now),
    age_days: ageDays,
    reinforcing_count: reinforcing,
    correction_count: correction,
    survived_contradiction: survived,
  };
}

function survivedContradiction(observations: readonly Observation[]): boolean {
  for (let i = 0; i < observations.length; i++) {
    const o = observations[i]!;
    if (o.reinforcing) continue;
    let reinforcingAfter = 0;
    for (let j = i + 1; j < observations.length; j++) {
      if (observations[j]!.reinforcing) reinforcingAfter += 1;
      if (reinforcingAfter >= 2) return true;
    }
  }
  return false;
}

/**
 * Propose the next maturity level given current state. Pure: never returns
 * a downgrade except to `deprecated` (which is the terminal demotion).
 * Real transitions are gated by the state machine in production code; this
 * function answers "what is the highest legal maturity right now?"
 */
export function proposedMaturity(current: Maturity, state: MaturityState): Maturity {
  if (current === "deprecated") {
    return state.confidence > CONFIDENCE_MIN + 0.1 ? "candidate" : "deprecated";
  }
  if (state.confidence < CONFIDENCE_MIN + 0.001) return "deprecated";
  if (
    state.confidence >= 0.8 &&
    state.age_days >= 30 &&
    state.reinforcing_count >= 5 &&
    state.survived_contradiction
  ) {
    return "proven";
  }
  if (state.confidence >= 0.6 && state.age_days >= 7 && state.reinforcing_count >= 2) {
    return "established";
  }
  return "candidate";
}
