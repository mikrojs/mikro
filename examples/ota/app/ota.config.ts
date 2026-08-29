import {boolean, type InferRead, number, object} from 'mikro/schema'

/** One definition, three consumers: `mikro.config.ts` serializes it into the
 *  build for the registry to store and render a form from, `InferRead` types
 *  the reads in app code (via the global registration below), and every
 *  document the device receives was validated against it.
 *
 *  The annotations are what make the registry's form usable: a title and a
 *  description instead of a field name, a unit so 60000 reads as a minute, and
 *  bounds so an operator cannot save a value this board cannot survive. */
export const ConfigSchema = object({
  interval: number({
    title: 'Breathe cycle',
    description: 'One full fade up and back down.',
    unit: 'ms',
    default: 400,
    min: 50,
    max: 10_000,
    integer: true,
  }),
  on: boolean({
    default: true,
    title: 'Enabled',
    description: 'Turn the effect off without redeploying.',
  }),
  pwm: object(
    {
      duty: number({
        title: 'Peak brightness',
        description: 'Ratio, not a percentage: 1 is full brightness.',
        unit: '/',
        default: 1.0,
        min: 0,
        max: 1,
      }),
      freq: number({title: 'Frequency', unit: 'Hz', default: 50, min: 1, max: 40_000}),
    },
    {title: 'PWM'},
  ),
  /* The bounds here are the point of the exercise: an operator once PUT 200 on
   * a live board, which is schema-valid as a bare number and fatal as a pin.
   * They cannot express which pins a given chip actually has, so the app still
   * has to cope with a legal-but-wrong pin. */
  pin: number({
    title: 'LED pin',
    description: 'GPIO the LED is wired to. 15 on XIAO boards, 8 on many devkits.',
    default: 15,
    min: 0,
    max: 30,
    integer: true,
  }),
  checkinInterval: number({
    title: 'Check-in interval',
    description: 'How often the device asks the registry for work. The client floors this at 30s.',
    unit: 'ms',
    default: 60_000,
    min: 30_000,
    integer: true,
  }),
})

// Types bare ota.config() app-wide; see https://mikrojs.dev/api/ota#ota-config
declare global {
  interface OtaConfig extends InferRead<typeof ConfigSchema> {}
}
