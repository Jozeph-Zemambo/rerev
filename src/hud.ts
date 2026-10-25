const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export type HudStats = {
  heartRate: number | null;
  heartSource: 'watch' | 'manual' | 'simulated' | 'none';
  zone: { low: number; high: number };
  paceMetersPerSecond: number;
  leadMeters: number;
  /** Race mode: the race clock and lap stand in for pace and lead. */
  race?: { time: string; lap: number; laps: number };
};

const SOURCE_LABEL = { watch: 'bpm · watch', manual: 'bpm · demo', simulated: 'bpm · sim', none: 'no watch' } as const;

const TURN_ARROWS: Record<string, string> = {
  left: '↰',
  'slight left': '↖',
  'sharp left': '↰',
  right: '↱',
  'slight right': '↗',
  'sharp right': '↱',
  uturn: '↶',
  straight: '↑',
};

export class Hud {
  readonly root = byId('overlay');
  private readonly hr = byId('hr');
  private readonly hrSource = byId('hr-source');
  readonly hrStat = byId<HTMLButtonElement>('hr-stat');
  readonly hrPanel = byId('hr-panel');
  readonly hrManual = byId<HTMLInputElement>('hr-manual');
  readonly hrManualOut = byId<HTMLOutputElement>('hr-manual-out');
  readonly hrAuto = byId<HTMLButtonElement>('hr-auto');
  private readonly pace = byId('pace-live');
  private readonly lead = byId('lead');
  private readonly message = byId('message');
  private readonly controls = byId('controls');
  private readonly topbar = byId('topbar');
  private readonly turn = byId('turn');
  private readonly turnArrow = byId('turn-arrow');
  private readonly turnText = byId('turn-text');
  readonly breakButton = byId<HTMLButtonElement>('btn-break');
  readonly slowerButton = byId<HTMLButtonElement>('btn-slower');
  readonly fasterButton = byId<HTMLButtonElement>('btn-faster');
  readonly finishButton = byId<HTMLButtonElement>('btn-reset');
  private readonly coursePanel = byId('course-panel');
  readonly recordButton = byId<HTMLButtonElement>('btn-record');
  readonly courseDoneButton = byId<HTMLButtonElement>('btn-course-done');
  readonly courseRedoButton = byId<HTMLButtonElement>('btn-course-redo');
  readonly raceButton = byId<HTMLButtonElement>('btn-race');
  readonly runAheadButton = byId<HTMLButtonElement>('btn-run-ahead');
  readonly comeBackButton = byId<HTMLButtonElement>('btn-come-back');
  private readonly paceKey = byId('pace-k');
  private readonly paceUnit = byId('pace-u');
  private readonly leadUnit = byId('lead-u');
  private readonly raceCount = byId('race-count');
  private readonly raceCountText = byId('race-count-text');

  show(visible: boolean) {
    this.root.hidden = !visible;
  }

  private readonly leadName = byId('lead-name');
  private buddyName = 'Buddy';
  private racing = false;

  /** The lead stat is labelled with the buddy you're running with ("Rev · 3.2 m ahead"). */
  setBuddyName(name: string) {
    this.buddyName = name;
    if (!this.racing) this.leadName.textContent = name;
  }

  private readonly score = byId('score');
  private readonly scoreStars = byId('score-stars');
  private readonly scoreCoins = byId('score-coins');

  showScore(stars: number, coins: number) {
    const s = String(stars);
    const c = String(coins);
    if (this.scoreStars.textContent === s && this.scoreCoins.textContent === c) return;
    this.scoreStars.textContent = s;
    this.scoreCoins.textContent = c;
    this.score.classList.remove('bump');
    void this.score.offsetWidth;
    this.score.classList.add('bump');
  }

  say(text: string) {
    if (this.message.textContent !== text) this.message.textContent = text;
  }

  /** The run's controls, stats and score: only while a run is on, so none of them show stale numbers. */
  showControls(visible: boolean) {
    this.controls.hidden = !visible;
    this.topbar.hidden = !visible;
    this.score.hidden = !visible;
  }

  /** Just the row of run buttons (Talk, Take a break, …): race mode has its own Stop instead. */
  showRunButtons(visible: boolean) {
    this.controls.hidden = !visible;
  }

