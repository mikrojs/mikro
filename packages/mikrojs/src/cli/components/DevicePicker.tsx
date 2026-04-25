import spinners from 'cli-spinners'
import {Box, Text, useInput} from 'ink'
import SelectInput from 'ink-select-input'
import React, {type ReactNode, useCallback, useMemo, useState} from 'react'

import {type PortInfo, useDevices} from '../hooks/useDevices.js'
import {RenderAndExit} from '../lib/RenderAndExit.js'
import {Spinner} from '../lib/Spinner.js'

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
  const deviceDiscovery = useDevices(pollingEnabled)

  const handleSelect = useCallback((item: Item<PortInfo>) => {
    setSelectedDevice(item.value)
    setPollingEnabled(false)
  }, [])

  const devices = deviceDiscovery.status === 'success' ? deviceDiscovery.value : EMPTY_ARRAY
  const items: Item<PortInfo>[] = useMemo(
    () =>
      devices.map((device) => ({
        key: device.path,
        label: `${device.path} (${[
          device.serialNumber ? `serialNumber=${device.serialNumber}` : '',
          device.manufacturer ? `manufacturer=${device.manufacturer}` : '',
          device.vendorId ? `vendorId=${device.vendorId}` : '',
        ]
          .filter(Boolean)
          .join(', ')})`,
        value: device,
      })),
    [devices],
  )

  const device = port
    ? devices.find((dev) => dev.path === port)
    : devices.length === 1
      ? devices[0]
      : undefined

  const selectedDeviceNotFound = port && deviceDiscovery.status === 'success' && !device
  const isInteractive = process.stdin.isTTY === true
  const current = device || selectedDevice

  // Allow Ctrl+C / Ctrl+Q to exit before a device is selected
  useInput(
    (_ch, key) => {
      if (key.ctrl && (_ch === 'c' || _ch === 'q')) {
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
            {devices.map((device, i) => (
              <Text key={device.path}>
                {i + 1}. {device.path} ({device.manufacturer} {device.serialNumber})
              </Text>
            ))}
          </Box>
        ) : (
          <Text>No devices found</Text>
        )}
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
      <Text>
        <Spinner spinner={spinners.dots} /> Waiting for device…
      </Text>
    )
  }

  return (
    <>
      <Text>Select device</Text>
      <SelectInput items={items} onSelect={handleSelect} />
    </>
  )
}
