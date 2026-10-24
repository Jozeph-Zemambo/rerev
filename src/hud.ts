const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export type HudStats = {
  heartRate?: number;
  paceMetersPerSecond: number;
  leadMeters: number;
};

export class Hud {
  private readonly hr = byId('hr');
  private readonly pace = byId('pace');
  private readonly lead = byId('lead');
  private readonly message = byId('message');
  private readonly controls = byId('controls');
  readonly breakButton = byId<HTMLButtonElement>('btn-break');
  readonly slowerButton = byId<HTMLButtonElement>('btn-slower');
  readonly fasterButton = byId<HTMLButtonElement>('btn-faster');
  readonly resetButton = byId<HTMLButtonElement>('btn-reset');

  say(text: string) {
    if (this.message.textContent !== text) this.message.textContent = text;
  }

  showControls(visible: boolean) {
    this.controls.hidden = !visible;
  }

  update(stats: HudStats) {
    this.hr.textContent = stats.heartRate ? String(Math.round(stats.heartRate)) : '--';
    this.pace.textContent = formatPace(stats.paceMetersPerSecond);
    this.lead.textContent = stats.leadMeters.toFixed(1);
  }
}

function formatPace(metersPerSecond: number): string {
  if (metersPerSecond < 0.3) return '--';
  const secondsPerKm = 1000 / metersPerSecond;
  const minutes = Math.floor(secondsPerKm / 60);
  const seconds = Math.round(secondsPerKm % 60);
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
