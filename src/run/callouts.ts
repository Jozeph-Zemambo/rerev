import type { CoachLine } from '../partner/coach';
import type { TurnStep } from '../geo/routing';
import { formatSecondsPerKm } from '../hud';

/** Call a turn when it is about this far ahead. */
const TURN_CALL = 30;
/** Too close to call it usefully any more (it is happening). */
const TURN_LATE = 4;
/** Splits and halfway only make sense on runs at least this long. */
const LONG_RUN = 800;
const FINAL_STRETCH = 100;

/**
 * What the buddy says about the route itself: turns coming up, kilometre splits with your pace,
 * halfway, and the final stretch. Each is said once per run.
 */
export class RouteCallouts {
  private steps: TurnStep[] = [];
  private distance = 0;
  private called = new Set<number>();
  private nextKm = 1;
  private lastSplitAt = 0;
  private saidHalfway = false;
  private saidFinal = false;

  reset(now: number, steps: TurnStep[] = [], distance = 0) {
    this.steps = steps;
    this.distance = distance;
    this.called.clear();
    this.nextKm = 1;
    this.lastSplitAt = now;
    this.saidHalfway = false;
    this.saidFinal = false;
  }

  /** `runnerS` is how far along the route the runner is; `travelled` the distance they have run. */
  update(now: number, runnerS: number, travelled: number): CoachLine | null {
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
      const turn = turnWords(step);
      if (!turn) continue;
      // A second turn right after this one goes in the same breath, not as a confusing early call.
      const next = this.steps[i + 1];
      const then = next && next.fromStart - step.fromStart < TURN_CALL ? turnWords(next) : null;
      if (then) {
        this.called.add(i + 1);
        return { text: `${turn}, then ${then.charAt(0).toLowerCase()}${then.slice(1)}.`, mood: 'info' };
      }
      return { text: turnPhrase(step)!, mood: 'info' };
    }

    if (travelled >= this.nextKm * 1000) {
      const split = now - this.lastSplitAt;
      this.lastSplitAt = now;
      const km = this.nextKm++;
      return { text: `${km} ${km === 1 ? 'kilometre' : 'kilometres'} done! That one took ${formatSecondsPerKm(split)}.`, mood: 'cheer' };
    }

    if (this.distance < LONG_RUN) return null;
    if (!this.saidHalfway && runnerS >= this.distance / 2) {
      this.saidHalfway = true;
      return { text: "Halfway there! You're doing great.", mood: 'cheer' };
    }
    if (!this.saidFinal && this.distance - runnerS <= FINAL_STRETCH) {
      this.saidFinal = true;
      return { text: 'Last hundred metres. Finish strong!', mood: 'cheer' };
    }
    return null;
  }
}

/** "Left onto Elbow Drive coming up!", or null for steps that aren't really turns. */
export function turnPhrase(step: TurnStep): string | null {
  const words = turnWords(step);
  if (!words) return null;
  if (step.modifier === 'uturn') return `${words} up here.`;
  return step.modifier === 'left' || step.modifier === 'right' ? `${words} coming up!` : `${words} up ahead.`;
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
