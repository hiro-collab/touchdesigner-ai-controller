const assert = require('node:assert/strict')
const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')
const test = require('node:test')

const readSource = (...segments) =>
  fs.readFileSync(path.join(__dirname, '..', ...segments), 'utf8')

test('display runtime GUI keeps local-only HTTP guard and status endpoints', () => {
  const source = readSource('tools', 'server.js')

  assert.match(source, /process\.env\.TOUCHDESIGNER_GUI_HOST \|\| '127\.0\.0\.1'/)
  assert.match(source, /process\.env\.TOUCHDESIGNER_GUI_ALLOW_REMOTE === 'true'/)
  assert.match(source, /local_access_required/)
  assert.match(source, /untrusted_origin/)
  assert.match(source, /requestUrl\.pathname === '\/api\/status'/)
  assert.match(source, /requestUrl\.pathname === '\/api\/touchdesigner\/test'/)
})

test('display runtime GUI exposes UDP test state as summary only', () => {
  const source = readSource('tools', 'server.js')

  assert.match(source, /type: 'home_control_magic'/)
  assert.match(source, /event: 'gui_test'/)
  assert.match(source, /source: 'touchdesigner_control_gui'/)
  assert.match(source, /UDP receiver cannot be health-checked/)
  assert.doesNotMatch(source, /TOKEN|SECRET|PASSWORD/)
})

test('display runtime defaults to passive Projection Visual for projector output', () => {
  const source = readSource('tools', 'server.js')

  assert.match(source, /'http:\/\/127\.0\.0\.1:3000\/projection-visual\?mode=passive'/)
  assert.match(source, /process\.env\.AITUBER_URL/)
  assert.match(source, /process\.env\.NEXT_PUBLIC_AITUBER_URL/)
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

test('display HUD groups legacy Dify without hiding Display Runtime identity', () => {
  const source = readSource('tools', 'public', 'app.js')

  assert.match(source, /touchdesigner_control_gui: 'Display runtime'/)
  assert.match(source, /dify: 'Dify compatibility'/)
  assert.match(source, /const legacyServices = new Set\(\['dify'\]\)/)
  assert.match(source, /service-legacy/)
  assert.match(source, /legacy/)
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
      error: null
    })
    assert.equal(udpSends.length, 1)
    assert.equal(udpSends[0].host, '127.0.0.1')
    assert.equal(udpSends[0].port, 19001)
    assert.equal(udpSends[0].payload.type, 'home_control_magic')
    assert.equal(udpSends[0].payload.event, 'gui_test')
    assert.equal(
      udpSends[0].payload.source,
      'touchdesigner_control_gui'
    )
    assert.match(udpSends[0].payload.timestamp, /^\d{4}-\d{2}-\d{2}T/)
  } finally {
    Module._load = originalLoad
    process.argv = originalArgv
    process.env = originalEnv
    delete require.cache[require.resolve(serverPath)]
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
