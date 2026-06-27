const assert = require('node:assert/strict')
const fs = require('node:fs')
const Module = require('node:module')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const readSource = (...segments) =>
  fs.readFileSync(path.join(__dirname, '..', ...segments), 'utf8')

test('display runtime GUI keeps local-only HTTP guard and status endpoints', () => {
  const source = readSource('tools', 'server.js')

  assert.match(source, /DEFAULT_HOSTS = \{\s+loopback: '127\.0\.0\.1'\s+\}/)
  assert.match(source, /process\.env\.TOUCHDESIGNER_GUI_HOST \|\| DEFAULT_HOSTS\.loopback/)
  assert.match(source, /process\.env\.TOUCHDESIGNER_GUI_ALLOW_REMOTE === 'true'/)
  assert.match(source, /local_access_required/)
  assert.match(source, /untrusted_origin/)
  assert.match(source, /requestUrl\.pathname === '\/api\/status'/)
  assert.match(source, /requestUrl\.pathname === '\/api\/touchdesigner\/test'/)
})

test('display runtime GUI exposes UDP test state as summary only', () => {
  const source = readSource('tools', 'server.js')

  assert.match(source, /type: 'home_control_magic'/)
  assert.match(source, /event: 'display_link_ping'/)
  assert.match(source, /source: 'display_runtime_gui'/)
  assert.match(source, /for \(const phase of \['start', 'done'\]\)/)
  assert.match(source, /UDP receiver cannot be health-checked/)
  assert.doesNotMatch(source, /TOKEN|SECRET|PASSWORD/)
})

test('display runtime defaults to passive Projection Visual for projector output', () => {
  const source = readSource('tools', 'server.js')

  assert.match(source, /AITUBER_HOST/)
  assert.match(source, /AITUBER_PORT/)
  assert.match(source, /AITUBER_STATUS_TARGET/)
  assert.match(source, /projection-visual\?mode=passive&hud=0/)
  assert.match(source, /process\.env\.AITUBER_URL/)
  assert.match(source, /process\.env\.NEXT_PUBLIC_AITUBER_URL/)
  assert.doesNotMatch(source, /checkTcp\(3000\)/)
  assert.doesNotMatch(source, /checkHttp\('http:\/\/127\.0\.0\.1:3000'/)
})

test('display runtime status redacts raw trace text unless debug is explicit', () => {
  const source = readSource('tools', 'server.js')

  assert.match(source, /DISPLAY_RUNTIME_DEBUG_TRACES/)
  assert.match(source, /debugTracesForRequest/)
  assert.match(source, /requestUrl\.searchParams\.get\('debug'\)/)
  assert.match(source, /isLoopbackAddress\(getRemoteAddress\(request\)\)/)
  assert.match(source, /debug trace hidden/)
  assert.match(source, /sanitizeHomeActionEvent/)
  assert.match(source, /sanitizeChatEvent/)
  assert.match(source, /sanitizeConversationEntry/)
  assert.match(source, /workspaceRootSummary/)
  assert.match(source, /localPathForStatus/)
  assert.match(source, /traceMode/)
  assert.match(source, /debugTracesForRequest\(requestUrl, request\)/)
})

test('display runtime forwards Thought Core service telemetry when observed', () => {
  const source = readSource('tools', 'server.js')

  assert.match(source, /THOUGHT_CORE_HOST/)
  assert.match(source, /THOUGHT_CORE_PORT/)
  assert.match(source, /HOME_ASSISTANT_BRIDGE_HOST/)
  assert.match(source, /HOME_ASSISTANT_BRIDGE_PORT/)
  assert.match(source, /ENVIRONMENT_STATE_HOST/)
  assert.match(source, /ENVIRONMENT_STATE_PORT/)
  assert.match(source, /checkTcp\(HOME_ASSISTANT_BRIDGE_PORT, HOME_ASSISTANT_BRIDGE_HOST\)/)
  assert.match(source, /HOME_ASSISTANT_BRIDGE_PORT\}\/operator/)
  assert.doesNotMatch(source, /HOME_ASSISTANT_BRIDGE_PORT\}\/health/)
  assert.match(source, /checkTcp\(ENVIRONMENT_STATE_PORT, ENVIRONMENT_STATE_HOST\)/)
  assert.match(source, /checkTcp\(THOUGHT_CORE_PORT, THOUGHT_CORE_HOST\)/)
  assert.match(source, /\/health/)
  assert.match(source, /summarizeThoughtCoreTcpProbe/)
  assert.match(source, /summarizeThoughtCoreHealthProbe/)
  assert.match(source, /detail: 'health ok'/)
  assert.match(source, /detail: 'health unavailable'/)
  assert.match(source, /detail: 'tcp listening'/)
  assert.match(source, /detail: 'tcp unavailable'/)
  assert.match(source, /detail = ok \? 'health ok' : 'health unavailable'/)
  assert.match(source, /return \{ ok: true, detail: 'tcp listening', latencyMs \}/)
  assert.match(source, /return \{ ok: true, statusCode, detail: 'health ok', latencyMs \}/)
  assert.doesNotMatch(source, /JSON\.stringify\(parsed\)/)
  assert.doesNotMatch(source, /return \{ \.\.\.probe, detail:/)
  assert.match(source, /thoughtCoreApiTelemetryPresent/)
  assert.match(source, /pids\.thought_core_api/)
  assert.match(source, /services\.thought_core_api = makeService/)
  assert.match(source, /tcp: summarizeThoughtCoreTcpProbe\(thoughtCoreTcp\)/)
  assert.match(source, /http: summarizeThoughtCoreHealthProbe\(thoughtCoreHttp\)/)
  assert.doesNotMatch(source, /http: thoughtCoreHttp,\s+requireHttp: true/)
  assert.doesNotMatch(source, /checkTcp\(8787\)/)
  assert.doesNotMatch(source, /127\.0\.0\.1:8787/)
  assert.match(source, /pids\.thought_core_watcher/)
  assert.match(source, /services\.thought_core_watcher = makeService/)
  assert.match(source, /processOnlyOk: true/)
})

