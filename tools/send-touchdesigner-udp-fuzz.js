#!/usr/bin/env node
const dgram = require('node:dgram')
const fs = require('node:fs')
const path = require('node:path')

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 9001
const MIN_INTERVAL_MS = 1000
const MAX_PACKETS = 12
const OVERSIZED_SAFE_CHARS = 2048
const SOURCE = 'worker2_rr002_udp_fuzz_helper'

const CASE_IDS = [
  'td-udp-001',
  'td-udp-002',
  'td-udp-003',
  'td-udp-004',
  'td-udp-005',
  'td-udp-006'
]

const USAGE = `Usage:
  node tools/send-touchdesigner-udp-fuzz.js [options]

Default mode is dry-run. Use --send to send the bounded packet set.

Options:
  --send                    Send packets. Without this, only print the plan.
  --dry-run                 Print the plan without sending.
  --host <127.x.x.x>        Numeric IPv4 loopback target. Default: 127.0.0.1
  --port <1-65535>          UDP target port. Default: 9001
  --interval-ms <ms>        Delay between packets. Minimum: 1000
  --cases <list|all>        Comma-separated case ids. Default: all
  --run-id <id>             Stable id included in synthetic action ids.
  --touchdesigner-pid <pid> Stop before a send if this PID is not alive.
  --recovery-command <cmd>  Record the agreed recovery command in output.
  --out <path>              Also write the JSON summary to a local file.
  --help                    Show this help.

Case ids:
  td-udp-001 valid start/done ping
  td-udp-002 duplicate start with same action id
  td-udp-003 stale timestamp
  td-udp-004 unknown type/event JSON
  td-udp-005 malformed non-JSON bytes
  td-udp-006 oversized-safe JSON field (${OVERSIZED_SAFE_CHARS} chars)
`

const nowIso = () => new Date().toISOString()

