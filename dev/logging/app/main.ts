import {sleep} from 'mikrojs/sleep'

console.debug('Debug!')
console.log('Log!')
console.info('Info!')
console.warn('Warn!')
console.error('Error!')

console.log(`-- sleep --`)
await sleep(2000)

console.debug('Debug!')
console.log('Log!')
console.info('Info!')
console.warn('Warn!')
console.error('Error!')
