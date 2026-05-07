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

const WORKSPACE_ROOT = path.resolve(
  readArg(
    '--workspace',
    process.env.HOME_CONTROL_WORKSPACE_ROOT || DEFAULT_WORKSPACE_ROOT
  )
)
const HOST = readArg(
  '--host',
  process.env.TOUCHDESIGNER_GUI_HOST || '127.0.0.1'
)
const PORT = parseIntArg(
  '--port',
  Number(process.env.TOUCHDESIGNER_GUI_PORT || 8788)
)
const ALLOW_REMOTE_GUI =
  args.includes('--allow-remote') ||
  process.env.TOUCHDESIGNER_GUI_ALLOW_REMOTE === 'true'
const TRUST_PROXY_HEADERS =
  process.env.TOUCHDESIGNER_GUI_TRUST_PROXY_HEADERS === 'true'
const MEDIAPIPE_PORT = parseIntArg(
  '--mediapipe-port',
  Number(process.env.MEDIAPIPE_PORT || 8765)
)
const ENVIRONMENT_STATE_PORT = parseIntArg(
  '--environment-state-port',
  Number(process.env.ENVIRONMENT_STATE_PORT || 8790)
)
const AITUBER_URL = readArg(
  '--aituber-url',
  process.env.AITUBER_URL ||
    process.env.NEXT_PUBLIC_AITUBER_URL ||
    'http://127.0.0.1:3000/projection-visual'
)
const TOUCHDESIGNER_HOST = readArg(
  '--touchdesigner-host',
  process.env.TOUCHDESIGNER_UDP_HOST || '127.0.0.1'
)
const TOUCHDESIGNER_PORT = parseIntArg(
  '--touchdesigner-port',
  Number(process.env.TOUCHDESIGNER_UDP_PORT || 9001)
)
const STATE_DIR = path.resolve(
  process.env.HOME_CONTROL_STACK_STATE_DIR ||
    path.join(WORKSPACE_ROOT, '.cache', 'home-control-stack')
)

const PUBLIC_DIR = path.join(__dirname, 'public')
const PID_FILE = path.join(STATE_DIR, 'pids.json')
const MEDIAPIPE_STATUS_FILE = path.join(STATE_DIR, 'mediapipe-status.json')
const HOME_ACTION_EVENTS_FILE = path.join(
  WORKSPACE_ROOT,
  'home-assistant-server',
  '.cache',
  'home_control',
  'events.jsonl'
)
const DIFY_CHAT_EVENTS_FILE = path.join(STATE_DIR, 'dify-chat-events.jsonl')
const THOUGHT_CORE_CHAT_EVENTS_FILE = path.join(
  STATE_DIR,
  'thought-core-chat-events.jsonl'
)

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
    return normalizeIpAddress(forwardedFor.split(',')[0])
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

const checkTcp = (port, host = '127.0.0.1', timeoutMs = 900) =>
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

const checkWebSocketHandshake = (port, host = '127.0.0.1', timeoutMs = 900) =>
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
              detail = JSON.stringify(parsed)
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
  detail = ''
}) => {
  const processAlive = isProcessAlive(Number(entry?.pid))
  const tcpOk = Boolean(tcp?.ok)
  const httpOk = Boolean(http?.ok)
  return {
    name,
    state: serviceState({ processAlive, tcpOk, httpOk, requireHttp }),
    processAlive,
    pid: Number(entry?.pid) || null,
    tcp: tcp || { ok: false, detail: '-' },
    http: http || { ok: false, detail: '-' },
    detail
  }
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

const readRecentDifyChatEvents = (limit = 8) =>
  readRecentJsonlEvents(DIFY_CHAT_EVENTS_FILE, limit)

const readRecentThoughtCoreChatEvents = (limit = 8) =>
  readRecentJsonlEvents(THOUGHT_CORE_CHAT_EVENTS_FILE, limit)

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
      ? `stale via Environment / Camera Hub ws://127.0.0.1:${MEDIAPIPE_PORT}`
      : `fresh via Environment / Camera Hub ws://127.0.0.1:${MEDIAPIPE_PORT}`,
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

const tagChatEvents = (events, source) =>
  events.map((event) => ({
    ...event,
    source
  }))

const latestChatEvent = (difyEvents, thoughtCoreEvents) => {
  const candidates = [
    ...tagChatEvents(difyEvents, 'dify'),
    ...tagChatEvents(thoughtCoreEvents, 'thought-core')
  ]
    .map((event) => ({
      ...event,
      timestamp_ms: Date.parse(event.timestamp || '')
    }))
    .filter((event) => Number.isFinite(event.timestamp_ms))
    .sort((left, right) => left.timestamp_ms - right.timestamp_ms)
  return candidates[candidates.length - 1] || null
}

const chatSourceLabel = (event) =>
  event?.source === 'thought-core' ? 'Thought Core' : 'Dify'

const chatSourceStage = (event) =>
  event?.source === 'thought-core' ? 'THOUGHT_CORE' : 'DIFY'

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
    stage: 'DIFY_OK_WAITING_HOME_ACTION',
    source: lastChatEvent.source,
    event: lastChatEvent.event,
    detail:
      lastChatEvent.event === 'stream_opened'
        ? 'Dify stream opened; waiting for workflow/tool side effect.'
        : lastChatEvent.query || `Dify event: ${lastChatEvent.event}`,
    updated_at: lastChatEvent.timestamp || null
  }
}

