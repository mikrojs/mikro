import {boolean, type InferRead, number, object} from 'mikro/schema'

/** One definition, three consumers: `mikro.config.ts` serializes it into the
 *  build for the registry to store and render a form from, `InferRead` types
 *  the reads in app code (via the global registration below), and every
 *  document the device receives was validated against it. */
export const ConfigSchema = object({
  /** Milliseconds for one full breathe cycle (fade up + fade down). */
  interval: number({default: 400}),
  on: boolean({default: true}),
  pwm: object({duty: number({default: 1.0}), freq: number({default: 50})}),
  /** GPIO the LED is wired to. Boards differ (15 on XIAO boards, 8 on many
   *  devkits), which is exactly what per-device configuration is for. */
  pin: number({default: 15}),
  /** Milliseconds between registry check-ins. A minute keeps the demo
   *  responsive; raise it per device once you stop watching the console.
   *  The client floors this at 30s. */
  checkinInterval: number({default: 60_000}),
})

// Types bare ota.config() app-wide; see https://mikrojs.dev/api/ota#ota-config
declare global {
  interface OtaConfig extends InferRead<typeof ConfigSchema> {}
}