  /** Walk your course: Record before recording; Start over and Done while recording; else nothing. */
  showCoursePanel(stage: 'ready' | 'recording' | null) {
    this.coursePanel.hidden = stage === null;
    this.recordButton.hidden = stage !== 'ready';
    this.courseDoneButton.hidden = stage !== 'recording';
    this.courseRedoButton.hidden = stage !== 'recording';
  }

  private readonly boothPanel = byId('booth-panel');
  readonly boothMoveButton = byId<HTMLButtonElement>('btn-booth-move');
  readonly boothExitButton = byId<HTMLButtonElement>('btn-booth-exit');

  /** Booth mode's Move and Exit (Move once there's a buddy to move). */
  showBoothPanel(visible: boolean, canMove = false) {
    this.boothPanel.hidden = !visible;
    this.boothMoveButton.hidden = !canMove;
  }

  /** The message strip; the booth hides it once both buddies stand, to leave the view clear. */
  showMessage(visible: boolean) {
    this.message.hidden = !visible;
  }

  /**
   * Race mode's readout: with the phone propped up, its own pace and the buddy's lead mean
   * nothing, so those two stats become the race clock and the lap.
   */
  raceStats(on: boolean) {
    this.racing = on;
    setText(this.paceKey, on ? 'Race' : 'Pace');
    setText(this.paceUnit, on ? 'time' : 'min/km');
    setText(this.leadName, on ? 'Lap' : this.buddyName);
    setText(this.leadUnit, on ? 'laps' : 'm ahead');
    if (!on) this.showCount(null);
  }

  /** The big countdown number ("3", "2", "1", "GO!"), or null to hide it. Pops in on each change. */
  showCount(text: string | null) {
    this.raceCount.hidden = text === null;
    if (text === null) this.raceCountText.textContent = '';
    if (text === null || this.raceCountText.textContent === text) return;
    this.raceCountText.textContent = text;
    this.raceCount.dataset.beat = text === 'GO!' ? 'go' : 'count';
    this.raceCountText.classList.remove('pop');
    void this.raceCountText.offsetWidth;
    this.raceCountText.classList.add('pop');
  }

  /** Next turn on a map route, or null to hide the chip. */
  showTurn(turn: { modifier: string; street: string; metres: number } | null) {
    this.turn.hidden = !turn;
    if (!turn) return;
    this.turnArrow.textContent = TURN_ARROWS[turn.modifier] ?? '↑';
    const where = turn.street ? ` onto ${turn.street}` : '';
    const verb = turn.modifier ? turn.modifier.replace(/^\w/, c => c.toUpperCase()) : 'Continue';
    const text = `${verb}${where} in ${Math.max(0, Math.round(turn.metres / 5) * 5)} m`;
    if (this.turnText.textContent !== text) this.turnText.textContent = text;
  }

  /** Called every frame; only touches the DOM when something visible changed (cheap in AR overlays). */
  update(stats: HudStats) {
    const bpm = stats.heartRate;
    setText(this.hr, bpm ? String(Math.round(bpm)) : '--');
    const band = !bpm ? '' : bpm > stats.zone.high ? 'above' : bpm < stats.zone.low ? 'below' : 'in';
    if (this.hr.dataset.band !== band) this.hr.dataset.band = band;
    setText(this.hrSource, SOURCE_LABEL[stats.heartSource]);
    setText(this.pace, stats.race ? stats.race.time : formatPace(stats.paceMetersPerSecond));
    setText(this.lead, stats.race ? `${stats.race.lap}/${stats.race.laps}` : stats.leadMeters.toFixed(1));
  }
}

function setText(el: HTMLElement, text: string) {
  if (el.textContent !== text) el.textContent = text;
}

export function formatPace(metersPerSecond: number): string {
  if (metersPerSecond < 0.3) return '--';
  return formatSecondsPerKm(1000 / metersPerSecond);
}

export function formatSecondsPerKm(secondsPerKm: number): string {
  const minutes = Math.floor(secondsPerKm / 60);
  const seconds = Math.round(secondsPerKm % 60);
  return seconds === 60 ? `${minutes + 1}:00` : `${minutes}:${String(seconds).padStart(2, '0')}`;
}
