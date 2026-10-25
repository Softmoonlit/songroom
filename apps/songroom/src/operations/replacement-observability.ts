export type ReplacementMetricPhase =
  | "queue"
  | "remove-write"
  | "remove-readback"
  | "add-write"
  | "add-readback";

export type ReplacementMetricOutcome =
  | "started"
  | "ok"
  | "stale"
  | "unknown"
  | "failed"
  | "conflict"
  | "aborted";

export interface ReplacementMetric {
  operationId: string;
  phase: ReplacementMetricPhase;
  outcome: ReplacementMetricOutcome;
  elapsedMs?: number;
}

export type ReplacementMetricReporter = (metric: ReplacementMetric) => void;

export const noopReplacementMetricReporter: ReplacementMetricReporter = () => {};
