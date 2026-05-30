import {sleep} from 'mikro/sleep'

await sleep(1000)
console.log('hello…')

// eslint-disable-next-line
Promise.reject(new Error('this is the error'))
