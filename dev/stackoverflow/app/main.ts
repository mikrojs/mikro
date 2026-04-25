import {sleep} from 'mikrojs/sleep'

function run(frames: number) {
  console.log(`stack frame no ${frames}`)
  run(frames + 1)
}

let countdown = 6
while (countdown--) {
  console.log(`bombing the stack in ${countdown}s`)
  await sleep(1000)
}

run(0)