const getStatus = async () => {
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
    difyTcp,
    difyHttp,
    voicevoxTcp,
    voicevoxHttp,
    mediapipeWebSocket
  ] = await Promise.all([
    checkTcp(8787),
    checkHttp('http://127.0.0.1:8787/health', 2500, true),
    checkTcp(ENVIRONMENT_STATE_PORT),
    checkHttp(`http://127.0.0.1:${ENVIRONMENT_STATE_PORT}/health`, 1800, true),
    checkTcp(3000),
    checkHttp('http://127.0.0.1:3000', 1800),
    checkTcp(8080),
    checkHttp('http://127.0.0.1:8080', 1800),
    checkTcp(voicevoxPort),
    checkHttp(`${voicevoxUrl.replace(/\/$/, '')}/version`, 1800),
    checkWebSocketHandshake(MEDIAPIPE_PORT)
  ])
  const environmentIndicators = await fetchJson(
    `http://127.0.0.1:${ENVIRONMENT_STATE_PORT}/indicators/current`,
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
        ? `ws://127.0.0.1:${MEDIAPIPE_PORT} listening`
        : 'waiting for MediaPipe WebSocket'
    }),
    aituber_kit: makeService({
      name: 'aituber_kit',
      entry: pids.aituber_kit,
      tcp: aituberTcp,
      http: aituberHttp,
      requireHttp: true
    }),
    dify: makeService({
      name: 'dify',
      entry: null,
      tcp: difyTcp,
      http: difyHttp,
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
  if (
    environmentIndicators?.nodes &&
    typeof environmentIndicators.nodes === 'object'
  ) {
    for (const [nodeId, node] of Object.entries(environmentIndicators.nodes)) {
      services[nodeId] = serviceFromIndicatorNode(node, services[nodeId])
    }
  }

  const events = readRecentHomeActionEvents()
  const difyEvents = readRecentDifyChatEvents()
  const thoughtCoreEvents = readRecentThoughtCoreChatEvents()
  const lastEvent = events[events.length - 1] || null
  const lastDifyEvent = difyEvents[difyEvents.length - 1] || null
  const lastThoughtCoreEvent =
    thoughtCoreEvents[thoughtCoreEvents.length - 1] || null
  const lastAiEvent = latestChatEvent(difyEvents, thoughtCoreEvents)
  const lastEventAt = lastEvent?.timestamp ? Date.parse(lastEvent.timestamp) : 0
  const magicActive =
    lastEvent?.event === 'execute_succeeded' &&
    Number.isFinite(lastEventAt) &&
    Date.now() - lastEventAt < 8500

  return {
    ok: true,
    timestamp: nowIso(),
    workspaceRoot: WORKSPACE_ROOT,
    touchdesigner: {
      udpHost: TOUCHDESIGNER_HOST,
      udpPort: TOUCHDESIGNER_PORT,
      state: 'UDP_READY',
      detail: 'UDP receiver cannot be health-checked; test packets can be sent.'
    },
    aituber: {
      url: AITUBER_URL
    },
    services,
    environment: environmentIndicators?.environment || null,
    indicators: environmentIndicators || null,
    mediapipe: mediapipeStatus,
    homeActions: {
      events,
      lastEvent
    },
    difyChat: {
      events: difyEvents,
      lastEvent: lastDifyEvent
    },
    thoughtCoreChat: {
      events: thoughtCoreEvents,
      lastEvent: lastThoughtCoreEvent
    },
    aiChat: {
      lastEvent: lastAiEvent
    },
    pipeline: summarizePipeline(lastAiEvent, lastEvent),
    magic: {
      active: magicActive,
      lastActionId: lastEvent?.action_id || null,
      lastUserText: lastEvent?.user_text || null,
      lastEventAt: lastEvent?.timestamp || null
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

const sendTouchDesignerTest = () =>
  new Promise((resolve) => {
    const socket = dgram.createSocket('udp4')
    const payload = Buffer.from(
      JSON.stringify({
        type: 'home_control_magic',
        event: 'gui_test',
        source: 'touchdesigner_control_gui',
        timestamp: nowIso()
      })
    )
    socket.send(payload, TOUCHDESIGNER_PORT, TOUCHDESIGNER_HOST, (error) => {
      socket.close()
      resolve({
        ok: !error,
        host: TOUCHDESIGNER_HOST,
        port: TOUCHDESIGNER_PORT,
        error: error ? error.message : null
      })
    })
  })

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
      sendJson(response, 200, await getStatus(), request)
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
  console.log(`TouchDesigner control GUI listening on http://${HOST}:${PORT}`)
  console.log(`Remote GUI access: ${ALLOW_REMOTE_GUI ? 'enabled' : 'disabled'}`)
  console.log(`AITuber frame: ${AITUBER_URL}`)
  console.log(`Workspace root: ${WORKSPACE_ROOT}`)
  console.log(`State dir: ${STATE_DIR}`)
  console.log(`TouchDesigner UDP: ${TOUCHDESIGNER_HOST}:${TOUCHDESIGNER_PORT}`)
  console.log(
    `Camera Hub topics: via Environment State Server http://127.0.0.1:${ENVIRONMENT_STATE_PORT}/indicators/current`
  )
})
