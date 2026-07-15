const dgram = require('dgram')
const crypto = require('crypto')
const fs = require('fs')
const http = require('http')
const https = require('https')
const net = require('net')
const path = require('path')
const { URL } = require('url')

const args = process.argv.slice(2)

const readArg = (name, fallback) => {
  const index = args.indexOf(name)
  if (index >= 0 && args[index + 1]) {
    return args[index + 1]
  }
  return fallback
}

const parseIntArg = (name, fallback) => {
  const value = Number(readArg(name, fallback))
  return Number.isInteger(value) ? value : fallback
}

const PROJECT_ROOT = path.resolve(__dirname, '..')
const DEFAULT_WORKSPACE_ROOT = path.resolve(PROJECT_ROOT, '..')
const DEFAULT_HOSTS = {
  loopback: '127.0.0.1'
}
const DEFAULT_PORTS = {
  displayRuntimeGui: 8788,
  mediapipe: 8765,
  homeAssistantBridge: 8787,
  environmentState: 8790,
  thoughtCore: 18787,
  aituber: 3000,
  touchdesignerUdp: 9001
}

const WORKSPACE_ROOT = path.resolve(
  readArg(
    '--workspace',
    process.env.HOME_CONTROL_WORKSPACE_ROOT || DEFAULT_WORKSPACE_ROOT
  )
)
const HOST = readArg(
  '--host',
  process.env.TOUCHDESIGNER_GUI_HOST || DEFAULT_HOSTS.loopback
)
const PORT = parseIntArg(
  '--port',
  Number(process.env.TOUCHDESIGNER_GUI_PORT || DEFAULT_PORTS.displayRuntimeGui)
)
const ALLOW_REMOTE_GUI =
  args.includes('--allow-remote') ||
  process.env.TOUCHDESIGNER_GUI_ALLOW_REMOTE === 'true'
const TRUST_PROXY_HEADERS =
  process.env.TOUCHDESIGNER_GUI_TRUST_PROXY_HEADERS === 'true'
const MEDIAPIPE_PORT = parseIntArg(
  '--mediapipe-port',
  Number(process.env.MEDIAPIPE_PORT || DEFAULT_PORTS.mediapipe)
)
const MEDIAPIPE_HOST = readArg(
  '--mediapipe-host',
  process.env.MEDIAPIPE_HOST || DEFAULT_HOSTS.loopback
)
const HOME_ASSISTANT_BRIDGE_HOST = readArg(
  '--home-assistant-bridge-host',
  process.env.HOME_ASSISTANT_BRIDGE_HOST || DEFAULT_HOSTS.loopback
)
const HOME_ASSISTANT_BRIDGE_PORT = parseIntArg(
  '--home-assistant-bridge-port',
  Number(process.env.HOME_ASSISTANT_BRIDGE_PORT || DEFAULT_PORTS.homeAssistantBridge)
)
const ENVIRONMENT_STATE_HOST = readArg(
  '--environment-state-host',
  process.env.ENVIRONMENT_STATE_HOST || DEFAULT_HOSTS.loopback
)
const ENVIRONMENT_STATE_PORT = parseIntArg(
  '--environment-state-port',
  Number(process.env.ENVIRONMENT_STATE_PORT || DEFAULT_PORTS.environmentState)
)
const THOUGHT_CORE_HOST = readArg(
  '--thought-core-host',
  process.env.THOUGHT_CORE_HOST || DEFAULT_HOSTS.loopback
)
const THOUGHT_CORE_PORT = parseIntArg(
  '--thought-core-port',
  Number(process.env.THOUGHT_CORE_PORT || DEFAULT_PORTS.thoughtCore)
)
const AITUBER_HOST = readArg(
  '--aituber-host',
  process.env.AITUBER_HOST || DEFAULT_HOSTS.loopback
)
const AITUBER_PORT = parseIntArg(
  '--aituber-port',
  Number(process.env.AITUBER_PORT || DEFAULT_PORTS.aituber)
)
const AITUBER_URL = readArg(
  '--aituber-url',
  process.env.AITUBER_URL ||
    process.env.NEXT_PUBLIC_AITUBER_URL ||
    `http://${AITUBER_HOST}:${AITUBER_PORT}/projection-visual?mode=passive&hud=0`
)
const AITUBER_CAPTURE_STAGE_URL = (() => {
  const url = new URL(AITUBER_URL)
  url.search = ''
  url.hash = ''
  url.searchParams.set('mode', 'stage-output')
  url.searchParams.set('hud', '0')
  return url.href
})()
const TOUCHDESIGNER_HOST = readArg(
  '--touchdesigner-host',
  process.env.TOUCHDESIGNER_UDP_HOST || DEFAULT_HOSTS.loopback
)
const TOUCHDESIGNER_PORT = parseIntArg(
  '--touchdesigner-port',
  Number(process.env.TOUCHDESIGNER_UDP_PORT || DEFAULT_PORTS.touchdesignerUdp)
)
const TOUCHDESIGNER_HOME_ACTION_POLL_MS = parseIntArg(
  '--touchdesigner-home-action-poll-ms',
  Number(process.env.TOUCHDESIGNER_HOME_ACTION_POLL_MS || 1000)
)
const TOUCHDESIGNER_MOTION_EVENT_POLL_MS = parseIntArg(
  '--touchdesigner-motion-event-poll-ms',
  Number(process.env.TOUCHDESIGNER_MOTION_EVENT_POLL_MS || 1000)
)
const TOUCHDESIGNER_MOTION_EVENT_MAX_AGE_MS = Math.max(
  1000,
  parseIntArg(
    '--touchdesigner-motion-event-max-age-ms',
    Number(process.env.TOUCHDESIGNER_MOTION_EVENT_MAX_AGE_MS || 35000)
  )
)
const TOUCHDESIGNER_MOTION_EVENT_FUTURE_TOLERANCE_MS = 2000
const STATE_DIR = path.resolve(
  process.env.HOME_CONTROL_STACK_STATE_DIR ||
    path.join(WORKSPACE_ROOT, '.cache', 'home-control-stack')
)
const TRUE_ENV_VALUES = new Set(['1', 'true', 'yes', 'on'])
const DEBUG_TRACE_TEXT_DEFAULT = TRUE_ENV_VALUES.has(
  String(process.env.DISPLAY_RUNTIME_DEBUG_TRACES || '')
    .trim()
    .toLowerCase()
)
const DEBUG_TRACE_TEXT_LIMIT = Math.max(
  0,
  parseIntArg(
    '--debug-trace-text-limit',
    Number(process.env.DISPLAY_RUNTIME_DEBUG_TRACE_TEXT_LIMIT || 1200)
  )
)

const httpServiceTargetFromUrl = (urlString, fallbackHost, fallbackPort) => {
  try {
    const url = new URL(urlString)
    const protocol = url.protocol === 'https:' ? 'https:' : 'http:'
    const port =
      Number(url.port) ||
      (protocol === 'https:' ? 443 : 80)
    return {
      host: url.hostname || fallbackHost,
      port,
      origin: `${protocol}//${url.host}`
    }
  } catch {
    return {
      host: fallbackHost,
      port: fallbackPort,
      origin: `http://${fallbackHost}:${fallbackPort}`
    }
  }
}

const AITUBER_STATUS_TARGET = httpServiceTargetFromUrl(
  AITUBER_URL,
  AITUBER_HOST,
  AITUBER_PORT
)

