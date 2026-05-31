import spinners from 'cli-spinners'
import {Box, Text, useInput} from 'ink'
import SelectInput from 'ink-select-input'
import React, {type ReactNode, useCallback, useEffect, useState} from 'react'

import {type PortInfo, useDevices} from '../hooks/useDevices.js'
import {
  getDeviceAlias,
  matchPortToken,
  removeDeviceAlias,
  setDeviceAlias,
} from '../lib/deviceAliases.js'
import {getCachedDeviceId} from '../lib/deviceCache.js'
import {deviceIdFromSerial} from '../lib/deviceId.js'
import {formatDeviceList} from '../lib/deviceLabel.js'
import {RenderAndExit} from '../lib/RenderAndExit.js'
import {Spinner} from '../lib/Spinner.js'
import {suggestDeviceName} from '../lib/suggestName.js'
import {TROUBLESHOOTING_HINT_DELAY_MS, TroubleshootingHint} from '../lib/troubleshooting.js'
import {EMPTY_INPUT, type InputState, reduceInput, TextInput} from './TextInput.js'

type Item<V> = {
  key?: string
  label: string
  value: V
}

const EMPTY_ARRAY: never[] = []

type Props = {
  port?: string
  children: (device: PortInfo) => ReactNode
}

export function DevicePicker(props: Props) {
  const {port, children} = props
  const [selectedDevice, setSelectedDevice] = useState<PortInfo>()
  // Stop polling once a device is selected or auto-detected (avoid SerialPort.list() interfering with open port)
  const [pollingEnabled, setPollingEnabled] = useState(true)
  const [waitingTooLong, setWaitingTooLong] = useState(false)
  const [highlighted, setHighlighted] = useState<PortInfo>()
  const [mode, setMode] = useState<
    {type: 'list'} | {type: 'rename'; device: PortInfo; error?: string}
  >({type: 'list'})
  const [input, setInput] = useState<InputState>(EMPTY_INPUT)
  // Bumped after saving an alias to recompute the labels below.
  const [, setAliasTick] = useState(0)
  const deviceDiscovery = useDevices(pollingEnabled)

  useEffect(() => {
    const id = setTimeout(() => setWaitingTooLong(true), TROUBLESHOOTING_HINT_DELAY_MS)
    return () => clearTimeout(id)
  }, [])

  const handleSelect = useCallback((item: Item<PortInfo>) => {
    setSelectedDevice(item.value)
    setPollingEnabled(false)
  }, [])

  const devices = deviceDiscovery.status === 'success' ? deviceDiscovery.value : EMPTY_ARRAY
  // Canonical "name  path  (chip=…, id=…)" lines, one item per device.
  const labels = formatDeviceList(devices)
  const items: Item<PortInfo>[] = devices.map((device, i) => ({
    key: device.path,
    label: labels[i]!,
    value: device,
  }))

  const device = port
    ? matchPortToken(devices, port)
    : devices.length === 1
      ? devices[0]
      : undefined

  const selectedDeviceNotFound = port && deviceDiscovery.status === 'success' && !device
  const isInteractive = process.stdin.isTTY === true
  const current = device || selectedDevice

  // Handle Ctrl+C/Ctrl+Q exit, the rename flow, and the `r` rename trigger
  // while a device is still being picked.
  useInput(
    (ch, key) => {
      if (key.ctrl && (ch === 'c' || ch === 'q')) {
        process.exit(0)
      }

      if (mode.type === 'rename') {
        if (key.escape) {
          setInput(EMPTY_INPUT)
          setMode({type: 'list'})
          return
        }
        if (key.return) {
          const name = input.value.trim()
          const serial = mode.device.serialNumber
          if (!serial) {
            setInput(EMPTY_INPUT)
            setMode({type: 'list'})
            return
          }
          // Empty input clears an existing alias (reverting to the generated
          // name); with no alias to clear it's just a cancel.
          if (!name) {
            if (getDeviceAlias(serial)) {
              removeDeviceAlias(serial)
              setAliasTick((n) => n + 1)
            }
            setInput(EMPTY_INPUT)
            setMode({type: 'list'})
            return
          }
          const result = setDeviceAlias(serial, name)
          if (!result.ok) {
            setMode({type: 'rename', device: mode.device, error: result.error})
            return
          }
          setInput(EMPTY_INPUT)
          setMode({type: 'list'})
          setAliasTick((n) => n + 1)
          return
        }
        const next = reduceInput(input, ch, key)
        if (next) setInput(next)
        return
      }

      // List mode: `r` sets an alias for the highlighted device. Prefill with the
      // existing alias, else the generated name seeded by the device id.
      if (ch === 'r') {
        const target = highlighted ?? devices[0]
        if (!target) return
        const seed =
          deviceIdFromSerial(target.serialNumber) ??
          getCachedDeviceId(target.serialNumber) ??
          target.serialNumber
        const prefill = getDeviceAlias(target.serialNumber) ?? (seed ? suggestDeviceName(seed) : '')
        setInput(prefill ? {value: prefill, cursor: prefill.length} : EMPTY_INPUT)
        setMode({type: 'rename', device: target})
      }
    },
    {isActive: !current},
  )

  // Stop polling once a device is auto-detected (single device or port match)
  if (current && pollingEnabled) {
    setPollingEnabled(false)
  }

  if (deviceDiscovery.status === 'error') {
    return (
      <RenderAndExit exitCode={1}>
        <Text color="red">Error: {deviceDiscovery.error.message}</Text>
      </RenderAndExit>
    )
  }

  if (selectedDeviceNotFound) {
    return (
      <RenderAndExit exitCode={1}>
        <Text color="red">Error: Device not found: {port}</Text>
        {devices.length > 0 ? (
          <Box paddingTop={1} flexDirection="column">
            <Text>Connected devices:</Text>
            {formatDeviceList(devices).map((line, i) => (
              <Text key={devices[i]!.path}>{line}</Text>
            ))}
          </Box>
        ) : (
          <Text>No devices found</Text>
        )}
        <TroubleshootingHint />
      </RenderAndExit>
    )
  }

  if (current) {
    return <>{children(current)}</>
  }

  // Non-interactive: error on ambiguous or missing devices instead of showing interactive UI
  if (!isInteractive && deviceDiscovery.status === 'success' && devices.length === 0) {
    return (
      <RenderAndExit exitCode={1}>
        <Text color="red">Error: No serial devices found</Text>
        <TroubleshootingHint />
      </RenderAndExit>
    )
  }
  if (!isInteractive && deviceDiscovery.status === 'success' && devices.length > 1) {
    return (
      <RenderAndExit exitCode={1}>
        <Text color="red">Error: Multiple devices found. Use --port to select one:</Text>
        {formatDeviceList(devices).map((line, i) => (
          <Text key={devices[i]!.path}>{line}</Text>
        ))}
      </RenderAndExit>
    )
  }

  if (devices.length === 0) {
    return (
      <Box flexDirection="column">
        <Text>
          <Spinner spinner={spinners.dots} /> Waiting for device…
        </Text>
        {waitingTooLong && <TroubleshootingHint prefix="Is the device plugged in?" />}
        <Text dimColor>Press Ctrl+C to cancel</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Text>Select device</Text>
      <SelectInput
        items={items}
        onSelect={handleSelect}
        onHighlight={(item) => setHighlighted(item.value)}
        isFocused={mode.type === 'list'}
      />
      {mode.type === 'rename' ? (
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Text>Alias for {mode.device.path}: </Text>
            <TextInput value={input.value} cursor={input.cursor} placeholder="my-device" />
          </Box>
          {mode.error ? <Text color="red">{mode.error}</Text> : null}
          <Text dimColor>
            Enter to save · Esc to cancel
            {getDeviceAlias(mode.device.serialNumber) ? ' · clear to remove the alias' : ''}
          </Text>
        </Box>
      ) : (
        <Text dimColor>Press r to set an alias for the selected device</Text>
      )}
    </Box>
  )
}
