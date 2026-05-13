import { rtcStorage } from "mikrojs/kv/rtc";
import * as s from "mikrojs/schema";
import { deepSleep, sleep } from "mikrojs/sleep";

// Read the wake counter from RTC memory (survives deep sleep).
// optional() because the key may not exist on first boot.
const count = rtcStorage.createValue("count", {
  schema: s.optional(s.number()),
});

console.log(`Wake #${count.get() ?? 0}`);
console.log(`RTC memory: ${rtcStorage.info().used}/${rtcStorage.info().total} bytes used`);

// Increment and store back
count.update((n) => (n ?? 0) + 1).orPanic("failed to store count");

console.log("Waiting for a few seconds before going to deep sleep...");
await sleep(5000);

// Sleep for 15 seconds, then wake up again
console.log("Going to deep sleep for 15s...");
deepSleep(15000);
