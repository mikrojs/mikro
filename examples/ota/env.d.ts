declare interface ImportMetaEnv {
  WIFI_SSID: string
  WIFI_PASSPHRASE: string
  /** GPIO of an LED to blink as a visible heartbeat (e.g. 15 on XIAO boards). */
  LED_PIN?: string
}
