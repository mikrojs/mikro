import {version} from 'mikrojs/sys'

// NOTE: the `import` above is load-bearing. A module with zero imports
// currently breaks the on-device bytecode eval path (tracked separately),
// so even though this fixture doesn't need `version`, keep at least one
// import from 'mikrojs/*' here so the module has an import section.
console.log(`crashloop fixture booting v${version} — this app is designed to crash`)

// Uncaught synchronous throw. With restartOnUncaughtException=true in
// mikro.config.ts, the runtime catches this and calls esp_restart() after
// a 500ms delay, so the device enters a tight reboot cycle.
//
// Alternative forcible variant (uncomment to bypass the runtime entirely):
//
//   import {restart} from 'mikrojs/sys'
//   restart()
// eslint-disable-next-line @mikrojs/no-throw
throw new Error('intentional crash from crashloop fixture')
