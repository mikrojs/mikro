import {Color, display, hsvToRgb565, pins} from '@mikrojs/lilygo/t-display'
import {readFile} from 'mikrojs/fs'
import {digitalRead, pinMode} from 'mikrojs/pin'

const W = display.width
const H = display.height

// ── Load PBM image ───────────────────────────────────────────────
function loadPbm(path: string): {width: number; height: number; mask: Uint8Array} {
  const data = readFile(path).orPanic(`Failed to read ${path}`)

  let offset = 0
  while (data[offset] !== 0x0a) offset++
  offset++
  while (data[offset] === 0x23) {
    while (data[offset] !== 0x0a) offset++
    offset++
  }
  let dims = ''
  while (data[offset] !== 0x0a) {
    dims += String.fromCharCode(data[offset]!)
    offset++
  }
  offset++

  const parts = dims.split(' ')
  const width = parseInt(parts[0]!, 10)
  const height = parseInt(parts[1]!, 10)
  const mask = new Uint8Array(width * height)
  const bytesPerRow = Math.ceil(width / 8)

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const byteIdx = offset + y * bytesPerRow + Math.floor(x / 8)
      const bitIdx = 7 - (x % 8)
      if ((data[byteIdx]! >> bitIdx) & 1) {
        mask[y * width + x] = 1
      }
    }
  }
  return {width, height, mask}
}

const logo = loadPbm('/app/static/dvd.pbm')
const LOGO_W = logo.width
const LOGO_H = logo.height

const logoBuf = new Uint8Array(LOGO_W * LOGO_H * 2)

function renderLogo(color: number) {
  const hi = (color >> 8) & 0xff
  const lo = color & 0xff
  for (let i = 0; i < LOGO_W * LOGO_H; i++) {
    const idx = i * 2
    if (logo.mask[i]) {
      logoBuf[idx] = hi
      logoBuf[idx + 1] = lo
    } else {
      logoBuf[idx] = 0
      logoBuf[idx + 1] = 0
    }
  }
}

// ── Score display (tally blocks along the top) ───────────────────
const BLOCK_SIZE = 6
const BLOCK_GAP = 2
const BLOCK_Y = 2
const SCORE_BAR_H = BLOCK_Y + BLOCK_SIZE + 2
const MAX_VISIBLE_SCORE = Math.floor(W / (BLOCK_SIZE + BLOCK_GAP))

function drawScore(score: number) {
  display.fillRect(0, 0, W, BLOCK_Y + BLOCK_SIZE + 2, Color.BLACK)
  const visible = Math.min(score, MAX_VISIBLE_SCORE)
  for (let i = 0; i < visible; i++) {
    const bx = BLOCK_GAP + i * (BLOCK_SIZE + BLOCK_GAP)
    const blockHue = (i * 37) % 360
    display.fillRect(bx, BLOCK_Y, BLOCK_SIZE, BLOCK_SIZE, hsvToRgb565(blockHue, 1, 1))
  }
}

// ── Buttons ──────────────────────────────────────────────────────
pinMode(pins.BTN1, 'INPUT_PULLUP').orPanic('Failed to configure BTN1')
pinMode(pins.BTN2, 'INPUT').orPanic('Failed to configure BTN2')

let btn1Prev = 1
let btn2Prev = 1

// ── Game state ───────────────────────────────────────────────────
display.fillScreen(Color.BLACK)

let x = Math.floor(Math.random() * (W - LOGO_W))
let y = Math.floor(Math.random() * (H - LOGO_H))
let vx = 2
let vy = 1
let hue = 0
let score = 0
let nudges = 0

drawScore(score)

function tick() {
  const btn1 = digitalRead(pins.BTN1)
  const btn2 = digitalRead(pins.BTN2)

  if (btn1 === 0 && btn1Prev === 1) {
    vx += vx > 0 ? 1 : -1
    if (Math.abs(vx) > 6) vx = vx > 0 ? 1 : -1
    nudges++
  }
  if (btn2 === 0 && btn2Prev === 1) {
    vy += vy > 0 ? 1 : -1
    if (Math.abs(vy) > 6) vy = vy > 0 ? 1 : -1
    nudges++
  }
  btn1Prev = btn1
  btn2Prev = btn2

  const prevX = x
  const prevY = y

  x += vx
  y += vy

  let bounced = false
  if (x <= 0) {
    x = 0
    vx = Math.abs(vx)
    bounced = true
  }
  if (x + LOGO_W >= W) {
    x = W - LOGO_W
    vx = -Math.abs(vx)
    bounced = true
  }
  if (y <= SCORE_BAR_H) {
    y = SCORE_BAR_H
    vy = Math.abs(vy)
    bounced = true
  }
  if (y + LOGO_H >= H) {
    y = H - LOGO_H
    vy = -Math.abs(vy)
    bounced = true
  }

  if (bounced) {
    hue = (hue + 47) % 360
  }

  const atCornerX = x === 0 || x === W - LOGO_W
  const atCornerY = y === SCORE_BAR_H || y === H - LOGO_H
  if (atCornerX && atCornerY) {
    score++
    console.log(`CORNER HIT! Score: ${score} (${nudges} nudges)`)
    nudges = 0

    display.fillScreen(Color.WHITE)
    renderLogo(Color.BLACK)
    display.drawBitmap(x, y, LOGO_W, LOGO_H, logoBuf)

    setTimeout(() => {
      display.fillScreen(Color.BLACK)
      drawScore(score)
      vx = (1 + Math.floor(Math.random() * 3)) * (Math.random() > 0.5 ? 1 : -1)
      vy = (1 + Math.floor(Math.random() * 3)) * (Math.random() > 0.5 ? 1 : -1)
      setTimeout(tick, 16)
    }, 500)
    return
  }

  const dx = x - prevX
  const dy = y - prevY

  if (dx > 0) display.fillRect(prevX, prevY, dx, LOGO_H, Color.BLACK)
  else if (dx < 0) display.fillRect(x + LOGO_W, prevY, -dx, LOGO_H, Color.BLACK)

  if (dy > 0) display.fillRect(prevX, prevY, LOGO_W, dy, Color.BLACK)
  else if (dy < 0) display.fillRect(prevX, y + LOGO_H, LOGO_W, -dy, Color.BLACK)

  renderLogo(hsvToRgb565(hue, 1, 1))
  display.drawBitmap(x, y, LOGO_W, LOGO_H, logoBuf)

  setTimeout(tick, 30)
}

console.log('DVD Corner Hunt! BTN1=nudge horizontal, BTN2=nudge vertical')
tick()
