<template>
  <svg viewBox="0 0 420 260" xmlns="http://www.w3.org/2000/svg" class="neopixel-diagram">
    <!-- Microcontroller -->
    <rect x="20" y="50" width="120" height="160" rx="8" class="mcu-body" />
    <text x="80" y="88" text-anchor="middle" class="mcu-label">ESP32</text>

    <!-- Pin labels -->
    <text x="135" y="123" class="pin-label" text-anchor="end">GPIO 8</text>
    <text x="135" y="163" class="pin-label" text-anchor="end">5V</text>
    <text x="135" y="203" class="pin-label" text-anchor="end">GND</text>

    <!-- Pin dots -->
    <circle cx="140" cy="120" r="3" class="pin-dot" />
    <circle cx="140" cy="160" r="3" class="pin-dot pin-dot-power" />
    <circle cx="140" cy="200" r="3" class="pin-dot" />

    <!-- NeoPixel ring -->
    <circle cx="320" cy="120" r="70" class="ring-body" />
    <circle cx="320" cy="120" r="55" class="ring-inner" />
    <text x="320" y="118" text-anchor="middle" class="ring-label">NeoPixel</text>
    <text x="320" y="133" text-anchor="middle" class="ring-sublabel">24 LEDs</text>

    <!-- LED dots around the ring (rainbow) -->
    <circle
      v-for="i in 24"
      :key="i"
      :cx="320 + 62.5 * Math.cos((i - 1) * ((2 * Math.PI) / 24) - Math.PI / 2)"
      :cy="120 + 62.5 * Math.sin((i - 1) * ((2 * Math.PI) / 24) - Math.PI / 2)"
      r="4"
      class="led-dot"
      :style="{fill: `hsl(${(i - 1) * 15}, 90%, 60%)`}"
    />

    <!-- Wire: GPIO 8 → DIN (signal) -->
    <line x1="143" y1="120" x2="170" y2="120" class="wire wire-signal" />
    <line x1="170" y1="120" x2="170" y2="100" class="wire wire-signal" />
    <line x1="170" y1="100" x2="247" y2="100" class="wire wire-signal" />

    <!-- Wire: 5V → 5V (power) -->
    <line x1="143" y1="160" x2="195" y2="160" class="wire wire-power" />
    <line x1="195" y1="160" x2="195" y2="117" class="wire wire-power" />
    <line x1="195" y1="117" x2="247" y2="117" class="wire wire-power" />

    <!-- Wire: GND → GND -->
    <line x1="143" y1="200" x2="220" y2="200" class="wire gnd-wire" />
    <line x1="220" y1="200" x2="220" y2="134" class="wire gnd-wire" />
    <line x1="220" y1="134" x2="247" y2="134" class="wire gnd-wire" />

    <!-- Pad dots on ring (clustered on left edge) -->
    <circle cx="250" cy="100" r="3" class="pin-dot" />
    <circle cx="250" cy="117" r="3" class="pin-dot pin-dot-power" />
    <circle cx="250" cy="134" r="3" class="pin-dot" />

    <!-- Ring pad labels (left of pad dots, rendered over wires) -->
    <text x="243" y="103" class="pad-label" text-anchor="end">DIN</text>
    <text x="243" y="120" class="pad-label" text-anchor="end">5V</text>
    <text x="243" y="137" class="pad-label" text-anchor="end">GND</text>
  </svg>
</template>

<style scoped>
.neopixel-diagram {
  width: 100%;
  max-width: 420px;
  margin: 0 auto;
  display: block;
}

.mcu-body {
  fill: var(--vp-c-bg-soft);
  stroke: var(--vp-c-text-2);
  stroke-width: 1.5;
}

.mcu-label {
  fill: var(--vp-c-text-1);
  font-size: 14px;
  font-weight: 600;
  font-family: var(--vp-font-family-base);
}

.pin-label {
  fill: var(--vp-c-text-2);
  font-size: 11px;
  font-family: var(--vp-font-family-mono);
}

.pad-label {
  fill: var(--vp-c-text-2);
  font-size: 10px;
  font-family: var(--vp-font-family-mono);
  stroke: var(--vp-c-bg);
  stroke-width: 4;
  stroke-opacity: 0.8;
  paint-order: stroke fill;
}

.pin-dot {
  fill: var(--vp-c-text-2);
}

.pin-dot-power {
  fill: #e53935;
}

.wire {
  stroke: var(--vp-c-text-2);
  stroke-width: 1.5;
  fill: none;
}

.wire-signal {
  stroke: var(--vp-c-brand-1);
}

.wire-power {
  stroke: #e53935;
}

.gnd-wire {
  stroke-dasharray: 4 3;
}

.ring-body {
  fill: none;
  stroke: var(--vp-c-text-2);
  stroke-width: 1.5;
}

.ring-inner {
  fill: var(--vp-c-bg-soft);
  stroke: var(--vp-c-text-2);
  stroke-width: 1;
  stroke-dasharray: 2 3;
}

.ring-label {
  fill: var(--vp-c-text-1);
  font-size: 13px;
  font-weight: 600;
  font-family: var(--vp-font-family-base);
}

.ring-sublabel {
  fill: var(--vp-c-text-2);
  font-size: 10px;
  font-family: var(--vp-font-family-base);
}

.led-dot {
  fill: var(--vp-c-brand-1);
  opacity: 0.7;
}
</style>
