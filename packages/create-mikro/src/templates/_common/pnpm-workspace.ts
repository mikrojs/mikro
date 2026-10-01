/** For apps: pnpm stops an install over install scripts nobody has decided
 *  on, and this skips them all without naming packages. It also skips the
 *  project's own `prepack`, which a board package needs. */
export const pnpmWorkspace = `\
# No dependency of this project needs its install script, and pnpm stops an
# install over scripts it has no decision for. Remove this line if you add a
# dependency that needs one, or install scripts of your own.
ignoreScripts: true
`