test('display HUD exposes canonical runtime services without legacy Dify grouping', () => {
  const source = readSource('tools', 'public', 'app.js')
  const styles = readSource('tools', 'public', 'styles.css')

  assert.match(source, /touchdesigner_control_gui: 'Display runtime'/)
  assert.match(source, /payload\?\.url \|\| 'about:blank'/)
  assert.doesNotMatch(source, /Dify compatibility|legacyServices|service-legacy/)
  assert.doesNotMatch(source, /http:\/\/127\.0\.0\.1:3000/)
  assert.doesNotMatch(styles, /service-legacy/)
  assert.match(source, /fetch\('\/api\/status', \{ cache: 'no-store' \}\)/)
  assert.match(source, /fetch\('\/api\/touchdesigner\/test', \{ method: 'POST' \}\)/)
})

test('display runtime UDP command route is testable with a fake UDP sender', async () => {
  const serverPath = path.join(__dirname, '..', 'tools', 'server.js')
  const originalLoad = Module._load
  const originalArgv = process.argv
  const originalEnv = process.env
  let capturedHandler = null
  const udpSends = []

  class FakeSocket {
    send(payload, port, host, callback) {
      udpSends.push({
        payload: JSON.parse(Buffer.from(payload).toString('utf8')),
        port,
        host
      })
      callback(null)
    }

    close() {}
  }

  class FakeServer {
    listen(_port, _host, callback) {
      callback?.()
      return this
    }
  }

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'node:dgram' || request === 'dgram') {
      return {
        createSocket(type) {
          assert.equal(type, 'udp4')
          return new FakeSocket()
        }
      }
    }
    if (request === 'node:http' || request === 'http') {
      return {
        ...originalLoad.call(this, request, parent, isMain),
        createServer(handler) {
          capturedHandler = handler
          return new FakeServer()
        }
      }
    }
    return originalLoad.call(this, request, parent, isMain)
  }

  process.argv = [
    process.argv[0],
    serverPath,
    '--host',
    '127.0.0.1',
    '--port',
    '0',
    '--touchdesigner-host',
    '127.0.0.1',
    '--touchdesigner-port',
    '19001'
  ]
  process.env = {
    ...originalEnv,
    HOME_CONTROL_WORKSPACE_ROOT: path.join(__dirname, '..'),
    HOME_CONTROL_STACK_STATE_DIR: path.join(__dirname, '..', '.cache', 'test')
  }
  delete require.cache[require.resolve(serverPath)]

  try {
    require(serverPath)
    assert.equal(typeof capturedHandler, 'function')

    const response = await invokeCapturedRoute(capturedHandler, {
      method: 'POST',
      url: '/api/touchdesigner/test',
      headers: { host: '127.0.0.1' },
      remoteAddress: '127.0.0.1'
    })

    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.body, {
      ok: true,
      host: '127.0.0.1',
      port: 19001,
      phases: ['start', 'done'],
      error: null
    })
    assert.equal(udpSends.length, 2)
    assert.equal(udpSends[0].host, '127.0.0.1')
    assert.equal(udpSends[0].port, 19001)
    assert.equal(udpSends[0].payload.type, 'home_control_magic')
    assert.equal(udpSends[0].payload.event, 'display_link_ping')
    assert.equal(udpSends[0].payload.phase, 'start')
    assert.equal(udpSends[1].payload.phase, 'done')
    assert.equal(
      udpSends[0].payload.source,
      'display_runtime_gui'
    )
    assert.match(udpSends[0].payload.action_id, /^display_ping_/)
    assert.match(udpSends[0].payload.timestamp, /^\d{4}-\d{2}-\d{2}T/)
  } finally {
    Module._load = originalLoad
    process.argv = originalArgv
    process.env = originalEnv
    delete require.cache[require.resolve(serverPath)]
  }
})

