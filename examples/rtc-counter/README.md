# RTC Counter

Counts wake-ups from deep sleep using RTC memory. Prints `Wake #0`, `Wake #1`, and so on. The counter survives deep sleep but resets on power loss.

```sh
npm create mikro -- --template rtc-counter
```

Cycle: print count, increment, wait 5s, deep sleep 15s, repeat.

## Run

```sh
npx mikro dev       # develop on connected device
npx mikro deploy    # build and deploy to device
```
