import spinners from 'cli-spinners'
import {Box, Text, useInput} from 'ink'
import SelectInput from 'ink-select-input'
import React, {type ReactNode, useCallback, useEffect, useState} from 'react'

import {type PortInfo, useDevices} from '../hooks/useDevices.js'
import {formatDeviceList} from '../lib/deviceLabel.js'
import {matchPortToken} from '../lib/deviceName.js'
import {RenderAndExit} from '../lib/RenderAndExit.js'
import {Spinner} from '../lib/Spinner.js'
import {TROUBLESHOOTING_HINT_DELAY_MS, TroubleshootingHint} from '../lib/troubleshooting.js'

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

  // Handle Ctrl+C/Ctrl+Q exit while a device is still being picked. Naming a
  // device lives in `mikro name`, which writes it over a session — the picker
  // only selects.
  useInput(
    (ch, key) => {
      if (key.ctrl && (ch === 'c' || ch === 'q')) {
        process.exit(0)
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
      <SelectInput items={items} onSelect={handleSelect} />
    </Box>
  )
}
