/* Generate the contents of `.env.example` (and the gitignored `.env`)
 * for a scaffolded project. If the template declares its consumed env
 * vars in TEMPLATES.envVars, list them commented out. An empty
 * assignment would deploy as an empty string, and `env.require` would
 * hand that to the app instead of reporting the variable as unset. */
export function envExample(vars: readonly string[] = []): string {
  if (vars.length > 0) {
    return (
      '# Uncomment and fill in the values this project needs.\n' +
      vars.map((v) => `# ${v}=`).join('\n') +
      '\n'
    )
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