const PUBLIC_DIR = path.join(__dirname, 'public')
const PID_FILE = path.join(STATE_DIR, 'pids.json')
const MEDIAPIPE_STATUS_FILE = path.join(STATE_DIR, 'mediapipe-status.json')
const HOME_ACTION_EVENTS_FILE = path.resolve(
  readArg(
    '--home-action-events-file',
    process.env.HOME_ACTION_EVENTS_FILE ||
      path.join(
        WORKSPACE_ROOT,
        'organs',
        'action',
        'home-assistant-server',
        '.cache',
        'home_control',
        'events.jsonl'
      )
  )
)
const THOUGHT_CORE_CHAT_EVENTS_FILE = path.join(
  STATE_DIR,
  'thought-core-chat-events.jsonl'
)
const CONVERSATION_LOG_FILE = path.join(STATE_DIR, 'conversation-log.jsonl')

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
}

const nowIso = () => new Date().toISOString()

const GESTURE_DISPLAY_NAMES = {
  sword_sign: 'Sword',
  victory: 'Victory',
  none: 'None'
}

const normalizeIpAddress = (value) => {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
  return normalized.startsWith('::ffff:')
    ? normalized.slice('::ffff:'.length)
    : normalized
}

const isLoopbackHost = (host) => {
  const normalized = String(host || '').toLowerCase()
  return (
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === '[::1]' ||
    normalized === '127.0.0.1' ||
    normalized.startsWith('127.')
  )
}

const isLoopbackAddress = (address) => {
  const normalized = normalizeIpAddress(address)
  return normalized === '' || isLoopbackHost(normalized)
}

const getRemoteAddress = (request) => {
  const forwardedFor = TRUST_PROXY_HEADERS
    ? request.headers['x-forwarded-for']
    : ''
  if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
    const forwardedRemoteAddress = normalizeIpAddress(forwardedFor.split(',')[0])
    if (forwardedRemoteAddress) {
      return forwardedRemoteAddress
    }
  }
  return normalizeIpAddress(request.socket?.remoteAddress)
}

const parseHostHeader = (request) => {
  try {
    return new URL(`http://${request.headers.host || `${HOST}:${PORT}`}`)
  } catch {
    return null
  }
}

const isTrustedOrigin = (request) => {
  const originHeader = request.headers.origin
  if (!originHeader) {
    return true
  }
  if (originHeader === 'null') {
    return false
  }
  try {
    const origin = new URL(originHeader)
    if (!['http:', 'https:'].includes(origin.protocol)) {
      return false
    }
    const host = parseHostHeader(request)
    if (!host) {
      return isLoopbackHost(origin.hostname)
    }
    return (
      origin.host === host.host ||
      (isLoopbackHost(origin.hostname) && isLoopbackHost(host.hostname))
    )
  } catch {
    return false
  }
}

const buildCorsHeaders = (request) => {
  const origin = request.headers.origin
  if (!origin || !isTrustedOrigin(request)) {
    return {}
  }
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin'
  }
}

const rejectUntrustedRequest = (request, response) => {
  if (!ALLOW_REMOTE_GUI && !isLoopbackAddress(getRemoteAddress(request))) {
    sendJson(
      response,
      403,
      { ok: false, error: 'local_access_required' },
      request
    )
    return true
  }
  if (!isTrustedOrigin(request)) {
    sendJson(response, 403, { ok: false, error: 'untrusted_origin' }, request)
    return true
  }
  return false
}

const readJsonFile = (filePath) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

const isProcessAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error && error.code === 'EPERM'
  }
}

const readPidMap = () => {
  const state = readJsonFile(PID_FILE)
  const map = {}
  for (const entry of state?.processes || []) {
    if (entry?.name) {
      map[entry.name] = entry
    }
  }
  return map
}

const checkTcp = (port, host = DEFAULT_HOSTS.loopback, timeoutMs = 900) =>
  new Promise((resolve) => {
    const socket = new net.Socket()
    let settled = false

    const finish = (ok, detail) => {
      if (settled) {
        return
      }
      settled = true
      socket.destroy()
      resolve({ ok, detail })
    }

    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true, 'listening'))
    socket.once('timeout', () => finish(false, 'timeout'))
    socket.once('error', (error) => finish(false, error.message))
    socket.connect(port, host)
  })

const createMaskedWebSocketCloseFrame = () => {
  const payload = Buffer.alloc(2)
  payload.writeUInt16BE(1000, 0)
  const mask = crypto.randomBytes(4)
  const maskedPayload = Buffer.alloc(payload.length)
  for (let index = 0; index < payload.length; index += 1) {
    maskedPayload[index] = payload[index] ^ mask[index % mask.length]
  }
  return Buffer.concat([
    Buffer.from([0x88, 0x80 | payload.length]),
    mask,
    maskedPayload
  ])
}

