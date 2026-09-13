import { DigitalOut } from "mikro/gpio";
import { sleep } from "mikro/sleep";

// GPIO 15 is the built-in LED on XIAO ESP32C6. Replace with your board's LED pin.
const led = DigitalOut(15).orPanic("Failed to configure LED pin");

let level: 0 | 1 = 0;
while (true) {
  level = level ? 0 : 1;
  led.write(level);
  await sleep(1000);
}
