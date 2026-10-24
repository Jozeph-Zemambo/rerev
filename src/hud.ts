const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export type HudStats = {
  heartRate?: number;
  paceMetersPerSecond: number;
  leadMeters: number;
};

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
  private readonly pace = byId('pace-live');
  private readonly lead = byId('lead');
  private readonly message = byId('message');
  private readonly controls = byId('controls');
  private readonly turn = byId('turn');
  private readonly turnArrow = byId('turn-arrow');
  private readonly turnText = byId('turn-text');
  readonly breakButton = byId<HTMLButtonElement>('btn-break');
  readonly slowerButton = byId<HTMLButtonElement>('btn-slower');
  readonly fasterButton = byId<HTMLButtonElement>('btn-faster');
  readonly finishButton = byId<HTMLButtonElement>('btn-reset');

  show(visible: boolean) {
    this.root.hidden = !visible;
  }

  say(text: string) {
    if (this.message.textContent !== text) this.message.textContent = text;
  }

  showControls(visible: boolean) {
    this.controls.hidden = !visible;
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

  update(stats: HudStats) {
    this.hr.textContent = stats.heartRate ? String(Math.round(stats.heartRate)) : '--';
    this.pace.textContent = formatPace(stats.paceMetersPerSecond);
    this.lead.textContent = stats.leadMeters.toFixed(1);
  }
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