const staleIso = () => new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const parsePositiveInteger = (value, label) => {
  if (!/^\d+$/.test(String(value))) {
    throw new Error(`${label}_must_be_positive_integer`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label}_must_be_positive_integer`)
  }
  return parsed
}

const parseArgs = (argv = process.argv.slice(2)) => {
  const config = {
    dryRun: true,
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    intervalMs: MIN_INTERVAL_MS,
    cases: [...CASE_IDS],
    runId: `rr002_td_udp_${Date.now()}`,
    touchdesignerPid: null,
    recoveryCommand: null,
    out: null,
    help: false
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => {
      index += 1
      if (index >= argv.length) {
        throw new Error(`${arg}_requires_value`)
      }
      return argv[index]
    }

    if (arg === '--send') {
      config.dryRun = false
    } else if (arg === '--dry-run') {
      config.dryRun = true
    } else if (arg === '--host') {
      config.host = next()
    } else if (arg === '--port') {
      config.port = parsePositiveInteger(next(), 'port')
    } else if (arg === '--interval-ms') {
      config.intervalMs = parsePositiveInteger(next(), 'interval_ms')
    } else if (arg === '--cases' || arg === '--case') {
      const value = next()
      config.cases =
        value === 'all'
          ? [...CASE_IDS]
          : value
              .split(',')
              .map((entry) => entry.trim())
              .filter(Boolean)
    } else if (arg === '--run-id') {
      config.runId = next()
    } else if (arg === '--touchdesigner-pid') {
      config.touchdesignerPid = parsePositiveInteger(next(), 'touchdesigner_pid')
    } else if (arg === '--recovery-command') {
      config.recoveryCommand = next()
    } else if (arg === '--out') {
      config.out = next()
    } else if (arg === '--help' || arg === '-h') {
      config.help = true
    } else {
      throw new Error(`unknown_option:${arg}`)
    }
  }

  const unknownCases = config.cases.filter((caseId) => !CASE_IDS.includes(caseId))
  if (unknownCases.length > 0) {
    throw new Error(`unknown_case:${unknownCases.join(',')}`)
  }

  return config
}

const isNumericIpv4Loopback = (host) => {
  const parts = String(host).split('.')
  if (parts.length !== 4) {
    return false
  }
  const octets = parts.map((part) => {
    if (!/^\d+$/.test(part)) {
      return Number.NaN
    }
    return Number(part)
  })
  return (
    octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255) &&
    octets[0] === 127
  )
}

const validateConfig = (config, packetCount) => {
  if (!isNumericIpv4Loopback(config.host)) {
    throw new Error('host_must_be_numeric_ipv4_loopback')
  }
  if (config.port < 1 || config.port > 65535) {
    throw new Error('port_out_of_range')
  }
  if (config.intervalMs < MIN_INTERVAL_MS) {
    throw new Error(`interval_ms_below_minimum:${MIN_INTERVAL_MS}`)
  }
  if (packetCount > MAX_PACKETS) {
    throw new Error(`packet_count_exceeds_limit:${MAX_PACKETS}`)
  }
}

const basePayload = (config, actionId, overrides = {}) => ({
  type: 'home_control_magic',
  event: 'display_link_ping',
  action_id: actionId,
  label: 'RR-002 TouchDesigner UDP fuzz',
  source: SOURCE,
  timestamp: nowIso(),
  ...overrides
})

const jsonPacket = (caseId, label, expected, payload) => {
  const buffer = Buffer.from(JSON.stringify(payload), 'utf8')
  return {
    caseId,
    label,
    expected,
    json: true,
    buffer,
    summary: summarizePayload(payload, buffer)
  }
}

const rawPacket = (caseId, label, expected, buffer) => ({
  caseId,
  label,
  expected,
  json: false,
  buffer,
  summary: {
    json: false,
    bytes: buffer.length
  }
})

const summarizePayload = (payload, buffer) => {
  const noteChars =
    typeof payload.note === 'string' ? payload.note.length : undefined
  return {
    json: true,
    bytes: buffer.length,
    type: payload.type,
    event: payload.event,
    phase: payload.phase,
    action_id: payload.action_id,
    timestamp: payload.timestamp,
    source: payload.source,
    note_chars: noteChars
  }
}

const buildCasePackets = (config, caseId) => {
  if (caseId === 'td-udp-001') {
    const actionId = `${config.runId}_valid`
    return ['start', 'done'].map((phase) =>
      jsonPacket(
        caseId,
        `valid_${phase}`,
        'accept or harmless no-op; no crash',
        basePayload(config, actionId, { phase })
      )
    )
  }

  if (caseId === 'td-udp-002') {
    const actionId = `${config.runId}_duplicate`
    return [
      jsonPacket(
        caseId,
        'duplicate_start_1',
        'no runaway duplicate effect',
        basePayload(config, actionId, { phase: 'start', duplicate_index: 1 })
      ),
      jsonPacket(
        caseId,
        'duplicate_start_2',
        'no runaway duplicate effect',
        basePayload(config, actionId, { phase: 'start', duplicate_index: 2 })
      ),
      jsonPacket(
        caseId,
        'duplicate_done',
        'settles after done',
        basePayload(config, actionId, { phase: 'done' })
      )
    ]
  }

  if (caseId === 'td-udp-003') {
    return [
      jsonPacket(
        caseId,
        'stale_start',
        'ignore or visible stale no-op; no current-state overclaim',
        basePayload(config, `${config.runId}_stale`, {
          phase: 'start',
          timestamp: staleIso()
        })
      )
    ]
  }

  if (caseId === 'td-udp-004') {
    return [
      jsonPacket(
        caseId,
        'unknown_type_event',
        'ignore/no-op; no normal visual path',
        basePayload(config, `${config.runId}_unknown`, {
          type: 'rr002_unknown_type',
          event: 'rr002_unknown_event',
          phase: 'start'
        })
      )
    ]
  }

  if (caseId === 'td-udp-005') {
    return [
      rawPacket(
        caseId,
        'malformed_non_json',
        'ignore/no-op; no crash',
        Buffer.from(`rr002-malformed-non-json:${config.runId}:{`, 'utf8')
      )
    ]
  }

  if (caseId === 'td-udp-006') {
    return [
      jsonPacket(
        caseId,
        'oversized_safe_note',
        'ignore/truncate/no-op; no output flood',
        basePayload(config, `${config.runId}_oversized_safe`, {
          phase: 'start',
          note: 'x'.repeat(OVERSIZED_SAFE_CHARS)
        })
      )
    ]
  }

  throw new Error(`unhandled_case:${caseId}`)
}

const buildPackets = (config) =>
  config.cases.flatMap((caseId) => buildCasePackets(config, caseId))

const processIsAlive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (_error) {
    return false
  }
}

const sendPacket = (socket, packet, config) =>
  new Promise((resolve) => {
    socket.send(packet.buffer, config.port, config.host, (error) => {
      resolve(error ? error.message : null)
    })
  })

const sendPackets = async (config, packets) => {
  const socket = dgram.createSocket('udp4')
  const sent = []

  try {
    for (let index = 0; index < packets.length; index += 1) {
      const packet = packets[index]
      if (
        config.touchdesignerPid !== null &&
        !processIsAlive(config.touchdesignerPid)
      ) {
        return {
          ok: false,
          stopped: true,
          error: 'touchdesigner_process_not_alive',
          sent
        }
      }

      const error = await sendPacket(socket, packet, config)
      sent.push({
        caseId: packet.caseId,
        label: packet.label,
        bytes: packet.buffer.length,
        error
      })

      if (error) {
        return { ok: false, stopped: true, error, sent }
      }

      if (index < packets.length - 1) {
        await sleep(config.intervalMs)
      }
    }
  } finally {
    socket.close()
  }

  return { ok: true, stopped: false, error: null, sent }
}

const buildSummary = (config, packets, sendResult = null) => ({
  ok: sendResult ? sendResult.ok : true,
  mode: config.dryRun ? 'dry-run' : 'send',
  runId: config.runId,
  host: config.host,
  port: config.port,
  intervalMs: config.intervalMs,
  packetCount: packets.length,
  maxPackets: MAX_PACKETS,
  stopConditions: [
    'non-loopback target rejected before send',
    'packet count above short-battery limit rejected before send',
    'interval below one packet per second rejected before send',
    'optional TouchDesigner PID missing stops before next send',
    'operator stops immediately on TouchDesigner crash, save prompt, GUI status loss, or local instability'
  ],
  recoveryCommand: config.recoveryCommand,
  artifactPolicy:
    'stdout or --out JSON summary only; no raw media, .toe, secrets, provider payloads, or generated captures',
  packets: packets.map((packet) => ({
    caseId: packet.caseId,
    label: packet.label,
    expected: packet.expected,
    ...packet.summary
  })),
  sendResult
})

const writeSummary = (config, summary) => {
  const json = `${JSON.stringify(summary, null, 2)}\n`
  if (config.out) {
    const outPath = path.resolve(config.out)
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, json, 'utf8')
  }
  process.stdout.write(json)
}

const main = async () => {
  const config = parseArgs()
  if (config.help) {
    process.stdout.write(USAGE)
    return
  }

  const packets = buildPackets(config)
  validateConfig(config, packets.length)

  if (config.dryRun) {
    writeSummary(config, buildSummary(config, packets))
    return
  }

  const sendResult = await sendPackets(config, packets)
  writeSummary(config, buildSummary(config, packets, sendResult))
  process.exitCode = sendResult.ok ? 0 : 1
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}

module.exports = {
  CASE_IDS,
  MAX_PACKETS,
  MIN_INTERVAL_MS,
  buildPackets,
  buildSummary,
  isNumericIpv4Loopback,
  parseArgs,
  validateConfig
}
