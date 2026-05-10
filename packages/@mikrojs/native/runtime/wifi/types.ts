import type {Observable} from '../observable/types.js'
import type {Result} from '../result/types.js'

export type WifiStatus =
  | 'STOPPED'
  | 'IDLE'
  | 'NO_SSID_AVAIL'
  | 'SCAN_COMPLETED'
  | 'CONNECTED'
  | 'CONNECT_FAILED'
  | 'CONNECTION_LOST'
  | 'DISCONNECTED'

export type AuthMode = 'open' | 'wpa2-psk' | 'wpa3-psk' | 'wpa2-wpa3-psk' | 'unknown'

export type PowerSaveMode = 'none' | 'min' | 'max'

// prettier-ignore
// Based on esp_wifi_regulatory.c wifi_country_table
// https://github.com/espressif/esp-idf/blob/484e56869c6f6b8f777cc76d73fc02390587a7c5/components/esp_wifi/regulatory/esp_wifi_regulatory.c#L213
export type WifiCountryCode =
  | "01" | "AD" | "AE" | "AF" | "AI" | "AL" | "AM" | "AN" | "AR" | "AS" | "AT"
  | "AU" | "AW" | "AZ" | "BA" | "BB" | "BD" | "BE" | "BF" | "BG" | "BH" | "BL"
  | "BM" | "BN" | "BO" | "BR" | "BS" | "BT" | "BY" | "BZ" | "CA" | "CF" | "CH"
  | "CI" | "CL" | "CN" | "CO" | "CR" | "CU" | "CX" | "CY" | "CZ" | "DE" | "DK"
  | "DM" | "DO" | "DZ" | "EC" | "EE" | "EG" | "ES" | "ET" | "EU" | "FI" | "FM"
  | "FR" | "GB" | "GD" | "GE" | "GF" | "GH" | "GL" | "GP" | "GR" | "GT" | "GU"
  | "GY" | "HK" | "HN" | "HR" | "HT" | "HU" | "ID" | "IE" | "IL" | "IN" | "IR"
  | "IS" | "IT" | "JM" | "JO" | "JP" | "KE" | "KH" | "KN" | "KP" | "KR" | "KW"
  | "KY" | "KZ" | "LB" | "LC" | "LI" | "LK" | "LS" | "LT" | "LU" | "LV" | "MA"
  | "MC" | "MD" | "ME" | "MF" | "MH" | "MK" | "MN" | "MO" | "MP" | "MQ" | "MR"
  | "MT" | "MU" | "MV" | "MW" | "MX" | "MY" | "NA" | "NG" | "NI" | "NL" | "NO"
  | "NP" | "NZ" | "OM" | "PA" | "PE" | "PF" | "PG" | "PH" | "PK" | "PL" | "PM"
  | "PR" | "PT" | "PW" | "PY" | "QA" | "RE" | "RO" | "RS" | "RU" | "RW" | "SA"
  | "SE" | "SG" | "SI" | "SK" | "SN" | "SR" | "SV" | "SY" | "TC" | "TD" | "TG"
  | "TH" | "TN" | "TR" | "TT" | "TW" | "TZ" | "UA" | "UG" | "US" | "UY" | "UZ"
  | "VC" | "VE" | "VI" | "VN" | "VU" | "WF" | "WS" | "YE" | "YT" | "ZA" | "ZW"

export interface ScanOptions {
  ssid?: string
  channel?: number
  passive?: boolean
}

export interface ScanResult {
  ssid: string
  bssid: string
  channel: number
  rssi: number
  authMode: AuthMode
  hidden: boolean
}

export interface WifiConnectionInfo {
  ip: string
  netmask: string
  gateway: string
}

export interface IpConfig {
  ip: string
  netmask: string
  gateway: string
  dns: string
}

export interface StaticIpConfig {
  ip?: string
  netmask?: string
  gateway?: string
  dns?: string
  dhcp?: boolean
}

export type WifiDisconnectReason = 'no-ssid' | 'auth-failed' | 'connection-lost' | 'disconnected'

export interface ApStationInfo {
  mac: string
  rssi: number
}

export interface ApStartOptions {
  ssid: string
  passphrase?: string
  authMode?: AuthMode
  channel?: number
  hidden?: boolean
  maxConnections?: number
}

export type WifiError =
  | {name: 'InitFailed'; message: string}
  | {name: 'CountryNotSet'}
  | {name: 'StartFailed'; message: string}
  | {name: 'ConnectFailed'; message: string}
  | {name: 'ConnectInProgress'}
  | {name: 'DisconnectFailed'; message: string}
  | {name: 'ScanFailed'; message: string}
  | {name: 'ScanInProgress'}
  | {name: 'NotInitialized'}
  | {name: 'ConfigFailed'; message: string}
  | {name: 'ApStartFailed'; message: string}
  | {name: 'ApStopFailed'; message: string}
  | {name: 'SetFailed'; message: string}
  | {name: 'GetFailed'; message: string}

export interface WifiAp {
  start(options: ApStartOptions): Result<void, WifiError>
  stop(): Result<void, WifiError>
  readonly isActive: boolean
  readonly ip: string | undefined
  readonly stations: ApStationInfo[]
  deauthStation(mac: string): Result<void, WifiError>
  inactiveTimeout: number
  readonly onStationConnect: Observable<ApStationInfo>
  readonly onStationDisconnect: Observable<ApStationInfo>
}

export interface Wifi {
  connect(ssid: string, passphrase: string): Promise<Result<WifiConnectionInfo, WifiError>>
  disconnect(): Result<void, WifiError>
  rssi(): Result<number, WifiError>
  ip(): string | undefined
  status(): WifiStatus
  isConnected: boolean
  scan(opts?: ScanOptions): Promise<Result<ScanResult[], WifiError>>

  readonly onConnect: Observable<WifiConnectionInfo>
  readonly onDisconnect: Observable<WifiDisconnectReason>
  readonly onRssiLow: Observable<number>

  readonly mac: string
  readonly hostname: string | undefined
  ipConfig(): Result<IpConfig | undefined, WifiError>
  ipConfig(opts: StaticIpConfig): Result<void, WifiError>
  ipConfig(opts?: StaticIpConfig): Result<IpConfig | undefined, WifiError> | Result<void, WifiError>

  readonly ap: WifiAp

  txPower: number
  rssiThreshold: number

  powerSave: PowerSaveMode
  readonly country: WifiCountryCode | undefined
}

export declare const wifi: Wifi
