const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const {
  READY_MESSAGE,
  READY_VERSION,
  createDisplayCaptureSession,
} = require('../tools/public/displayCaptureSession.js')

class FakeEventTarget {
  constructor() {
    this.listeners = new Map()
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener)
  }

  emit(type, event = {}) {
    for (const listener of [...(this.listeners.get(type) || [])]) {
      listener(event)
    }
  }

  count(type) {
    return this.listeners.get(type)?.size || 0
  }
}

const makeTrack = (displaySurface = 'browser') => {
  const target = new FakeEventTarget()
  return {
    ...target,
    listeners: target.listeners,
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    emit: target.emit.bind(target),
    stopCount: 0,
    getSettings: () => ({ displaySurface }),
    stop() {
      this.stopCount += 1
    },
  }
}

const makeStream = ({ displaySurface = 'browser', videoCount = 1, audioCount = 0 } = {}) => {
  const videoTracks = Array.from({ length: videoCount }, () => makeTrack(displaySurface))
  const audioTracks = Array.from({ length: audioCount }, () => makeTrack())
  return {
    videoTracks,
    audioTracks,
    getVideoTracks: () => videoTracks,
    getAudioTracks: () => audioTracks,
    getTracks: () => [...videoTracks, ...audioTracks],
  }
}

const makeHarness = ({
  stream = makeStream(),
  captureError,
  ackMode = 'valid',
  openerMatches = true,
  userActivation = true,
  playPromise,
} = {}) => {
  const ownerWindow = new FakeEventTarget()
  ownerWindow.location = {
    origin: 'http://127.0.0.1:9001',
    href: 'http://127.0.0.1:9001/',
  }
  ownerWindow.navigator = { userActivation: { isActive: userActivation } }
  ownerWindow.setTimeout = setTimeout
  ownerWindow.clearTimeout = clearTimeout
  ownerWindow.setInterval = setInterval
  ownerWindow.clearInterval = clearInterval

  const video = {
    srcObject: null,
    dataset: {},
    playCount: 0,
    async play() {
      this.playCount += 1
      resolvePlayStarted()
      await playPromise
    },
  }
  const projectorWindow = {
    closed: false,
    closeCount: 0,
    opener: openerMatches ? ownerWindow : null,
    location: { origin: ownerWindow.location.origin },
    document: {
      getElementById: (id) => (id === 'projection-stream' ? video : null),
    },
    close() {
      this.closed = true
      this.closeCount += 1
    },
  }
  const transitions = []
  const captureCalls = []
  let openCount = 0
  let closePoll = null
  let resolvePlayStarted
  const playStarted = new Promise((resolve) => {
    resolvePlayStarted = resolve
  })
  const controller = createDisplayCaptureSession({
    ownerWindow,
    mediaDevices: {
      async getDisplayMedia(constraints) {
        captureCalls.push(constraints)
        if (captureError) {
          throw captureError
        }
        queueMicrotask(() => {
          if (ackMode === 'none') {
            return
          }
          if (ackMode === 'wrong-origin') {
            ownerWindow.emit('message', {
              origin: 'https://example.invalid',
              source: projectorWindow,
              data: { type: READY_MESSAGE, version: READY_VERSION },
            })
            return
          }
          if (ackMode === 'wrong-source') {
            ownerWindow.emit('message', {
              origin: ownerWindow.location.origin,
              source: {},
              data: { type: READY_MESSAGE, version: READY_VERSION },
            })
            return
          }
          if (ackMode === 'invalid-shape') {
            ownerWindow.emit('message', {
              origin: ownerWindow.location.origin,
              source: projectorWindow,
              data: {
                type: READY_MESSAGE,
                version: READY_VERSION,
                untrusted: true,
              },
            })
            return
          }
          ownerWindow.emit('message', {
            origin: ownerWindow.location.origin,
            source: projectorWindow,
            data: { type: READY_MESSAGE, version: READY_VERSION },
          })
          if (ackMode === 'multiple') {
            ownerWindow.emit('message', {
              origin: ownerWindow.location.origin,
              source: projectorWindow,
              data: { type: READY_MESSAGE, version: READY_VERSION },
            })
          }
        })
        return stream
      },
    },
    openWindow: () => {
      openCount += 1
      return projectorWindow
    },
    onState: (value) => transitions.push(value),
    projectorReadyTimeoutMs: 250,
    setIntervalFn(callback) {
      closePoll = callback
      return 1
    },
    clearIntervalFn() {
      closePoll = null
    },
  })

  return {
    controller,
    ownerWindow,
    projectorWindow,
    video,
    stream,
    transitions,
    captureCalls,
    get openCount() {
      return openCount
    },
    playStarted,
    pollProjectorClosed() {
      closePoll?.()
    },
  }
}