test('display runtime forwards home action events to TouchDesigner UDP without raw prompt text', async () => {
  const serverPath = path.join(__dirname, '..', 'tools', 'server.js')
  const originalLoad = Module._load
  const originalArgv = process.argv
  const originalEnv = process.env
  const workspaceRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'display-runtime-home-action-')
  )
  const eventsDir = path.join(
    workspaceRoot,
    'organs',
    'action',
    'home-assistant-server',
    '.cache',
    'home_control'
  )
  fs.mkdirSync(eventsDir, { recursive: true })
  fs.writeFileSync(
    path.join(eventsDir, 'events.jsonl'),
    `${JSON.stringify({
      event: 'execute_succeeded',
      action_id: 'light_on',
      user_text: 'raw user request must not be sent to UDP',
      timestamp: '2026-06-25T09:00:00.000+09:00'
    })}\n`,
    'utf8'
  )

  let capturedHandler = null
  const udpSends = []

  class FakeSocket {
    send(payload, port, host, callback) {
      udpSends.push({
        payload: JSON.parse(Buffer.from(payload).toString('utf8')),
        port,
        host
      })
      callback(null)
    }

    close() {}
  }

  class FakeServer {
    listen(_port, _host, callback) {
      callback?.()
      return this
    }
  }

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'node:dgram' || request === 'dgram') {
      return {
        createSocket(type) {
          assert.equal(type, 'udp4')
          return new FakeSocket()
        }
      }
    }
    if (request === 'node:http' || request === 'http') {
      return {
        ...originalLoad.call(this, request, parent, isMain),
        createServer(handler) {
          capturedHandler = handler
          return new FakeServer()
        }
      }
    }
    return originalLoad.call(this, request, parent, isMain)
  }

  process.argv = [
    process.argv[0],
    serverPath,
    '--host',
    '127.0.0.1',
    '--port',
    '0',
    '--touchdesigner-host',
    '127.0.0.1',
    '--touchdesigner-port',
    '19001',
    '--touchdesigner-home-action-poll-ms',
    '0'
  ]
  process.env = {
    ...originalEnv,
    HOME_CONTROL_WORKSPACE_ROOT: workspaceRoot,
    HOME_CONTROL_STACK_STATE_DIR: path.join(workspaceRoot, '.cache', 'test')
  }
  delete require.cache[require.resolve(serverPath)]

  try {
    require(serverPath)
    assert.equal(typeof capturedHandler, 'function')

    const response = await invokeCapturedRoute(capturedHandler, {
      method: 'GET',
      url: '/api/status',
      headers: { host: '127.0.0.1' },
      remoteAddress: '127.0.0.1'
    })

    assert.equal(response.statusCode, 200)
    assert.equal(response.body.magic.udpForward.forwarded, true)
    assert.equal(response.body.magic.udpForward.actionId, 'light_on')
    assert.equal(
      response.body.homeActions.eventSourceSummary.label,
      'events.jsonl'
    )
    assert.equal(response.body.homeActions.eventSourceSummary.trace_redacted, true)
    assert.equal(udpSends.length, 2)
    assert.equal(udpSends[0].host, '127.0.0.1')
    assert.equal(udpSends[0].port, 19001)
    assert.equal(udpSends[0].payload.type, 'home_control_magic')
    assert.equal(udpSends[0].payload.event, 'home_action_executed')
    assert.equal(udpSends[0].payload.source, 'display_runtime_home_action_forwarder')
    assert.equal(udpSends[0].payload.trigger, 'home_action_events_jsonl')
    assert.equal(udpSends[0].payload.action_id, 'light_on')
    assert.equal(udpSends[0].payload.result_class, 'execute_succeeded')
    assert.equal(udpSends[0].payload.origin_event_at, '2026-06-25T00:00:00.000Z')
    assert.equal(udpSends[0].payload.phase, 'start')
    assert.equal(udpSends[1].payload.phase, 'done')
    assert.equal(udpSends[0].payload.user_text, undefined)
    assert.equal(udpSends[0].payload.detail, undefined)
    assert.equal(udpSends[0].payload.error, undefined)

    const secondResponse = await invokeCapturedRoute(capturedHandler, {
      method: 'GET',
      url: '/api/status',
      headers: { host: '127.0.0.1' },
      remoteAddress: '127.0.0.1'
    })

    assert.equal(secondResponse.body.magic.udpForward.forwarded, false)
    assert.equal(secondResponse.body.magic.udpForward.reason, 'already_forwarded')
    assert.equal(udpSends.length, 2)
  } finally {
    Module._load = originalLoad
    process.argv = originalArgv
    process.env = originalEnv
    delete require.cache[require.resolve(serverPath)]
    fs.rmSync(workspaceRoot, { recursive: true, force: true })
  }
})

