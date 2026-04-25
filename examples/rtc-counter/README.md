# RTC Counter

Counts wake-ups from deep sleep using RTC memory. Prints `Wake #0`, `Wake #1`, ... — the counter survives deep sleep but resets on power loss.

```sh
npm create mikrojs my-rtc-counter --template rtc-counter
```

Cycle: print count, increment, wait 5s, deep sleep 15s, repeat.

## Run

```sh
npx mikro dev       # develop on connected device
npx mikro deploy    # build and deploy to device
```