const checkWebSocketHandshake = (
  port,
  host = DEFAULT_HOSTS.loopback,
  timeoutMs = 900
) =>
  new Promise((resolve) => {
    const socket = new net.Socket()
    const key = crypto.randomBytes(16).toString('base64')
    let settled = false
    let response = ''

    const finish = (ok, detail, options = {}) => {
      if (settled) {
        return
      }
      settled = true
      if (options.closeWebSocket && socket.writable) {
        try {
          socket.write(createMaskedWebSocketCloseFrame(), () => socket.end())
        } catch {
          socket.destroy()
        }
      } else {
        socket.destroy()
      }
      resolve({ ok, detail })
    }

    socket.setTimeout(timeoutMs)
    socket.once('connect', () => {
      socket.write(
        [
          'GET / HTTP/1.1',
          `Host: ${host}:${port}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          '',
          ''
        ].join('\r\n')
      )
    })
    socket.on('data', (chunk) => {
      response += chunk.toString('utf8')
      if (!response.includes('\r\n\r\n')) {
        return
      }
      const statusLine = response.split(/\r?\n/, 1)[0] || ''
      if (/^HTTP\/1\.[01] 101\b/.test(statusLine)) {
        finish(true, 'websocket handshake ok', { closeWebSocket: true })
      } else if (/^HTTP\/1\.[01] \d+/.test(statusLine)) {
        finish(false, statusLine.trim())
      } else {
        finish(false, 'invalid websocket response')
      }
    })
    socket.once('timeout', () => finish(false, 'timeout'))
    socket.once('error', (error) => finish(false, error.message))
    socket.once('close', () =>
      finish(false, 'closed before websocket handshake')
    )
    socket.connect(port, host)
  })

const checkHttp = (urlString, timeoutMs = 1600, jsonHealth = false) =>
  new Promise((resolve) => {
    const startedAt = Date.now()
    let url
    try {
      url = new URL(urlString)
    } catch {
      resolve({
        ok: false,
        statusCode: null,
        detail: 'invalid url',
        latencyMs: 0
      })
      return
    }

    const client = url.protocol === 'https:' ? https : http
    const request = client.request(
      url,
      {
        method: 'GET',
        timeout: timeoutMs
      },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8')
          const statusCode = response.statusCode || 0
          let ok = statusCode >= 200 && statusCode < 400
          let detail = `HTTP ${statusCode}`

          if (jsonHealth) {
            try {
              const parsed = JSON.parse(body)
              if (Object.prototype.hasOwnProperty.call(parsed, 'ok')) {
                ok = Boolean(parsed.ok)
              }
              detail = ok ? 'health ok' : 'health unavailable'
            } catch {
              ok = false
              detail = `HTTP ${statusCode}, invalid JSON`
            }
          }

          resolve({
            ok,
            statusCode,
            detail,
            latencyMs: Date.now() - startedAt
          })
        })
      }
    )

    request.once('timeout', () => {
      request.destroy(new Error('timeout'))
    })
    request.once('error', (error) => {
      resolve({
        ok: false,
        statusCode: null,
        detail: error.message,
        latencyMs: Date.now() - startedAt
      })
    })
    request.end()
  })

const fetchJson = (urlString, timeoutMs = 1600) =>
  new Promise((resolve) => {
    let url
    try {
      url = new URL(urlString)
    } catch {
      resolve(null)
      return
    }
    const client = url.protocol === 'https:' ? https : http
    const request = client.request(
      url,
      {
        method: 'GET',
        timeout: timeoutMs,
        headers: {
          'Cache-Control': 'no-store'
        }
      },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          if ((response.statusCode || 0) < 200 || (response.statusCode || 0) >= 400) {
            resolve(null)
            return
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
          } catch {
            resolve(null)
          }
        })
      }
    )
    request.once('timeout', () => {
      request.destroy(new Error('timeout'))
    })
    request.once('error', () => {
      resolve(null)
    })
    request.end()
  })

const serviceState = ({ processAlive, tcpOk, httpOk, requireHttp = false }) => {
  if (processAlive && (tcpOk || httpOk)) {
    return requireHttp && !httpOk ? 'DEGRADED' : 'OK'
  }
  if (httpOk) {
    return 'OK_EXTERNAL'
  }
  if (processAlive) {
    return 'STARTING'
  }
  if (tcpOk) {
    return 'DEGRADED'
  }
  return 'DOWN'
}

const makeService = ({
  name,
  entry,
  tcp,
  http,
  requireHttp = false,
  processOnlyOk = false,
  detail = ''
}) => {
  const processAlive = isProcessAlive(Number(entry?.pid))
  const tcpOk = Boolean(tcp?.ok)
  const httpOk = Boolean(http?.ok)
  const processOnlyHealthy = processOnlyOk && processAlive && !tcpOk && !httpOk
  return {
    name,
    state: processOnlyHealthy
      ? 'OK'
      : serviceState({ processAlive, tcpOk, httpOk, requireHttp }),
    processAlive,
    pid: Number(entry?.pid) || null,
    tcp: tcp || { ok: false, detail: '-' },
    http: http || { ok: false, detail: '-' },
    detail
  }
}

const summarizeThoughtCoreTcpProbe = (probe) => {
  if (!probe) {
    return { ok: false, detail: 'tcp unavailable' }
  }
  const latencyMs = Number.isFinite(probe.latencyMs) ? probe.latencyMs : undefined
  if (probe.ok) {
    return { ok: true, detail: 'tcp listening', latencyMs }
  }
  const detail = String(probe.detail || '').toLowerCase()
  return {
    ok: false,
    detail: detail.includes('timeout') ? 'timeout' : 'tcp unavailable'
  }
}

const summarizeThoughtCoreHealthProbe = (probe) => {
  if (!probe) {
    return { ok: false, statusCode: null, detail: 'health unavailable' }
  }
  const statusCode = Number.isInteger(probe.statusCode) ? probe.statusCode : null
  const latencyMs = Number.isFinite(probe.latencyMs) ? probe.latencyMs : undefined
  if (probe.ok) {
    return { ok: true, statusCode, detail: 'health ok', latencyMs }
  }
  if (Number.isInteger(probe.statusCode) && probe.statusCode > 0) {
    return { ok: false, statusCode, detail: `HTTP ${probe.statusCode}`, latencyMs }
  }
  const detail = String(probe.detail || '').toLowerCase()
  if (detail.includes('timeout')) {
    return { ok: false, statusCode, detail: 'timeout', latencyMs }
  }
  if (detail.includes('invalid json')) {
    return { ok: false, statusCode, detail: 'invalid JSON', latencyMs }
  }
  if (detail.includes('invalid url')) {
    return { ok: false, statusCode, detail: 'invalid url', latencyMs }
  }
  return { ok: false, statusCode, detail: 'health unavailable', latencyMs }
}

const serviceFromIndicatorNode = (node, fallback) => {
  const status = String(node?.status || '').toLowerCase()
  const state = node?.stale
    ? 'DEGRADED'
    : status === 'ok'
      ? 'OK'
      : status === 'offline'
        ? 'DOWN'
        : 'DEGRADED'
  return {
    ...(fallback || {}),
    name: node?.node_id || fallback?.name || 'unknown',
    state,
    processAlive: fallback?.processAlive || false,
    pid: fallback?.pid || null,
    tcp: fallback?.tcp || { ok: false, detail: '-' },
    http: {
      ok: status === 'ok' && !node?.stale,
      detail: node?.detail || fallback?.http?.detail || '-'
    },
    detail: node?.detail || fallback?.detail || '',
    metrics: node?.metrics || {},
    phase: node?.phase || null,
    observed_at: node?.observed_at || null
  }
}

const buildHomeActionMode = () => {
  const adapter = String(process.env.THOUGHT_CORE_TOOLS_ADAPTER || '')
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, '_')

  if (adapter === 'mock' || adapter === 'no_live' || adapter === 'dry_run') {
    return {
      mode: 'mock',
      label: 'MOCK',
      detail: '実送信なし',
      live: false
    }
  }

  if (
    adapter === 'home_control' ||
    adapter === 'home_assistant' ||
    adapter === 'live_home'
  ) {
    return {
      mode: 'live_home',
      label: 'LIVE HOME',
      detail: '実家電送信',
      live: true
    }
  }

  return {
    mode: 'unknown',
    label: 'UNKNOWN',
    detail: '設定不明',
    live: false
  }
}

const readRecentJsonlEvents = (filePath, limit = 8) => {
  try {
    const stat = fs.statSync(filePath)
    const readSize = Math.min(stat.size, 96 * 1024)
    const fd = fs.openSync(filePath, 'r')
    const buffer = Buffer.alloc(readSize)
    fs.readSync(fd, buffer, 0, readSize, stat.size - readSize)
    fs.closeSync(fd)
    return buffer
      .toString('utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      })
      .filter(Boolean)
  } catch {
    return []
  }
}

const readRecentHomeActionEvents = (limit = 8) =>
  readRecentJsonlEvents(HOME_ACTION_EVENTS_FILE, limit)

const readRecentThoughtCoreChatEvents = (limit = 8) =>
  readRecentJsonlEvents(THOUGHT_CORE_CHAT_EVENTS_FILE, limit)

const readRecentConversationLog = (limit = 16) =>
  readRecentJsonlEvents(CONVERSATION_LOG_FILE, limit)

const traceTextLength = (value) =>
  typeof value === 'string' ? value.length : 0

const compactTraceText = (value) => {
  if (typeof value !== 'string') {
    return value
  }
  if (value.length <= DEBUG_TRACE_TEXT_LIMIT) {
    return value
  }
  const hiddenChars = value.length - DEBUG_TRACE_TEXT_LIMIT
  return `${value.slice(0, DEBUG_TRACE_TEXT_LIMIT)}... [truncated ${hiddenChars} chars]`
}

const redactedTraceText = (value) => {
  const chars = traceTextLength(value)
  return chars > 0 ? `[debug trace hidden: ${chars} chars]` : ''
}

const sanitizeTraceTextField = (target, fieldName, debugTraces) => {
  if (!Object.prototype.hasOwnProperty.call(target, fieldName)) {
    return
  }
  const value = target[fieldName]
  const chars = traceTextLength(value)
  target[`${fieldName}_chars`] = chars
  target[fieldName] = debugTraces
    ? compactTraceText(value)
    : redactedTraceText(value)
  if (!debugTraces && chars > 0) {
    target.trace_redacted = true
  }
}

const sanitizeEventTrace = (event, debugTraces, textFields) => {
  if (!event || typeof event !== 'object') {
    return event || null
  }
  const sanitized = { ...event }
  for (const fieldName of textFields) {
    sanitizeTraceTextField(sanitized, fieldName, debugTraces)
  }
  return sanitized
}

const sanitizeHomeActionEvent = (event, debugTraces) =>
  sanitizeEventTrace(event, debugTraces, [
    'user_text',
    'detail',
    'status_text',
    'error'
  ])

const ROUTINE_PRIVATE_FIELD =
  /(?:^|_)(?:answer|arbitrary|authorization|content|credential|delta|filename|media|message|password|path|private|prompt|provider|query|raw|secret|speech|text|token|transcript|utterance)(?:_|$)/i

const stripRoutinePrivateFields = (value) => {
  if (Array.isArray(value)) {
    return value.map((entry) => stripRoutinePrivateFields(entry))
  }
  if (!value || typeof value !== 'object') {
    return value
  }
  const result = {}
  for (const [key, nestedValue] of Object.entries(value)) {
    if (ROUTINE_PRIVATE_FIELD.test(key)) {
      continue
    }
    result[key] = stripRoutinePrivateFields(nestedValue)
  }
  return result
}

const sanitizeChatEvent = (event, debugTraces) => {
  const sanitized = sanitizeEventTrace(event, debugTraces, [
    'query',
    'answer',
    'answer_preview',
    'detail',
    'status_text',
    'error'
  ])
  if (debugTraces) {
    return sanitized
  }
  const routineEvent = stripRoutinePrivateFields(sanitized)
  delete routineEvent.notable_events
  return routineEvent
}

const sanitizeConversationEntry = (entry, debugTraces) =>
  sanitizeEventTrace(entry, debugTraces, [
    'text',
    'query',
    'answer',
    'answer_preview',
    'detail'
  ])

const debugTracesForRequest = (requestUrl, request) => {
  const explicit = String(requestUrl.searchParams.get('debug') || '')
    .trim()
    .toLowerCase()
  const requested = DEBUG_TRACE_TEXT_DEFAULT || TRUE_ENV_VALUES.has(explicit)
  return requested && isLoopbackAddress(getRemoteAddress(request))
}

const localPathForStatus = (value, debugTraces) => ({
  label: path.basename(value || '') || 'workspace',
  path: debugTraces ? compactTraceText(value) : redactedTraceText(value),
  path_chars: traceTextLength(value),
  trace_redacted: !debugTraces && traceTextLength(value) > 0
})

const withAge = (payload) => {
  if (!payload?.updated_at) {
    return payload
  }
  const updatedAt = Date.parse(payload.updated_at)
  return {
    ...payload,
    age_ms: Number.isFinite(updatedAt) ? Date.now() - updatedAt : null
  }
}

const formatConfidence = (value) => {
  const number = Number(value)
  return Number.isFinite(number) ? number.toFixed(3) : '0.000'
}

const gestureDisplayName = (name) =>
  GESTURE_DISPLAY_NAMES[name] || (name ? String(name) : 'None')

const bestGestureFromMap = (gestures) => {
  if (!gestures || typeof gestures !== 'object') {
    return null
  }
  let best = null
  Object.entries(gestures).forEach(([name, signal]) => {
    const confidence = Number(signal?.confidence)
    if (!Number.isFinite(confidence)) {
      return
    }
    if (!best || confidence > best.confidence) {
      best = {
        name,
        confidence,
        active: Boolean(signal?.active)
      }
    }
  })
  return best
}

const latestIso = (...values) => {
  const timestamps = values
    .map((value) => Date.parse(value || ''))
    .filter((value) => Number.isFinite(value))
  if (timestamps.length === 0) {
    return null
  }
  return new Date(Math.max(...timestamps)).toISOString()
}

const ageMsFromIso = (value) => {
  const timestamp = Date.parse(value || '')
  return Number.isFinite(timestamp) ? Math.max(0, Date.now() - timestamp) : null
}

const mediapipeStatusFromEnvironment = (environmentIndicators, fallbackStatus) => {
  const environment = environmentIndicators?.environment || {}
  const vision = environment.vision || {}
  const cameraState = vision.camera || {}
  const swordState = vision.sword_sign || {}
  if (!cameraState.updated_at && !swordState.updated_at) {
    return fallbackStatus || null
  }

  const camera = cameraState.camera || {}
  const capture = cameraState.capture || {}
  const stableSword = swordState.stable?.gestures?.sword_sign || {}
  const confidence = Number(swordState.confidence ?? stableSword.confidence)
  const swordConfidence = formatConfidence(confidence)
  const bestGesture = swordState.best_gesture || bestGestureFromMap(swordState.gestures)
  const bestGestureName = bestGesture?.name || 'none'
  const bestGestureConfidence = formatConfidence(Number(bestGesture?.confidence ?? confidence))
  const heldFor = Number(stableSword.held_for)
  const fps = Number(cameraState.fps ?? capture.read_fps)
  const updatedAt = latestIso(cameraState.updated_at, swordState.updated_at)
  const cameraHubSource = environment.sources?.camera_hub || {}
  const sourceStale = Boolean(cameraHubSource.stale || cameraState.stale || swordState.stale)
  const cameraOpened = camera.opened !== false && cameraState.state !== 'unavailable'
  const active = Boolean(swordState.active || stableSword.active)
  const primary = swordState.primary_gesture || (active ? 'sword_sign' : null)

  return {
    type: 'environment_camera_hub_snapshot',
    updated_at: updatedAt,
    age_ms: ageMsFromIso(updatedAt),
    running: cameraOpened && !sourceStale,
    capture: sourceStale ? 'Stale' : cameraOpened ? 'Running' : 'Stopped',
    websocket: sourceStale
      ? `stale via Environment / Camera Hub ws://${MEDIAPIPE_HOST}:${MEDIAPIPE_PORT}`
      : `fresh via Environment / Camera Hub ws://${MEDIAPIPE_HOST}:${MEDIAPIPE_PORT}`,
    clients: 'environment_state_server',
    fps: Number.isFinite(fps) ? fps.toFixed(1) : '-',
    primary_gesture: gestureDisplayName(primary),
    best_gesture: `${gestureDisplayName(bestGestureName)} (${bestGestureConfidence})`,
    sword_raw_state: `${active ? 'active' : 'inactive'} (${swordConfidence})`,
    sword_confidence: swordConfidence,
    stable_state: stableSword.active ? 'active' : 'inactive',
    held_for: Number.isFinite(heldFor) ? `${heldFor.toFixed(2)}s` : '0.00s',
    last_published_at: swordState.updated_at || null,
    last_publish_result: sourceStale ? 'snapshot stale' : 'environment snapshot',
    last_event: stableSword.activated
      ? 'stable activated'
      : stableSword.released
        ? 'stable released'
        : active
          ? 'raw active'
          : 'raw inactive',
    camera_source: camera.source || capture.source || null,
    capture_backend: capture.backend || null,
    frame_id: swordState.frame_id || cameraState.frame_id || null
  }
}

const latestChatEvent = (thoughtCoreEvents) => {
  const candidates = thoughtCoreEvents
    .map((event) => ({
      ...event,
      source: 'thought-core',
      timestamp_ms: Date.parse(event.timestamp || '')
    }))
    .filter((event) => Number.isFinite(event.timestamp_ms))
    .sort((left, right) => left.timestamp_ms - right.timestamp_ms)
  return candidates[candidates.length - 1] || null
}

const chatSourceLabel = () => 'Thought Core'

const chatSourceStage = () => 'THOUGHT_CORE'

const summarizePipeline = (lastChatEvent, lastHomeEvent) => {
  if (!lastChatEvent) {
    return {
      stage: 'WAITING_FOR_INPUT',
      source: null,
      event: null,
      detail: 'No AITuber -> AI request has been recorded yet.',
      updated_at: lastHomeEvent?.timestamp || null
    }
  }

  const chatAt = Date.parse(lastChatEvent.timestamp || '')
  const homeAt = Date.parse(lastHomeEvent?.timestamp || '')
  const homeAfterChat =
    Number.isFinite(chatAt) &&
    Number.isFinite(homeAt) &&
    homeAt >= chatAt - 1000
  const sourceLabel = chatSourceLabel(lastChatEvent)
  const sourceStage = chatSourceStage(lastChatEvent)

  if (
    ['config_error', 'request_failed', 'request_exception'].includes(
      lastChatEvent.event
    )
  ) {
    return {
      stage: `AITUBER_TO_${sourceStage}_FAILED`,
      source: lastChatEvent.source,
      event: lastChatEvent.event,
      detail:
        lastChatEvent.detail ||
        lastChatEvent.status_text ||
        `${sourceLabel} event: ${lastChatEvent.event}`,
      updated_at: lastChatEvent.timestamp || null
    }
  }

  if (lastChatEvent.event === 'request_started') {
    return {
      stage: `${sourceStage}_REQUESTING`,
      source: lastChatEvent.source,
      event: lastChatEvent.event,
      detail: lastChatEvent.query || `Waiting for ${sourceLabel} response.`,
      updated_at: lastChatEvent.timestamp || null
    }
  }

  if (lastChatEvent.event === 'stream_opened') {
    return {
      stage: `${sourceStage}_STREAMING`,
      source: lastChatEvent.source,
      event: lastChatEvent.event,
      detail: `${sourceLabel} stream opened.`,
      updated_at: lastChatEvent.timestamp || null
    }
  }

  if (homeAfterChat && lastHomeEvent?.event === 'execute_succeeded') {
    return {
      stage: 'HOME_ACTION_SUCCEEDED',
      source: lastChatEvent.source,
      event: lastChatEvent.event,
      detail: `${lastHomeEvent.action_id || '-'} / ${lastHomeEvent.user_text || ''}`,
      updated_at: lastHomeEvent.timestamp || null
    }
  }

  if (lastChatEvent.source === 'thought-core') {
    return {
      stage:
        lastChatEvent.event === 'stream_first_answer'
          ? 'THOUGHT_CORE_RESPONDING'
          : 'THOUGHT_CORE_RESPONDED',
      source: lastChatEvent.source,
      event: lastChatEvent.event,
      detail:
        lastChatEvent.answer_preview ||
        lastChatEvent.query ||
        `Thought Core event: ${lastChatEvent.event}`,
      updated_at: lastChatEvent.timestamp || null
    }
  }

  return {
    stage: `${sourceStage}_RECORDED`,
    source: lastChatEvent.source,
    event: lastChatEvent.event,
    detail:
      lastChatEvent.query || `${sourceLabel} event: ${lastChatEvent.event}`,
    updated_at: lastChatEvent.timestamp || null
  }
}

const getStatus = async ({ debugTraces = false } = {}) => {
  const pids = readPidMap()
  const voicevoxUrl = (
    process.env.VOICEVOX_SERVER_URL || 'http://127.0.0.1:50021'
  ).replace(/^http:\/\/localhost(?=:|\/|$)/, 'http://127.0.0.1')
  let voicevoxPort = 50021
  try {
    voicevoxPort = Number(new URL(voicevoxUrl).port || 50021)
  } catch {
    voicevoxPort = 50021
  }

  const [
    homeTcp,
    homeHttp,
    environmentTcp,
    environmentHttp,
    aituberTcp,
    aituberHttp,
    voicevoxTcp,
    voicevoxHttp,
    thoughtCoreTcp,
    thoughtCoreHttp,
    mediapipeWebSocket
  ] = await Promise.all([
    checkTcp(HOME_ASSISTANT_BRIDGE_PORT, HOME_ASSISTANT_BRIDGE_HOST),
    checkHttp(
      `http://${HOME_ASSISTANT_BRIDGE_HOST}:${HOME_ASSISTANT_BRIDGE_PORT}/operator`,
      1800
    ),
    checkTcp(ENVIRONMENT_STATE_PORT, ENVIRONMENT_STATE_HOST),
    checkHttp(
      `http://${ENVIRONMENT_STATE_HOST}:${ENVIRONMENT_STATE_PORT}/health`,
      1800,
      true
    ),
    checkTcp(AITUBER_STATUS_TARGET.port, AITUBER_STATUS_TARGET.host),
    checkHttp(AITUBER_STATUS_TARGET.origin, 1800),
    checkTcp(voicevoxPort),
    checkHttp(`${voicevoxUrl.replace(/\/$/, '')}/version`, 1800),
    checkTcp(THOUGHT_CORE_PORT, THOUGHT_CORE_HOST),
    checkHttp(`http://${THOUGHT_CORE_HOST}:${THOUGHT_CORE_PORT}/health`, 1800, true),
    checkWebSocketHandshake(MEDIAPIPE_PORT, MEDIAPIPE_HOST)
  ])
  const environmentIndicators = await fetchJson(
    `http://${ENVIRONMENT_STATE_HOST}:${ENVIRONMENT_STATE_PORT}/indicators/current`,
    1200
  )

  const mediapipeEntry =
    pids.mediapipe_camera_hub_stack ||
    pids.mediapipe_camera_hub ||
    pids.mediapipe_camera_hub_gui ||
    pids.mediapipe_ws
  const mediapipeFileStatus = withAge(readJsonFile(MEDIAPIPE_STATUS_FILE))
  const mediapipeStatus = mediapipeStatusFromEnvironment(
    environmentIndicators,
    mediapipeFileStatus
  )
  const mediapipeStatusFresh =
    typeof mediapipeStatus?.age_ms === 'number' && mediapipeStatus.age_ms < 5000
  const mediapipeReportedListening =
    mediapipeStatusFresh &&
    typeof mediapipeStatus?.websocket === 'string' &&
    (mediapipeStatus.websocket.toLowerCase().startsWith('listening') ||
      mediapipeStatus.websocket.toLowerCase().startsWith('connected') ||
      mediapipeStatus.websocket.toLowerCase().startsWith('fresh'))
  const mediapipeTcp = {
    ok: mediapipeReportedListening || Boolean(mediapipeWebSocket?.ok),
    detail: mediapipeReportedListening
      ? 'reported listening by GUI status'
      : mediapipeWebSocket?.detail || 'waiting for MediaPipe WebSocket'
  }
  const services = {
    home_assistant_bridge: makeService({
      name: 'home_assistant_bridge',
      entry: pids.home_assistant_bridge,
      tcp: homeTcp,
      http: homeHttp,
      requireHttp: true
    }),
    environment_state_server: makeService({
      name: 'environment_state_server',
      entry: pids.environment_state_server,
      tcp: environmentTcp,
      http: environmentHttp,
      requireHttp: true
    }),
    mediapipe: makeService({
      name: 'mediapipe',
      entry: mediapipeEntry,
      tcp: mediapipeTcp,
      http: { ok: false, detail: '-' },
      detail: mediapipeTcp.ok
        ? `ws://${MEDIAPIPE_HOST}:${MEDIAPIPE_PORT} listening`
        : 'waiting for MediaPipe WebSocket'
    }),
    aituber_kit: makeService({
      name: 'aituber_kit',
      entry: pids.aituber_kit,
      tcp: aituberTcp,
      http: aituberHttp,
      requireHttp: true
    }),
    voicevox: makeService({
      name: 'voicevox',
      entry: null,
      tcp: voicevoxTcp,
      http: voicevoxHttp,
      requireHttp: true
    })
  }
  const thoughtCoreApiTelemetryPresent =
    Boolean(pids.thought_core_api) ||
    Boolean(thoughtCoreTcp?.ok) ||
    Boolean(thoughtCoreHttp?.ok)
  if (thoughtCoreApiTelemetryPresent) {
    services.thought_core_api = makeService({
      name: 'thought_core_api',
      entry: pids.thought_core_api,
      tcp: summarizeThoughtCoreTcpProbe(thoughtCoreTcp),
      http: summarizeThoughtCoreHealthProbe(thoughtCoreHttp),
      requireHttp: true
    })
  }
  if (pids.thought_core_watcher) {
    services.thought_core_watcher = makeService({
      name: 'thought_core_watcher',
      entry: pids.thought_core_watcher,
      processOnlyOk: true,
      detail: 'process-only watcher telemetry'
    })
  }
  if (
    environmentIndicators?.nodes &&
    typeof environmentIndicators.nodes === 'object'
  ) {
    for (const [nodeId, node] of Object.entries(environmentIndicators.nodes)) {
      services[nodeId] = serviceFromIndicatorNode(node, services[nodeId])
    }
  }

  const rawEvents = readRecentHomeActionEvents()
  const rawThoughtCoreEvents = readRecentThoughtCoreChatEvents(32)
  const touchDesignerHomeActionForward =
    await forwardLatestHomeActionToTouchDesigner(rawEvents)
  const touchDesignerMotionEventForward =
    await forwardLatestMotionToTouchDesigner(rawThoughtCoreEvents)
  const rawConversationEntries = readRecentConversationLog()
  const events = rawEvents.map((event) =>
    sanitizeHomeActionEvent(event, debugTraces)
  )
  const thoughtCoreEvents = rawThoughtCoreEvents.map((event) =>
    sanitizeChatEvent(event, debugTraces)
  )
  const conversationEntries = rawConversationEntries.map((entry) =>
    sanitizeConversationEntry(entry, debugTraces)
  )
  const lastEvent = events[events.length - 1] || null
  const lastThoughtCoreEvent =
    thoughtCoreEvents[thoughtCoreEvents.length - 1] || null
  const lastConversationEntry =
    conversationEntries[conversationEntries.length - 1] || null
  const lastAiEvent = latestChatEvent(thoughtCoreEvents)
  const rawLastEvent = rawEvents[rawEvents.length - 1] || null
  const lastEventAt = rawLastEvent?.timestamp
    ? Date.parse(rawLastEvent.timestamp)
    : 0
  const magicActive =
    rawLastEvent?.event === 'execute_succeeded' &&
    Number.isFinite(lastEventAt) &&
    Date.now() - lastEventAt < 8500

  return {
    ok: true,
    timestamp: nowIso(),
    traceMode: {
      debug: debugTraces,
      text: debugTraces ? 'debug' : 'routine-summary'
    },
    workspaceRoot: debugTraces
      ? compactTraceText(WORKSPACE_ROOT)
      : redactedTraceText(WORKSPACE_ROOT),
    workspaceRootSummary: localPathForStatus(WORKSPACE_ROOT, debugTraces),
    touchdesigner: {
      udpHost: TOUCHDESIGNER_HOST,
      udpPort: TOUCHDESIGNER_PORT,
      state: 'UDP_READY',
      detail: 'UDP receiver cannot be health-checked; test packets can be sent.'
    },
    aituber: {
      url: AITUBER_URL,
      captureStageUrl: AITUBER_CAPTURE_STAGE_URL
    },
    services,
    environment: environmentIndicators?.environment || null,
    indicators: environmentIndicators || null,
    mediapipe: mediapipeStatus,
    homeActionMode: buildHomeActionMode(),
    homeActions: {
      eventSourceSummary: localPathForStatus(
        HOME_ACTION_EVENTS_FILE,
        debugTraces
      ),
      events,
      lastEvent
    },
    thoughtCoreChat: {
      events: thoughtCoreEvents,
      lastEvent: lastThoughtCoreEvent,
      motionUdpForward: touchDesignerMotionEventForward
    },
    conversationLog: {
      entries: conversationEntries,
      lastEntry: lastConversationEntry
    },
    aiChat: {
      lastEvent: lastAiEvent
    },
    pipeline: summarizePipeline(lastAiEvent, lastEvent),
    magic: {
      active: magicActive,
      lastActionId: rawLastEvent?.action_id || null,
      udpForward: touchDesignerHomeActionForward,
      lastUserText: debugTraces
        ? compactTraceText(rawLastEvent?.user_text)
        : redactedTraceText(rawLastEvent?.user_text),
      lastUserTextChars: traceTextLength(rawLastEvent?.user_text),
      traceRedacted:
        !debugTraces && traceTextLength(rawLastEvent?.user_text) > 0,
      lastEventAt: rawLastEvent?.timestamp || null
    }
  }
}

const sendJson = (response, statusCode, payload, request) => {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...(request ? buildCorsHeaders(request) : {})
  })
  response.end(JSON.stringify(payload))
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const sendTouchDesignerPacket = (socket, payload) =>
  new Promise((resolve) => {
    const packet = Buffer.from(JSON.stringify(payload))
    socket.send(packet, TOUCHDESIGNER_PORT, TOUCHDESIGNER_HOST, (error) => {
      resolve(error ? error.message : null)
    })
  })

const safeUdpScalar = (value, fallback = '-') => {
  const text = String(value || '').trim()
  return /^[a-zA-Z0-9._:-]{1,96}$/.test(text) ? text : fallback
}

const safeUdpTimestamp = (value, fallback = '') => {
  const text = String(value || '').trim()
  if (!text) {
    return fallback
  }
  const parsed = Date.parse(text)
  if (!Number.isFinite(parsed)) {
    return fallback
  }
  return new Date(parsed).toISOString()
}

const CONVERSATION_ATTEMPT_REF_PATTERN =
  /^m4\.prepared_sample_attempt:[0-9a-f]{32}$/
const MOTION_REQUESTED_PHASE = 'queued'
const MOTION_REQUESTED_LIFECYCLE_STATE = 'queued'
const MOTION_REQUESTED_VISIBLE_STATE = 'requested'

const requiredMotionUdpScalar = (value) => {
  const text = typeof value === 'string' ? value.trim() : ''
  return /^[a-zA-Z0-9._:-]{1,96}$/.test(text) ? text : null
}

const requiredMotionTimestamp = (value) => {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text || text.length > 64) {
    return null
  }
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}

const latestNestedMotionRequestedEvent = (events) => {
  let latest = null
  for (const journalEvent of Array.isArray(events) ? events : []) {
    const notableEvents = Array.isArray(journalEvent?.notable_events)
      ? journalEvent.notable_events
      : []
    for (const notableEvent of notableEvents) {
      if (notableEvent?.type === 'motion.requested') {
        latest = notableEvent
      }
    }
  }
  return latest
}

const validateMotionRequestedEvent = (event, nowMs = Date.now()) => {
  if (!event) {
    return { ok: false, reason: 'no_nested_motion_requested_event' }
  }

  const conversationAttemptRef =
    typeof event.conversation_attempt_ref === 'string'
      ? event.conversation_attempt_ref
      : ''
  if (!CONVERSATION_ATTEMPT_REF_PATTERN.test(conversationAttemptRef)) {
    return { ok: false, reason: 'invalid_conversation_attempt_ref' }
  }

  const summary =
    event.summary && typeof event.summary === 'object' ? event.summary : null
  const eventId = requiredMotionUdpScalar(event.event_id)
  const motionEventId = requiredMotionUdpScalar(summary?.motion_event_id)
  const stimulusId = requiredMotionUdpScalar(summary?.stimulus_id)
  const stimulusInstanceId = requiredMotionUdpScalar(
    summary?.stimulus_instance_id
  )
  if (!eventId || !motionEventId || !stimulusId || !stimulusInstanceId) {
    return { ok: false, reason: 'invalid_motion_identity' }
  }

  const traceEventId = requiredMotionUdpScalar(summary?.trace?.event_id)
  if (
    summary?.schema_version !== 'motion_stimulus.v0' ||
    summary?.phase !== MOTION_REQUESTED_PHASE ||
    summary?.lifecycle_state !== MOTION_REQUESTED_LIFECYCLE_STATE ||
    summary?.safe_visible_state !== MOTION_REQUESTED_VISIBLE_STATE ||
    traceEventId !== eventId
  ) {
    return { ok: false, reason: 'phase_event_identity_mismatch' }
  }

  const originEventAt = requiredMotionTimestamp(event.timestamp)
  const motionRequestedAt = summary?.requested_at
    ? requiredMotionTimestamp(summary.requested_at)
    : originEventAt
  if (!originEventAt || !motionRequestedAt) {
    return { ok: false, reason: 'invalid_motion_timing' }
  }
  const originEventMs = Date.parse(originEventAt)
  const motionRequestedMs = Date.parse(motionRequestedAt)
  if (
    motionRequestedMs > originEventMs + TOUCHDESIGNER_MOTION_EVENT_FUTURE_TOLERANCE_MS ||
    originEventMs - motionRequestedMs > TOUCHDESIGNER_MOTION_EVENT_MAX_AGE_MS
  ) {
    return { ok: false, reason: 'phase_event_identity_mismatch' }
  }
  if (originEventMs > nowMs + TOUCHDESIGNER_MOTION_EVENT_FUTURE_TOLERANCE_MS) {
    return { ok: false, reason: 'future_motion_event' }
  }
  if (nowMs - originEventMs > TOUCHDESIGNER_MOTION_EVENT_MAX_AGE_MS) {
    return { ok: false, reason: 'stale_motion_event' }
  }

  const identityTuple = [
    eventId,
    motionEventId,
    stimulusId,
    stimulusInstanceId
  ]
  const identityKey = JSON.stringify(identityTuple)
  return {
    ok: true,
    conversationAttemptRef,
    eventId,
    motionEventId,
    stimulusId,
    stimulusInstanceId,
    originEventAt,
    motionRequestedAt,
    identityKey,
    dedupeKey: JSON.stringify([...identityTuple, conversationAttemptRef])
  }
}

const touchDesignerMotionIdentityRefs = new Map()
const touchDesignerAttemptedMotionKeys = new Set()
const TOUCHDESIGNER_MOTION_DEDUPE_LIMIT = 256

const rememberBoundedMotionIdentity = (motion) => {
  while (
    touchDesignerMotionIdentityRefs.size >= TOUCHDESIGNER_MOTION_DEDUPE_LIMIT
  ) {
    const oldestKey = touchDesignerMotionIdentityRefs.keys().next().value
    touchDesignerMotionIdentityRefs.delete(oldestKey)
  }
  while (
    touchDesignerAttemptedMotionKeys.size >= TOUCHDESIGNER_MOTION_DEDUPE_LIMIT
  ) {
    const oldestKey = touchDesignerAttemptedMotionKeys.values().next().value
    touchDesignerAttemptedMotionKeys.delete(oldestKey)
  }
  touchDesignerMotionIdentityRefs.set(
    motion.identityKey,
    motion.conversationAttemptRef
  )
  touchDesignerAttemptedMotionKeys.add(motion.dedupeKey)
}

const sendTouchDesignerMotion = async (motion) => {
  const socket = dgram.createSocket('udp4')
  const basePayload = {
    type: 'conversation_motion',
    event: 'motion_requested',
    source: 'display_runtime_motion_event_forwarder',
    conversation_attempt_ref: motion.conversationAttemptRef,
    event_id: motion.eventId,
    motion_event_id: motion.motionEventId,
    stimulus_id: motion.stimulusId,
    stimulus_instance_id: motion.stimulusInstanceId,
    origin_event_at: motion.originEventAt,
    motion_requested_at: motion.motionRequestedAt
  }
  const sentPhases = []
  let errorClass = null

  try {
    for (const phase of ['start', 'done']) {
      if (phase === 'done') {
        await sleep(850)
      }
      const packetError = await sendTouchDesignerPacket(socket, {
        ...basePayload,
        phase,
        timestamp: nowIso()
      })
      if (packetError) {
        errorClass = 'udp_send_failed'
        break
      }
      sentPhases.push(phase)
    }
  } finally {
    socket.close()
  }

  return {
    forwarded: !errorClass,
    class: 'correlated_motion_event',
    eventId: motion.eventId,
    motionEventId: motion.motionEventId,
    phases: sentPhases,
    error: errorClass
  }
}

const forwardLatestMotionToTouchDesigner = async (events) => {
  const motion = validateMotionRequestedEvent(
    latestNestedMotionRequestedEvent(events)
  )
  if (!motion.ok) {
    return { forwarded: false, reason: motion.reason }
  }

  const boundRef = touchDesignerMotionIdentityRefs.get(motion.identityKey)
  if (boundRef && boundRef !== motion.conversationAttemptRef) {
    return { forwarded: false, reason: 'identity_ref_changed' }
  }
  if (touchDesignerAttemptedMotionKeys.has(motion.dedupeKey)) {
    return {
      forwarded: false,
      reason: 'already_forwarded',
      eventId: motion.eventId,
      motionEventId: motion.motionEventId
    }
  }

  rememberBoundedMotionIdentity(motion)
  return sendTouchDesignerMotion(motion)
}

const touchDesignerForwardedHomeActionKeys = new Set()

const homeActionUdpKey = (event) => {
  if (!event || event.event !== 'execute_succeeded') {
    return null
  }
  const actionId = safeUdpScalar(event.action_id, 'unknown_action')
  const timestamp = safeUdpTimestamp(event.timestamp)
  if (!timestamp) {
    return null
  }
  return `${timestamp}:${actionId}:execute_succeeded`
}

const sendTouchDesignerHomeAction = async (event, key) => {
  const socket = dgram.createSocket('udp4')
  const basePayload = {
    type: 'home_control_magic',
    event: 'home_action_executed',
    action_id: safeUdpScalar(event.action_id, 'unknown_action'),
    result_class: 'execute_succeeded',
    source: 'display_runtime_home_action_forwarder',
    trigger: 'home_action_events_jsonl',
    origin_event_at: safeUdpTimestamp(event.timestamp, null)
  }
  const sentPhases = []
  let error = null

  try {
    for (const phase of ['start', 'done']) {
      if (phase === 'done') {
        await sleep(850)
      }
      const phaseError = await sendTouchDesignerPacket(socket, {
        ...basePayload,
        phase,
        timestamp: nowIso()
      })
      if (phaseError) {
        error = phaseError
        break
      }
      sentPhases.push(phase)
    }
  } finally {
    socket.close()
  }

  if (!error) {
    touchDesignerForwardedHomeActionKeys.add(key)
  }

  return {
    forwarded: !error,
    host: TOUCHDESIGNER_HOST,
    port: TOUCHDESIGNER_PORT,
    actionId: basePayload.action_id,
    phases: sentPhases,
    error
  }
}

const forwardLatestHomeActionToTouchDesigner = async (events) => {
  const candidates = events.filter(
    (event) => event?.event === 'execute_succeeded'
  )
  const latest = candidates[candidates.length - 1] || null
  const key = homeActionUdpKey(latest)
  if (!key) {
    return {
      forwarded: false,
      reason: latest
        ? 'invalid_execute_succeeded_event_key'
        : 'no_execute_succeeded_event'
    }
  }
  if (touchDesignerForwardedHomeActionKeys.has(key)) {
    return {
      forwarded: false,
      reason: 'already_forwarded',
      actionId: safeUdpScalar(latest.action_id, 'unknown_action')
    }
  }
  return sendTouchDesignerHomeAction(latest, key)
}

const sendTouchDesignerTest = async () => {
  const socket = dgram.createSocket('udp4')
  const actionId = `display_ping_${Date.now()}`
  const basePayload = {
    type: 'home_control_magic',
    event: 'display_link_ping',
    action_id: actionId,
    label: 'Display Link Ping',
    source: 'display_runtime_gui'
  }
  const sentPhases = []
  let error = null

  try {
    for (const phase of ['start', 'done']) {
      if (phase === 'done') {
        await sleep(850)
      }
      const phaseError = await sendTouchDesignerPacket(socket, {
        ...basePayload,
        phase,
        timestamp: nowIso()
      })
      if (phaseError) {
        error = phaseError
        break
      }
      sentPhases.push(phase)
    }
  } finally {
    socket.close()
  }

  return {
    ok: !error,
    host: TOUCHDESIGNER_HOST,
    port: TOUCHDESIGNER_PORT,
    phases: sentPhases,
    error
  }
}

const pollHomeActionsForTouchDesigner = () => {
  forwardLatestHomeActionToTouchDesigner(readRecentHomeActionEvents()).catch(
    (error) => {
      console.warn(
        'TouchDesigner home action UDP forwarding skipped:',
        error instanceof Error ? error.message : 'unknown_error'
      )
    }
  )
}

const pollMotionEventsForTouchDesigner = () => {
  forwardLatestMotionToTouchDesigner(readRecentThoughtCoreChatEvents(32)).catch(
    () => {
      console.warn(
        'TouchDesigner correlated motion UDP forwarding skipped: internal_error'
      )
    }
  )
}

const serveStatic = (request, response) => {
  const requestUrl = new URL(
    request.url,
    `http://${request.headers.host || HOST}`
  )
  const pathname =
    requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname
  const filePath = resolvePublicFile(pathname)

  if (!filePath) {
    response.writeHead(403)
    response.end('Forbidden')
    return
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      response.writeHead(404)
      response.end('Not found')
      return
    }
    response.writeHead(200, {
      'Content-Type':
        MIME_TYPES[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    })
    response.end(data)
  })
}

const resolvePublicFile = (pathname) => {
  let decoded
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  const normalized = path.posix.normalize(decoded).replace(/^\/+/, '')
  if (
    !normalized ||
    normalized.startsWith('../') ||
    normalized.includes('/../')
  ) {
    return null
  }
  const filePath = path.resolve(PUBLIC_DIR, normalized)
  const relative = path.relative(PUBLIC_DIR, filePath)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return null
  }
  return filePath
}