test('capture session streams one video-only browser surface and cleans exactly once', async () => {
  const harness = makeHarness()
  const result = await harness.controller.start()

  assert.deepEqual(result, { ok: true, state: 'streaming', result_class: 'streaming' })
  assert.deepEqual(harness.captureCalls, [{ video: true, audio: false }])
  assert.equal(harness.video.srcObject, harness.stream)
  assert.equal(harness.video.playCount, 1)
  assert.deepEqual(
    harness.transitions.map((entry) => entry.state),
    ['idle', 'permission_requested', 'source_selected', 'projector_waiting', 'streaming']
  )

  assert.deepEqual(harness.controller.stop(), {
    ok: true,
    state: 'idle',
    result_class: 'operator_stopped',
  })
  assert.equal(harness.stream.videoTracks[0].stopCount, 1)
  assert.equal(harness.projectorWindow.closeCount, 1)
  assert.equal(harness.video.srcObject, null)
  assert.equal(harness.video.dataset.streaming, undefined)
  assert.equal(harness.ownerWindow.count('message'), 0)
  harness.controller.stop()
  assert.equal(harness.stream.videoTracks[0].stopCount, 1)
  assert.equal(harness.projectorWindow.closeCount, 1)
})

test('capture session requires active user activation before opening or capture', async () => {
  const harness = makeHarness({ userActivation: false })
  const result = await harness.controller.start()

  assert.deepEqual(result, {
    ok: false,
    state: 'idle',
    result_class: 'user_activation_required',
  })
  assert.equal(harness.openCount, 0)
  assert.equal(harness.captureCalls.length, 0)
  assert.equal(harness.projectorWindow.closeCount, 0)
  assert.equal(harness.ownerWindow.count('message'), 0)
})

test('capture session fails closed for denial, cancellation, no-track, and wrong surface', async (t) => {
  const cases = [
    {
      name: 'denial',
      options: { captureError: Object.assign(new Error('denied'), { name: 'NotAllowedError' }) },
      result: 'permission_denied',
    },
    {
      name: 'cancel',
      options: { captureError: Object.assign(new Error('cancel'), { name: 'AbortError' }) },
      result: 'selection_cancelled',
    },
    {
      name: 'no-track',
      options: { stream: makeStream({ videoCount: 0 }) },
      result: 'video_track_missing',
    },
    {
      name: 'wrong-surface',
      options: { stream: makeStream({ displaySurface: 'monitor' }) },
      result: 'display_surface_not_allowed',
    },
    {
      name: 'audio-track',
      options: { stream: makeStream({ audioCount: 1 }) },
      result: 'audio_track_not_allowed',
    },
  ]

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const harness = makeHarness(entry.options)
      const result = await harness.controller.start()
      assert.equal(result.ok, false)
      assert.equal(result.result_class, entry.result)
      assert.equal(result.state, 'idle')
      assert.equal(harness.projectorWindow.closeCount, 1)
      assert.equal(harness.ownerWindow.count('message'), 0)
      if (!entry.options.captureError) {
        for (const track of harness.stream.getTracks()) {
          assert.equal(track.stopCount, 1)
        }
      }
    })
  }
})

test('capture session deduplicates one active owner session', async () => {
  let resolveCapture
  const harness = makeHarness()
  harness.controller.stop()
  const ownerWindow = harness.ownerWindow
  const projectorWindow = harness.projectorWindow
  const controller = createDisplayCaptureSession({
    ownerWindow,
    mediaDevices: {
      getDisplayMedia() {
        return new Promise((resolve) => {
          resolveCapture = resolve
        })
      },
    },
    openWindow: () => projectorWindow,
    userActivationActive: () => true,
  })
  const first = controller.start()
  assert.deepEqual(await controller.start(), {
    ok: false,
    state: 'permission_requested',
    result_class: 'session_already_active',
  })
  controller.stop()
  resolveCapture(makeStream())
  await first
  assert.equal(projectorWindow.closeCount, 1)
})

