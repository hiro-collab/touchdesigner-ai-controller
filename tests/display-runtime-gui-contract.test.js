const assert = require('node:assert/strict')
const fs = require('node:fs')
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
  assert.match(source, /debug trace hidden/)
  assert.match(source, /sanitizeHomeActionEvent/)
  assert.match(source, /sanitizeChatEvent/)
  assert.match(source, /sanitizeConversationEntry/)
  assert.match(source, /traceMode/)
  assert.match(source, /await getStatus\(\{ debugTraces:/)
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
