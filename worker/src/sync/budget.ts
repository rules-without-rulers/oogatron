// Meters subrequests within one invocation. On the Workers free plan every
// outbound fetch, D1 call, and KV op counts toward a 50-subrequest limit; the
// default max leaves headroom for rollup recompute, bot reconciliation, cache
// generation bump, and sync_runs bookkeeping after the page walks stop.
export class Budget {
  private used = 0;

  constructor(private readonly max = 42) {}

  spend(n = 1): void {
    this.used += n;
  }

  canAfford(n: number): boolean {
    return this.used + n <= this.max;
  }

  get spent(): number {
    return this.used;
  }
}
