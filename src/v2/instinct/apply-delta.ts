import { maturityStateFrom, proposedMaturity } from "../math/decay.js";
import {
  CONFIDENCE_MAX,
  CONFIDENCE_MIN,
  type Delta,
  type Instinct,
  type Maturity,
} from "./schema.js";

export type InstinctMap = Map<string, Instinct>;

export type ApplyDeltaContext = {
  now: string;
  sessionId: string;
};

export function applyDelta(
  instincts: InstinctMap,
  delta: Delta,
  context: ApplyDeltaContext,
): InstinctMap {
  const { now, sessionId } = context;
  const next = new Map(instincts);

  switch (delta.op) {
    case "create": {
      if (next.has(delta.instinct_id)) {
        return applyDelta(
          next,
          {
            op: "reinforce",
            instinct_id: delta.instinct_id,
            delta: { confidence: 0 },
          },
          context,
        );
      }
      const instinct: Instinct = {
        schema_version: 1,
        id: delta.instinct_id,
        trigger: delta.trigger,
        finding: delta.finding,
        confidence: clamp(delta.initial_confidence),
        // Persist the create-time signal level so recompute starts from it
        // instead of discarding it back to the 0.5 floor (ADR/U4).
        confidence_floor: clamp(delta.initial_confidence),
        domain: delta.domain,
        maturity: "candidate",
        scope: "project",
        project_id: "",
        source: {
          first_session: sessionId,
          first_observed_at: now,
          source_refs: [],
          observations: [
            {
              session: sessionId,
              reinforcing: true,
              at: now,
            },
          ],
        },
        related: [],
        created_at: now,
        updated_at: now,
        last_promoted_at: null,
      };
      next.set(delta.instinct_id, instinct);
      return next;
    }
    case "reinforce": {
      const existing = next.get(delta.instinct_id);
      if (!existing || existing.maturity === "deprecated") {
        return next;
      }
      const observations = [
        ...existing.source.observations,
        {
          session: sessionId,
          reinforcing: true,
          at: now,
        },
      ];
      next.set(delta.instinct_id, recomputeInstinct(existing, observations, now));
      return next;
    }
    case "correct": {
      const existing = next.get(delta.instinct_id);
      if (!existing || existing.maturity === "deprecated") {
        return next;
      }
      const observations = [
        ...existing.source.observations,
        {
          session: sessionId,
          reinforcing: false,
          at: now,
          correction: delta.correction,
        },
      ];
      const updated = recomputeInstinct(existing, observations, now);
      next.set(delta.instinct_id, {
        ...updated,
        finding: delta.correction,
      });
      return next;
    }
    case "deprecate": {
      const existing = next.get(delta.instinct_id);
      if (!existing) return next;
      next.set(delta.instinct_id, {
        ...existing,
        maturity: "deprecated",
        updated_at: now,
      });
      return next;
    }
    case "merge": {
      const source = next.get(delta.instinct_id);
      const target = next.get(delta.into);
      if (source && target && target.maturity !== "deprecated") {
        const observations = [...target.source.observations, ...source.source.observations];
        next.set(delta.into, recomputeInstinct(target, observations, now));
      }
      next.delete(delta.instinct_id);
      return next;
    }
    case "revive": {
      const existing = next.get(delta.instinct_id);
      if (!existing) return next;
      next.set(delta.instinct_id, {
        ...existing,
        maturity: "candidate",
        updated_at: now,
      });
      return next;
    }
    default: {
      const _exhaustive: never = delta;
      return _exhaustive;
    }
  }
}

export function applyDeltas(
  instincts: InstinctMap,
  deltas: readonly Delta[],
  context: ApplyDeltaContext,
): InstinctMap {
  let current = instincts;
  for (const delta of deltas) {
    current = applyDelta(current, delta, context);
  }
  return current;
}

export function finalizeInstinct(instinct: Instinct, projectId: string, now: string): Instinct {
  const observations =
    instinct.source.observations.length > 0
      ? instinct.source.observations
      : [
          {
            session: instinct.source.first_session,
            reinforcing: true,
            at: instinct.source.first_observed_at,
          },
        ];

  const recomputed = recomputeInstinct(
    {
      ...instinct,
      project_id: instinct.scope === "global" ? "" : projectId,
    },
    observations,
    now,
  );

  return {
    ...recomputed,
    source: {
      ...recomputed.source,
      first_session: recomputed.source.first_session || instinct.source.first_session,
    },
  };
}

function recomputeInstinct(
  instinct: Instinct,
  observations: Instinct["source"]["observations"],
  now: string,
): Instinct {
  const state = maturityStateFrom(observations, now, instinct.confidence_floor);
  const maturity: Maturity =
    instinct.maturity === "deprecated" ? "deprecated" : proposedMaturity(instinct.maturity, state);

  return {
    ...instinct,
    confidence: clamp(state.confidence),
    maturity,
    source: {
      ...instinct.source,
      observations,
    },
    updated_at: now,
  };
}

function clamp(value: number): number {
  return Math.min(CONFIDENCE_MAX, Math.max(CONFIDENCE_MIN, value));
}
