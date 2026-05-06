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
const AITUBER_URL = readArg(
  '--aituber-url',
  process.env.AITUBER_URL ||
    process.env.NEXT_PUBLIC_AITUBER_URL ||
    'http://127.0.0.1:3000'
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

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
}

const nowIso = () => new Date().toISOString()

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

const summarizePipeline = (lastDifyEvent, lastHomeEvent) => {
  if (!lastDifyEvent) {
    return {
      stage: 'WAITING_FOR_INPUT',
      detail: 'No AITuber -> Dify request has been recorded yet.',
      updated_at: lastHomeEvent?.timestamp || null
    }
  }

  const difyAt = Date.parse(lastDifyEvent.timestamp || '')
  const homeAt = Date.parse(lastHomeEvent?.timestamp || '')
  const homeAfterDify =
    Number.isFinite(difyAt) &&
    Number.isFinite(homeAt) &&
    homeAt >= difyAt - 1000

  if (
    ['config_error', 'request_failed', 'request_exception'].includes(
      lastDifyEvent.event
    )
  ) {
    return {
      stage: 'AITUBER_TO_DIFY_FAILED',
      detail:
        lastDifyEvent.detail ||
        lastDifyEvent.status_text ||
        `Dify event: ${lastDifyEvent.event}`,
      updated_at: lastDifyEvent.timestamp || null
    }
  }

  if (lastDifyEvent.event === 'request_started') {
    return {
      stage: 'DIFY_REQUESTING',
      detail: lastDifyEvent.query || 'Waiting for Dify response.',
      updated_at: lastDifyEvent.timestamp || null
    }
  }

  if (homeAfterDify && lastHomeEvent?.event === 'execute_succeeded') {
    return {
      stage: 'HOME_ACTION_SUCCEEDED',
      detail: `${lastHomeEvent.action_id || '-'} / ${lastHomeEvent.user_text || ''}`,
      updated_at: lastHomeEvent.timestamp || null
    }
  }

  return {
    stage: 'DIFY_OK_WAITING_HOME_ACTION',
    detail:
      lastDifyEvent.event === 'stream_opened'
        ? 'Dify stream opened; waiting for workflow/tool side effect.'
        : lastDifyEvent.query || `Dify event: ${lastDifyEvent.event}`,
    updated_at: lastDifyEvent.timestamp || null
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
    checkTcp(3000),
    checkHttp('http://127.0.0.1:3000', 1800),
    checkTcp(8080),
    checkHttp('http://127.0.0.1:8080', 1800),
    checkTcp(voicevoxPort),
    checkHttp(`${voicevoxUrl.replace(/\/$/, '')}/version`, 1800),
    checkWebSocketHandshake(MEDIAPIPE_PORT)
  ])

  const mediapipeEntry =
    pids.mediapipe_camera_hub ||
    pids.mediapipe_camera_hub_gui ||
    pids.mediapipe_ws
  const mediapipeStatus = withAge(readJsonFile(MEDIAPIPE_STATUS_FILE))
  const mediapipeStatusFresh =
    typeof mediapipeStatus?.age_ms === 'number' && mediapipeStatus.age_ms < 5000
  const mediapipeReportedListening =
    mediapipeStatusFresh &&
    typeof mediapipeStatus?.websocket === 'string' &&
    mediapipeStatus.websocket.toLowerCase().startsWith('listening')
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

  const events = readRecentHomeActionEvents()
  const difyEvents = readRecentDifyChatEvents()
  const lastEvent = events[events.length - 1] || null
  const lastDifyEvent = difyEvents[difyEvents.length - 1] || null
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
    mediapipe: mediapipeStatus,
    homeActions: {
      events,
      lastEvent
    },
    difyChat: {
      events: difyEvents,
      lastEvent: lastDifyEvent
    },
    pipeline: summarizePipeline(lastDifyEvent, lastEvent),
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
})
