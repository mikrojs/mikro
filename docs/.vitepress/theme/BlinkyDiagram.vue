<template>
  <svg viewBox="0 0 400 220" xmlns="http://www.w3.org/2000/svg" class="blinky-diagram">
    <!-- Microcontroller -->
    <rect x="20" y="40" width="120" height="140" rx="8" class="mcu-body" />
    <text x="80" y="75" text-anchor="middle" class="mcu-label">ESP32</text>

    <!-- Pin labels -->
    <text x="135" y="108" class="pin-label" text-anchor="end">GPIO 15</text>
    <text x="135" y="148" class="pin-label" text-anchor="end">GND</text>

    <!-- Pin dots -->
    <circle cx="140" cy="105" r="3" class="pin-dot" />
    <circle cx="140" cy="145" r="3" class="pin-dot" />

    <!-- Wire from GPIO to resistor -->
    <line x1="143" y1="105" x2="200" y2="105" class="wire" />

    <!-- Resistor -->
    <rect x="200" y="95" width="50" height="20" rx="3" class="resistor" />
    <text x="225" y="90" text-anchor="middle" class="component-label">330&#8486;</text>

    <!-- Wire from resistor to LED anode -->
    <line x1="250" y1="105" x2="300" y2="105" class="wire" />

    <!-- LED -->
    <!-- Triangle (anode side) -->
    <polygon points="300,88 300,122 330,105" class="led-body" />
    <!-- Cathode bar -->
    <line x1="330" y1="88" x2="330" y2="122" class="led-cathode" />
    <!-- Light rays -->
    <line x1="322" y1="82" x2="328" y2="72" class="led-ray" />
    <line x1="330" y1="80" x2="336" y2="70" class="led-ray" />

    <text x="315" y="140" text-anchor="middle" class="component-label">LED</text>

    <!-- Wire from LED cathode down to GND line -->
    <line x1="330" y1="105" x2="370" y2="105" class="wire" />
    <line x1="370" y1="105" x2="370" y2="145" class="wire" />

    <!-- GND wire -->
    <line x1="143" y1="145" x2="370" y2="145" class="wire gnd-wire" />
  </svg>
</template>

<style scoped>
.blinky-diagram {
  width: 100%;
  max-width: 400px;
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

.pin-dot {
  fill: var(--vp-c-text-2);
}

.wire {
  stroke: var(--vp-c-text-2);
  stroke-width: 1.5;
  fill: none;
}

.gnd-wire {
  stroke-dasharray: 4 3;
}

.resistor {
  fill: none;
  stroke: var(--vp-c-text-2);
  stroke-width: 1.5;
}

.component-label {
  fill: var(--vp-c-text-3);
  font-size: 10px;
  font-family: var(--vp-font-family-base);
}

.led-body {
  fill: var(--vp-c-brand-1);
  opacity: 0.8;
  stroke: var(--vp-c-brand-1);
  stroke-width: 1.5;
}

.led-cathode {
  stroke: var(--vp-c-text-2);
  stroke-width: 2;
}

.led-ray {
  stroke: var(--vp-c-brand-1);
  stroke-width: 1;
  opacity: 0.6;
}
</style>
