#!/usr/bin/env node

// The mikrojs package was renamed to mikro. This stub exists only to point
// users at the new package; it intentionally fails rather than proxying.
process.stderr.write(
  'The "mikrojs" package has been renamed to "mikro".\n' +
    'Install "mikro" and use the "mikro" command instead.\n' +
    'See https://github.com/mikrojs/mikro for details.\n',
)
process.exitCode = 1
