async function start() {
  const {dep2} = await import('./dep2')
  return dep2
}

start()

export const dep1 = 'dep1'
