import spinners from 'cli-spinners'
import {Box, Text, useInput} from 'ink'
import SelectInput from 'ink-select-input'
import React, {type ReactNode, useCallback, useEffect, useState} from 'react'

import {type PortInfo, useDevices} from '../hooks/useDevices.js'
import {
  deviceDisplayName,
  getDeviceAlias,
  matchPortToken,
  setDeviceAlias,
} from '../lib/deviceAliases.js'
import {getCachedChip, getCachedDeviceId} from '../lib/deviceCache.js'
import {deviceIdFromSerial} from '../lib/deviceId.js'
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
  // Aligned columns (name | path | detail). Name is the alias, else a suggested
  // color-animal name (what `r` would assign), else "(unknown)".
  const rows = devices.map((device) => {
    const chip = getCachedChip(device.serialNumber)
    return {
      device,
      name: deviceDisplayName(device.serialNumber),
      detail: `(${[chip, device.serialNumber].filter(Boolean).join(' · ')})`,
    }
  })
  const wName = Math.max(0, ...rows.map((r) => r.name.length))
  const wPath = Math.max(0, ...rows.map((r) => r.device.path.length))
  const items: Item<PortInfo>[] = rows.map((r) => {
    const cols = [r.name.padEnd(wName), r.device.path.padEnd(wPath), r.detail]
    return {key: r.device.path, label: cols.join('  '), value: r.device}
  })

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
          if (!name) return
          const serial = mode.device.serialNumber
          if (!serial) {
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

      // List mode: `r` names the highlighted device. Prefill with the existing
      // alias, else a suggested color-animal name seeded by the device id.
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
            {devices.map((device, i) => (
              <Text key={device.path}>
                {i + 1}. {device.path} ({device.manufacturer} {device.serialNumber})
              </Text>
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
        {devices.map((d) => (
          <Text key={d.path}>
            {'  '}
            {d.path} ({d.manufacturer ?? ''} {d.serialNumber ?? ''})
          </Text>
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
            <Text>Name for {mode.device.path}: </Text>
            <TextInput value={input.value} cursor={input.cursor} placeholder="my-device" />
          </Box>
          {mode.error ? <Text color="red">{mode.error}</Text> : null}
          <Text dimColor>Enter to save · Esc to cancel</Text>
        </Box>
      ) : (
        <Text dimColor>Press r to rename the selected device</Text>
      )}
    </Box>
  )
}
