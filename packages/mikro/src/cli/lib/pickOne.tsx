import {Box, render, Text} from 'ink'
import SelectInput from 'ink-select-input'
import React from 'react'

/** Ask in the terminal for one of `items`, with the arrow keys and Enter, as
 *  `mikro flash` asks for a board. For commands that are not Ink apps
 *  themselves; Ctrl+C exits with 130. */
export function pickOne<T extends string>(
  title: string,
  items: {label: string; value: T}[],
): Promise<T> {
  return new Promise((resolve) => {
    let picked = false
    const app = render(
      <Box flexDirection="column">
        <Text>{title}</Text>
        <SelectInput
          items={items}
          onSelect={(item) => {
            picked = true
            app.unmount()
            resolve(item.value)
          }}
        />
      </Box>,
    )
    void app.waitUntilExit().then(() => {
      if (!picked) process.exit(130)
    })
  })
}
