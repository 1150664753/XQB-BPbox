/** Bounded AIMD pacing. A high baseline RTT alone does not imply low bandwidth. */
export class AssetPacer {
  rate = 256 * 1024
  private lastSampleAt = 0
  private baselineRtt: number | null = null
  private lastDecreaseAt = -1000
  private route: string | null = null
  private congestedSince: number | null = null

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
      this.rate = Math.min(this.rate, 256 * 1024)
      this.lastSampleAt = now
      this.congestedSince = null
    }
    this.rate = Math.min(this.rate, ceiling)
    if (rtt !== null) this.baselineRtt = Math.min(this.baselineRtt ?? rtt, rtt)
    if (now - this.lastSampleAt < 1000) return this.rate
    this.lastSampleAt = now
    const inflated =
      rtt !== null &&
      this.baselineRtt !== null &&
      rtt > this.baselineRtt + Math.max(80, this.baselineRtt * 0.35)
    // bufferedAmount is queued browser data, not packet loss. A few frames queued
    // for one RTT is normal; only sustained queueing or RTT inflation backs off.
    if (inflated || buffered > this.highWater(rtt)) {
      this.congestedSince ??= now
      if (now - this.congestedSince >= this.stallWindow(rtt)) this.congested(now)
    } else {
      this.congestedSince = null
      // Probe headroom quickly on a stable path; persistent buffer/RTT inflation
      // still reduces the rate and the browser queue remains capped at 128 KiB.
      if (now - this.lastDecreaseAt >= 2000)
        this.rate = Math.min(ceiling, this.rate + Math.max(32 * 1024, this.rate * 0.25))
    }
    return this.rate
  }

  highWater(rtt: number | null): number {
    // One bandwidth-delay product plus a frame; bounded to protect control latency.
    return Math.min(128 * 1024, Math.max(32 * 1024, this.rate * ((rtt ?? 100) / 1000) + 16 * 1024))
  }

  stallWindow(rtt: number | null): number {
    return Math.max(1500, (rtt ?? 250) * 3)
  }

  congested(now: number): void {
    if (now - this.lastDecreaseAt < 1000) return
    this.lastDecreaseAt = now
    this.rate = Math.max(16 * 1024, this.rate * 0.7)
  }
}
