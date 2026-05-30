/* Generate the contents of `.env.example` (and the gitignored `.env`)
 * for a scaffolded project. If the template declares its consumed env
 * vars in TEMPLATES.envVars, list them as empty assignments. Otherwise
 * emit a generic header with a couple of commented-out examples. */
export function envExample(vars: readonly string[] = []): string {
  if (vars.length > 0) {
    return vars.map((v) => `${v}=`).join('\n') + '\n'
  }
  return `\
# Copy this file to .env and add environment variables for your project.
# .env, .env.development, .env.production, .env.test, and .env.simulator
# are auto-loaded by \`mikro\` and pushed to the device on deploy.
# Names must be 15 characters or fewer (NVS key limit).

# WIFI_SSID=
# WIFI_PASSPHRASE=
`
}