test('display runtime rejects untrusted UDP command origins before sending', async () => {
  const serverPath = path.join(__dirname, '..', 'tools', 'server.js')
  const originalLoad = Module._load
  let capturedHandler = null
  let udpSendCount = 0

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'node:dgram' || request === 'dgram') {
      return {
        createSocket() {
          return {
            send() {
              udpSendCount += 1
            },
            close() {}
          }
        }
      }
    }
    if (request === 'node:http' || request === 'http') {
      return {
        createServer(handler) {
          capturedHandler = handler
          return {
            listen(_port, _host, callback) {
              callback?.()
              return this
            }
          }
        }
      }
    }
    return originalLoad.call(this, request, parent, isMain)
  }
  delete require.cache[require.resolve(serverPath)]

  try {
    require(serverPath)
    const response = await invokeCapturedRoute(capturedHandler, {
      method: 'POST',
      url: '/api/touchdesigner/test',
      headers: {
        host: '127.0.0.1',
        origin: 'https://evil.example'
      },
      remoteAddress: '127.0.0.1'
    })

    assert.equal(response.statusCode, 403)
    assert.equal(response.body.ok, false)
    assert.equal(response.body.error, 'untrusted_origin')
    assert.equal(udpSendCount, 0)
  } finally {
    Module._load = originalLoad
    delete require.cache[require.resolve(serverPath)]
  }
})

test('display runtime proxy guard falls back to socket for blank forwarded address', async () => {
  const serverPath = path.join(__dirname, '..', 'tools', 'server.js')
  const originalLoad = Module._load
  const originalArgv = process.argv
  const originalEnv = process.env
  let capturedHandler = null

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'node:http' || request === 'http') {
      return {
        createServer(handler) {
          capturedHandler = handler
          return {
            listen(_port, _host, callback) {
              callback?.()
              return this
            }
          }
        }
      }
    }
    return originalLoad.call(this, request, parent, isMain)
  }

  process.argv = [
    process.argv[0],
    serverPath,
    '--host',
    '127.0.0.1',
    '--port',
    '0'
  ]
  process.env = {
    ...originalEnv,
    TOUCHDESIGNER_GUI_TRUST_PROXY_HEADERS: 'true',
    TOUCHDESIGNER_GUI_ALLOW_REMOTE: 'false'
  }
  delete require.cache[require.resolve(serverPath)]

  try {
    require(serverPath)
    const response = await invokeCapturedRoute(capturedHandler, {
      method: 'GET',
      url: '/api/status',
      headers: {
        host: '127.0.0.1',
        'x-forwarded-for': ' , 127.0.0.1'
      },
      remoteAddress: '203.0.113.10'
    })

    assert.equal(response.statusCode, 403)
    assert.equal(response.body.ok, false)
    assert.equal(response.body.error, 'local_access_required')
  } finally {
    Module._load = originalLoad
    process.argv = originalArgv
    process.env = originalEnv
    delete require.cache[require.resolve(serverPath)]
  }
})

function invokeCapturedRoute(handler, requestOptions) {
  return new Promise((resolve, reject) => {
    const response = {
      statusCode: 200,
      headers: {},
      chunks: [],
      writeHead(statusCode, headers = {}) {
        this.statusCode = statusCode
        this.headers = headers
      },
      end(chunk = '') {
        if (chunk) {
          this.chunks.push(Buffer.from(String(chunk)))
        }
        const text = Buffer.concat(this.chunks).toString('utf8')
        resolve({
          statusCode: this.statusCode,
          headers: this.headers,
          text,
          body: text ? JSON.parse(text) : null
        })
      }
    }
    Promise.resolve(
      handler(
        {
          method: requestOptions.method,
          url: requestOptions.url,
          headers: requestOptions.headers || {},
          socket: { remoteAddress: requestOptions.remoteAddress }
        },
        response
      )
    ).catch(reject)
  })
}
