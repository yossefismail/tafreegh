import type { SetupPhase } from './types'

/**
 * Where each setup phase sits on the 0–100 track.
 *
 * The backend reports a *phase-local* percentage (uv 0→100, python 0→100, …),
 * so rendering it directly made the bar jump from 100 % back to 0 % with a full
 * fill on every phase change. The ranges below are contiguous, which keeps the
 * displayed number monotonic from `check` through `done`.
 */
const PHASE_RANGES: Record<SetupPhase, [number, number]> = {
  check: [0, 2],
  uv: [2, 30],
  python: [30, 38],
  deps: [38, 76],
  probe: [76, 80],
  jais: [80, 93],
  diarizer: [93, 99],
  done: [100, 100]
}

export function overallSetupPct(phase: SetupPhase | undefined, phasePct: number): number {
  if (!phase) return Math.max(0, Math.min(100, phasePct))
  const [from, to] = PHASE_RANGES[phase] ?? [0, 100]
  const local = Math.max(0, Math.min(100, Number.isFinite(phasePct) ? phasePct : 0))
  return Math.max(from, Math.min(to, from + ((to - from) * local) / 100))
}
