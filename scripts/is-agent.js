process.exit((await (await import('@vercel/detect-agent')).determineAgent()).isAgent ? 0 : 1)
