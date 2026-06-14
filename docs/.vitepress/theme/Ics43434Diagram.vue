<template>
  <svg viewBox="0 0 460 320" xmlns="http://www.w3.org/2000/svg" class="ics43434-diagram">
    <!-- Microcontroller -->
    <rect x="20" y="70" width="120" height="230" rx="8" class="mcu-body" />
    <text x="80" y="100" text-anchor="middle" class="mcu-label">ESP32</text>

    <!-- Pin labels -->
    <text x="135" y="134" class="pin-label" text-anchor="end">3V3</text>
    <text x="135" y="164" class="pin-label" text-anchor="end">GPIO 4</text>
    <text x="135" y="194" class="pin-label" text-anchor="end">GPIO 5</text>
    <text x="135" y="224" class="pin-label" text-anchor="end">GPIO 6</text>
    <text x="135" y="254" class="pin-label" text-anchor="end">GND</text>
    <text x="135" y="284" class="pin-label" text-anchor="end">GND</text>

    <!-- Pin dots -->
    <circle cx="140" cy="130" r="3" class="pin-dot pin-dot-power" />
    <circle cx="140" cy="160" r="3" class="pin-dot" />
    <circle cx="140" cy="190" r="3" class="pin-dot" />
    <circle cx="140" cy="220" r="3" class="pin-dot" />
    <circle cx="140" cy="250" r="3" class="pin-dot" />
    <circle cx="140" cy="280" r="3" class="pin-dot" />

    <!-- Microphone breakout -->
    <rect x="320" y="70" width="120" height="230" rx="8" class="mic-body" />
    <text x="380" y="100" text-anchor="middle" class="mic-label">ICS-43434</text>
    <text x="380" y="116" text-anchor="middle" class="mic-sublabel">I2S mic</text>

    <!-- Microphone symbol -->
    <g class="mic-icon">
      <rect x="374" y="18" width="12" height="22" rx="6" class="mic-capsule" />
      <path d="M 369 37 Q 380 51 391 37" class="mic-outline" />
      <line x1="380" y1="44" x2="380" y2="56" class="mic-outline" />
      <line x1="373" y1="56" x2="387" y2="56" class="mic-outline" />
    </g>

    <!-- Pad dots -->
    <circle cx="320" cy="130" r="3" class="pin-dot pin-dot-power" />
    <circle cx="320" cy="160" r="3" class="pin-dot" />
    <circle cx="320" cy="190" r="3" class="pin-dot" />
    <circle cx="320" cy="220" r="3" class="pin-dot" />
    <circle cx="320" cy="250" r="3" class="pin-dot" />
    <circle cx="320" cy="280" r="3" class="pin-dot" />

    <!-- Pad labels -->
    <text x="328" y="134" class="pad-label" text-anchor="start">VDD</text>
    <text x="328" y="164" class="pad-label" text-anchor="start">SCK</text>
    <text x="328" y="194" class="pad-label" text-anchor="start">WS</text>
    <text x="328" y="224" class="pad-label" text-anchor="start">SD</text>
    <text x="328" y="254" class="pad-label" text-anchor="start">GND</text>
    <text x="328" y="284" class="pad-label" text-anchor="start">L/R</text>

    <!-- Wires (left aligned to right: ESP32 pin -> mic pad) -->
    <line x1="143" y1="130" x2="317" y2="130" class="wire wire-power" />
    <line x1="143" y1="160" x2="317" y2="160" class="wire wire-signal" />
    <line x1="143" y1="190" x2="317" y2="190" class="wire wire-signal" />
    <line x1="143" y1="220" x2="317" y2="220" class="wire wire-signal" />
    <line x1="143" y1="250" x2="317" y2="250" class="wire gnd-wire" />
    <line x1="143" y1="280" x2="317" y2="280" class="wire gnd-wire" />
  </svg>
</template>

<style scoped>
.ics43434-diagram {
  width: 100%;
  max-width: 460px;
  margin: 0 auto;
  display: block;
}

.mcu-body,
.mic-body {
  fill: var(--vp-c-bg-soft);
  stroke: var(--vp-c-text-2);
  stroke-width: 1.5;
}

.mcu-label,
.mic-label {
  fill: var(--vp-c-text-1);
  font-size: 13px;
  font-weight: 600;
  font-family: var(--vp-font-family-base);
}

.mic-sublabel {
  fill: var(--vp-c-text-2);
  font-size: 10px;
  font-family: var(--vp-font-family-base);
}

.mic-capsule {
  fill: var(--vp-c-text-2);
}

.mic-outline {
  fill: none;
  stroke: var(--vp-c-text-2);
  stroke-width: 1.5;
  stroke-linecap: round;
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
</style>
