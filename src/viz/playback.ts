// Tempo di riproduzione indipendente dal passo numerico e dal frame grafico.
export const PLAYBACK_SPEEDS = [0.25, 0.5, 1, 2, 5, 10] as const;
export type PlaybackSpeed = typeof PLAYBACK_SPEEDS[number];

export function isPlaybackSpeed(value: unknown): value is PlaybackSpeed {
  return typeof value === 'number' && PLAYBACK_SPEEDS.some((speed) => speed === value);
}

export class PlaybackClock {
  private lastWallTime: number | null = null;
  private pending = 0;

  /** Pausa, cambio velocità e visibilità ripartono dall'istante corrente. */
  reset(now: number): void {
    this.lastWallTime = now;
    this.pending = 0;
  }

  update(now: number, active: boolean, speed: PlaybackSpeed): void {
    const elapsed = this.lastWallTime === null ? 0 : Math.max(0, (now - this.lastWallTime) / 1000);
    this.lastWallTime = now;
    if (active) this.pending += elapsed * speed;
    else this.pending = 0;
  }

  get pendingSeconds(): number { return this.pending; }

  ready(dt: number): boolean {
    return this.pending + 8 * Number.EPSILON * Math.max(1, this.pending) >= dt;
  }

  /** Si consuma tempo soltanto dopo un passo effettivamente accettato. */
  consume(dt: number): void {
    this.pending = Math.max(0, this.pending - dt);
  }
}
