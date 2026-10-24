import type { TurnStep } from '../geo/routing';
import { formatSecondsPerKm } from '../hud';
import { kmLineId, lapLineId, type LineId, type Spoken } from '../voice/lines';

/** Call a turn when it is about this far ahead. */
const TURN_CALL = 30;
/** Too close to call it usefully any more (it is happening). */
const TURN_LATE = 4;
/** Splits and halfway only make sense on runs at least this long. */
const LONG_RUN = 800;
const FINAL_STRETCH = 100;

/**
 * What the buddy says about the route itself: turns coming up, kilometre splits with your pace,
 * halfway, and the final stretch. Each is said once per run. The voice says a fixed line
 * ("Left turn coming up!"); the bubble carries the street, distance or split time.
 */
export class RouteCallouts {
  private steps: TurnStep[] = [];
  private distance = 0;
  private called = new Set<number>();
  private nextKm = 1;
  private lastSplitAt = 0;
  private lastUpdate = 0;
  private saidHalfway = false;
  private saidFinal = false;
  private lapLength = 0;
  private nextLap = 1;

  /** `lapLength` turns on lap calls (on the lap course). */
  reset(now: number, steps: TurnStep[] = [], distance = 0, lapLength = 0) {
    this.steps = steps;
    this.distance = distance;
    this.lapLength = lapLength;
    this.nextLap = 1;
    this.called.clear();
    this.nextKm = 1;
    this.lastSplitAt = now;
    this.lastUpdate = now;
    this.saidHalfway = false;
    this.saidFinal = false;
  }

  /**
   * `runnerS` is how far along the route the runner is; `travelled` the distance they have run.
   * Time spent on a breather doesn't count towards the kilometre split.
   */
  update(now: number, runnerS: number, travelled: number, breaking: boolean): Spoken | null {
    if (breaking) this.lastSplitAt += now - this.lastUpdate;
    this.lastUpdate = now;
    for (let i = 0; i < this.steps.length; i++) {
      const step = this.steps[i];
      if (this.called.has(i)) continue;
      const ahead = step.fromStart - runnerS;
      if (ahead < TURN_LATE) {
        // Passed without a call (e.g. two turns close together): don't announce it late.
        if (ahead < 0) this.called.add(i);
        continue;
      }
      if (ahead > TURN_CALL) break;
      this.called.add(i);
      const id = turnLineId(step);
      const turn = turnWords(step);
      if (!id || !turn) continue;
      const inMetres = ` in ${Math.max(5, Math.round(ahead / 5) * 5)} m`;
      // A second turn right after this one goes in the same breath, not as a confusing early call.
      const next = this.steps[i + 1];
      const then = next && next.fromStart - step.fromStart < TURN_CALL ? turnWords(next) : null;
      if (then) {
        this.called.add(i + 1);
        return { id: 'turn_double', bubble: `${turn}${inMetres}, then ${then.charAt(0).toLowerCase()}${then.slice(1)}.` };
      }
      return { id, bubble: `${turn}${inMetres}` };
    }

    if (this.lapLength > 0 && travelled >= this.nextLap * this.lapLength) {
      const lap = this.nextLap++;
      return { id: lapLineId(lap), bubble: `Lap ${lap} done!` };
    }

    if (travelled >= this.nextKm * 1000) {
      const split = now - this.lastSplitAt;
      this.lastSplitAt = now;
      const km = this.nextKm++;
      return { id: kmLineId(km), bubble: `${km} km done in ${formatSecondsPerKm(split)}` };
    }

    if (this.distance < LONG_RUN) return null;
    if (!this.saidHalfway && runnerS >= this.distance / 2) {
      this.saidHalfway = true;
      return { id: 'route_halfway', bubble: `Halfway there! ${formatKm(this.distance - runnerS)} to go.` };
    }
    if (!this.saidFinal && this.distance - runnerS <= FINAL_STRETCH) {
      this.saidFinal = true;
      return { id: 'route_final_stretch' };
    }
    return null;
  }
}

/** The voice line for a turn ("Left turn coming up!"), or null for steps that aren't really turns. */
export function turnLineId(step: TurnStep): LineId | null {
  if (step.type === 'depart' || step.type === 'arrive') return null;
  switch (step.modifier) {
    case 'left':
      return 'turn_left';
    case 'right':
      return 'turn_right';
    case 'slight left':
      return 'turn_slight_left';
    case 'slight right':
      return 'turn_slight_right';
    case 'sharp left':
      return 'turn_sharp_left';
    case 'sharp right':
      return 'turn_sharp_right';
    case 'uturn':
      return 'turn_uturn';
    default:
      return null;
  }
}

/** The turn itself: "Left onto Elbow Drive", "Bear right", "Turn around". */
function turnWords(step: TurnStep): string | null {
  if (step.type === 'depart' || step.type === 'arrive') return null;
  const onto = step.street ? ` onto ${step.street}` : '';
  const [first, side] = step.modifier.split(' ');
  if (step.modifier === 'left' || step.modifier === 'right') return `${capitalise(step.modifier)}${onto}`;
  if (first === 'sharp' && side) return `Sharp ${side}${onto}`;
  if (first === 'slight' && side) return `Bear ${side}${onto}`;
  if (step.modifier === 'uturn') return 'Turn around';
  return null;
}

function capitalise(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function formatKm(metres: number) {
  return metres >= 1000 ? `${(metres / 1000).toFixed(1)} km` : `${Math.round(metres / 10) * 10} m`;
}
