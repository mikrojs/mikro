import { defineConfig } from "mikro";

// Project configuration. See https://mikrojs.dev/config for all options.
export default defineConfig({
  // Set to your country code so WiFi uses the correct regulatory domain.
  wifi: { country: "NO" },
});
