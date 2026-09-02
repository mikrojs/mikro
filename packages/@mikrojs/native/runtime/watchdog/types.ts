export interface Watchdog {
  /** Report progress to the feed watchdog. Call it where real work completed,
   *  not from a bare timer. A no-op when `watchdog.feed` is not configured. */
  feed(): void
}

/** Progress reporting for the `feed` watchdog. The limits themselves are
 *  set in `mikro.config.ts` under `watchdog`, not from code. */
export declare const watchdog: Watchdog