const server = http.createServer(async (request, response) => {
  try {
    const requestUrl = new URL(
      request.url,
      `http://${request.headers.host || HOST}`
    )
    if (rejectUntrustedRequest(request, response)) {
      return
    }
    if (request.method === 'OPTIONS') {
      sendJson(response, 204, {}, request)
      return
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/status') {
      sendJson(
        response,
        200,
        await getStatus({
          debugTraces: debugTracesForRequest(requestUrl, request)
        }),
        request
      )
      return
    }
    if (
      request.method === 'POST' &&
      requestUrl.pathname === '/api/touchdesigner/test'
    ) {
      sendJson(response, 200, await sendTouchDesignerTest(), request)
      return
    }
    if (request.method === 'GET') {
      serveStatic(request, response)
      return
    }
    sendJson(response, 405, { ok: false, error: 'method_not_allowed' }, request)
  } catch (error) {
    sendJson(
      response,
      500,
      {
        ok: false,
        error: 'internal_server_error'
      },
      request
    )
  }
})

server.listen(PORT, HOST, () => {
  console.log(`Display runtime GUI listening on http://${HOST}:${PORT}`)
  console.log(`Remote GUI access: ${ALLOW_REMOTE_GUI ? 'enabled' : 'disabled'}`)
  console.log(`AITuber frame: ${AITUBER_URL}`)
  console.log(`Workspace root: ${WORKSPACE_ROOT}`)
  console.log(`State dir: ${STATE_DIR}`)
  console.log(`TouchDesigner UDP: ${TOUCHDESIGNER_HOST}:${TOUCHDESIGNER_PORT}`)
  console.log(
    `Camera Hub topics: via Environment State Server http://${ENVIRONMENT_STATE_HOST}:${ENVIRONMENT_STATE_PORT}/indicators/current`
  )
  if (TOUCHDESIGNER_HOME_ACTION_POLL_MS > 0) {
    const timer = setInterval(
      pollHomeActionsForTouchDesigner,
      TOUCHDESIGNER_HOME_ACTION_POLL_MS
    )
    timer.unref?.()
  }
  if (TOUCHDESIGNER_MOTION_EVENT_POLL_MS > 0) {
    const timer = setInterval(
      pollMotionEventsForTouchDesigner,
      TOUCHDESIGNER_MOTION_EVENT_POLL_MS
    )
    timer.unref?.()
  }
})

module.exports = {
  forwardLatestMotionToTouchDesigner,
  sanitizeChatEvent,
  validateMotionRequestedEvent
}
