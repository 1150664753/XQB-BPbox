/** Bounded AIMD pacing. A high baseline RTT alone does not imply low bandwidth. */
export class AssetPacer {
  rate = 128 * 1024
  private lastSampleAt = 0
  private baselineRtt: number | null = null
  private lastDecreaseAt = -1000
  private route: string | null = null

  sample(
    now: number,
    ceiling: number,
    rtt: number | null,
    buffered: number,
    route: string | null = null
  ): number {
    if (route !== null && route !== this.route) {
      this.route = route
      this.baselineRtt = rtt
      this.rate = Math.min(this.rate, 128 * 1024)
      this.lastSampleAt = now
    }
    this.rate = Math.min(this.rate, ceiling)
    if (rtt !== null) this.baselineRtt = Math.min(this.baselineRtt ?? rtt, rtt)
    if (now - this.lastSampleAt < 1000) return this.rate
    this.lastSampleAt = now
    const inflated =
      rtt !== null &&
      this.baselineRtt !== null &&
      rtt > this.baselineRtt + Math.max(80, this.baselineRtt * 0.35)
    if (inflated || buffered > 16 * 1024) this.congested(now)
    else if (buffered <= 4 * 1024 && now - this.lastDecreaseAt >= 2000)
      this.rate = Math.min(ceiling, this.rate + 16 * 1024)
    return this.rate
  }

  congested(now: number): void {
    if (now - this.lastDecreaseAt < 1000) return
    this.lastDecreaseAt = now
    this.rate = Math.max(16 * 1024, this.rate * 0.7)
  }
}
