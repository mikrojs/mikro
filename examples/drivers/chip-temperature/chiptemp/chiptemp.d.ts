import type {Result} from 'mikro/result'

export type ChipTemperatureError = {name: 'ChipTemperatureError'; message: string}

export interface ChipTemperature {
  /** The chip's temperature in degrees Celsius. */
  read(): Result<number, ChipTemperatureError>
  /** Stops the sensor. Calling it again does nothing. */
  end(): void
}

/**
 * Starts the chip's internal temperature sensor. Only one handle can be open at
 * a time. The original ESP32 has no such sensor and returns an error.
 */
export declare function ChipTemperature(): Result<ChipTemperature, ChipTemperatureError>