test('capture session rejects missing, independently spoofed, malformed, and multiple projector acknowledgements', async (t) => {
  for (const entry of [
    ['missing', 'none', 'projector_ack_missing'],
    ['wrong origin', 'wrong-origin', 'projector_owner_mismatch'],
    ['wrong source', 'wrong-source', 'projector_owner_mismatch'],
    ['invalid exact shape', 'invalid-shape', 'projector_ack_invalid'],
    ['multiple', 'multiple', 'projector_owner_multiple'],
  ]) {
    await t.test(entry[0], async () => {
      const harness = makeHarness({ ackMode: entry[1] })
      const result = await harness.controller.start()
      assert.equal(result.ok, false)
      assert.equal(result.result_class, entry[2])
      assert.equal(harness.stream.videoTracks[0].stopCount, 1)
      assert.equal(harness.projectorWindow.closeCount, 1)
    })
  }
})

test('capture session stopped during pending playback never publishes a late streaming state', async () => {
  let resolvePlay
  const playPromise = new Promise((resolve) => {
    resolvePlay = resolve
  })
  const harness = makeHarness({ playPromise })
  const startResult = harness.controller.start()
  await harness.playStarted

  assert.equal(harness.video.playCount, 1)
  assert.equal(harness.video.srcObject, harness.stream)
  assert.deepEqual(harness.controller.stop(), {
    ok: true,
    state: 'idle',
    result_class: 'operator_stopped',
  })
  assert.equal(harness.video.srcObject, null)
  assert.equal(harness.stream.videoTracks[0].stopCount, 1)
  assert.equal(harness.projectorWindow.closeCount, 1)

  resolvePlay()
  assert.deepEqual(await startResult, {
    ok: false,
    state: 'idle',
    result_class: 'operator_stopped',
  })
  assert.equal(
    harness.transitions.filter((entry) => entry.state === 'streaming').length,
    0
  )
  assert.equal(harness.stream.videoTracks[0].stopCount, 1)
  assert.equal(harness.projectorWindow.closeCount, 1)
  assert.equal(harness.ownerWindow.count('message'), 0)
})

test('capture session rejects an unowned projector opener', async () => {
  const harness = makeHarness({ openerMatches: false })
  const result = await harness.controller.start()
  assert.deepEqual(result, {
    ok: false,
    state: 'idle',
    result_class: 'projector_opener_mismatch',
  })
  assert.equal(harness.stream.videoTracks[0].stopCount, 1)
  assert.equal(harness.projectorWindow.closeCount, 1)
})

test('capture session closes on ended track and owner unload without late ownership', async (t) => {
  await t.test('track ended', async () => {
    const harness = makeHarness()
    await harness.controller.start()
    harness.stream.videoTracks[0].emit('ended')
    assert.deepEqual(harness.controller.getState(), {
      state: 'idle',
      result_class: 'capture_ended',
    })
    assert.equal(harness.stream.videoTracks[0].stopCount, 1)
    assert.equal(harness.projectorWindow.closeCount, 1)
  })

  await t.test('owner unload', async () => {
    const harness = makeHarness()
    await harness.controller.start()
    harness.ownerWindow.emit('pagehide')
    assert.deepEqual(harness.controller.getState(), {
      state: 'idle',
      result_class: 'owner_unloaded',
    })
    assert.equal(harness.stream.videoTracks[0].stopCount, 1)
    assert.equal(harness.projectorWindow.closeCount, 1)
  })

  await t.test('projector close', async () => {
    const harness = makeHarness()
    await harness.controller.start()
    harness.projectorWindow.closed = true
    harness.pollProjectorClosed()
    assert.deepEqual(harness.controller.getState(), {
      state: 'idle',
      result_class: 'projector_closed',
    })
    assert.equal(harness.stream.videoTracks[0].stopCount, 1)
    assert.equal(harness.ownerWindow.count('message'), 0)
  })
})

test('capture implementation has no recording, network, storage, or raw source identity surface', () => {
  const files = [
    'tools/public/displayCaptureSession.js',
    'tools/public/projector.js',
  ]
  const source = files
    .map((file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8'))
    .join('\n')

  assert.doesNotMatch(source, /MediaRecorder/)
  assert.doesNotMatch(source, /\bfetch\s*\(/)
  assert.doesNotMatch(source, /WebSocket/)
  assert.doesNotMatch(source, /localStorage.*capture|sessionStorage.*capture/i)
  assert.doesNotMatch(source, /track\.label|deviceId|groupId|getCapabilities/)
  assert.doesNotMatch(source, /console\.(?:log|info|warn|error)/)
})
