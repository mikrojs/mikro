async function oom() {
  await new Promise((resolve) => setTimeout(resolve, 100))
  await oom()
}

await oom()
