const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const {
  READY_MESSAGE,
  READY_VERSION,
  CAPTURE_SOURCE_ROLE,
  CAPTURE_SOURCE_VERSION,
  CAPTURE_SOURCE_READY_MESSAGE,
  CAPTURE_SOURCE_READY_VERSION,
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

const canonicalCaptureHandle = () => ({
  origin: 'http://127.0.0.1:3000',
  handle: JSON.stringify({
    role: CAPTURE_SOURCE_ROLE,
    version: CAPTURE_SOURCE_VERSION,
    ref: '00112233-4455-4677-8899-aabbccddeeff',
  }),
})

const canonicalCaptureRef = '00112233-4455-4677-8899-aabbccddeeff'
const alternateCaptureRef = '10112233-4455-4677-8899-aabbccddeeff'

const makeTrack = (displaySurface = 'browser', captureHandle = canonicalCaptureHandle()) => {
  const target = new FakeEventTarget()
  return {
    ...target,
    listeners: target.listeners,
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    emit: target.emit.bind(target),
    stopCount: 0,
    readyState: 'live',
    getSettings: () => ({ displaySurface }),
    getCaptureHandle: () => captureHandle,
    stop() {
      this.stopCount += 1
    },
  }
}

const makeStream = ({
  displaySurface = 'browser',
  videoCount = 1,
  audioCount = 0,
  captureHandle = canonicalCaptureHandle(),
  hasCaptureHandleApi = true,
} = {}) => {
  const videoTracks = Array.from({ length: videoCount }, () => {
    const track = makeTrack(displaySurface, captureHandle)
    if (!hasCaptureHandleApi) delete track.getCaptureHandle
    return track
  })
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
  stageSource = {
    url: 'http://127.0.0.1:3000/projection-visual?mode=stage-output&hud=0&captureOwnerOrigin=http%3A%2F%2F127.0.0.1%3A9001',
    origin: 'http://127.0.0.1:3000',
  },
  now = () => 1000,
  stageWindowBlocked = false,
  projectorWindowBlocked = false,
  stageReadyMode = 'valid',
  stageReadyRef = canonicalCaptureRef,
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
  const stageWindow = {
    closed: false,
    closeCount: 0,
    close() {
      this.closed = true
      this.closeCount += 1
    },
  }
  const sendStageReady = (ref = stageReadyRef) => {
    ownerWindow.emit('message', {
      origin: stageSource.origin,
      source: stageWindow,
      data: {
        type: CAPTURE_SOURCE_READY_MESSAGE,
        version: CAPTURE_SOURCE_READY_VERSION,
        ref,
      },
    })
  }
  const transitions = []
  const captureCalls = []
  const stageOpenCalls = []
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
      return projectorWindowBlocked ? null : projectorWindow
    },
    openStageWindow: (url) => {
      stageOpenCalls.push(url)
      if (stageWindowBlocked) return null
      queueMicrotask(() => {
        if (stageReadyMode === 'none' || stageReadyMode === 'deferred') return
        const origin =
          stageReadyMode === 'wrong-origin'
            ? 'https://example.invalid'
            : stageSource.origin
        const source = stageReadyMode === 'wrong-source' ? {} : stageWindow
        const data =
          stageReadyMode === 'invalid-shape'
            ? {
                type: CAPTURE_SOURCE_READY_MESSAGE,
                version: CAPTURE_SOURCE_READY_VERSION,
                ref: stageReadyRef,
                private: true,
              }
            : {
                type: CAPTURE_SOURCE_READY_MESSAGE,
                version: CAPTURE_SOURCE_READY_VERSION,
                ref: stageReadyRef,
              }
        ownerWindow.emit('message', { origin, source, data })
        if (stageReadyMode === 'multiple-different') {
          ownerWindow.emit('message', {
            origin: stageSource.origin,
            source: stageWindow,
            data: {
              type: CAPTURE_SOURCE_READY_MESSAGE,
              version: CAPTURE_SOURCE_READY_VERSION,
              ref: alternateCaptureRef,
            },
          })
        }
        if (stageReadyMode === 'multiple-same') {
          ownerWindow.emit('message', { origin, source, data })
        }
      })
      return stageWindow
    },
    getStageSource: () => stageSource,
    now,
    onState: (value) => transitions.push(value),
    projectorReadyTimeoutMs: 250,
    stageReadyTimeoutMs: 250,
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
    stageWindow,
    video,
    stream,
    transitions,
    captureCalls,
    stageOpenCalls,
    sendStageReady,
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
  assert.equal(harness.stageWindow.closeCount, 1)
  assert.equal(harness.stageOpenCalls.length, 1)
  assert.match(harness.stageOpenCalls[0], /mode=stage-output/)
  assert.match(harness.stageOpenCalls[0], /captureOwnerOrigin=/)
})

test('capture session binds the selected handle to the exact stage popup owner', async (t) => {
  await t.test('missing owner announcement fails closed', async () => {
    const harness = makeHarness({ stageReadyMode: 'none' })
    const result = await harness.controller.start()
    assert.equal(result.result_class, 'source_owner_unconfirmed')
    assert.equal(harness.stream.videoTracks[0].stopCount, 1)
  })

  for (const [label, stageReadyMode, resultClass] of [
    ['wrong origin', 'wrong-origin', 'source_owner_mismatch'],
    ['wrong source', 'wrong-source', 'source_owner_mismatch'],
    ['extra field', 'invalid-shape', 'source_owner_invalid'],
    ['conflicting refs', 'multiple-different', 'source_owner_changed'],
  ]) {
    await t.test(label, async () => {
      const harness = makeHarness({ stageReadyMode })
      const result = await harness.controller.start()
      assert.equal(result.result_class, resultClass)
      assert.equal(harness.stream.videoTracks[0].stopCount, 1)
      assert.doesNotMatch(JSON.stringify(harness.transitions), /00112233|10112233/)
    })
  }

  await t.test('another same-origin canonical stage ref is not accepted', async () => {
    const harness = makeHarness({ stageReadyRef: alternateCaptureRef })
    const result = await harness.controller.start()
    assert.equal(result.result_class, 'source_identity_mismatch')
    assert.equal(harness.stream.videoTracks[0].stopCount, 1)
    assert.doesNotMatch(JSON.stringify(harness.transitions), /00112233|10112233/)
  })

  await t.test('same-ref re-announcement is idempotent', async () => {
    const harness = makeHarness({ stageReadyMode: 'multiple-same' })
    assert.equal((await harness.controller.start()).ok, true)
    harness.ownerWindow.emit('message', {
      origin: 'http://127.0.0.1:3000',
      source: harness.stageWindow,
      data: {
        type: CAPTURE_SOURCE_READY_MESSAGE,
        version: CAPTURE_SOURCE_READY_VERSION,
        ref: canonicalCaptureRef,
      },
    })
    assert.equal(harness.controller.getState().state, 'streaming')
    harness.controller.stop()
  })

  await t.test('different post-lock owner ref terminates the stream', async () => {
    const harness = makeHarness()
    assert.equal((await harness.controller.start()).ok, true)
    harness.ownerWindow.emit('message', {
      origin: 'http://127.0.0.1:3000',
      source: harness.stageWindow,
      data: {
        type: CAPTURE_SOURCE_READY_MESSAGE,
        version: CAPTURE_SOURCE_READY_VERSION,
        ref: alternateCaptureRef,
      },
    })
    assert.deepEqual(harness.controller.getState(), {
      state: 'idle',
      result_class: 'source_identity_changed',
    })
    assert.equal(harness.stream.videoTracks[0].stopCount, 1)
  })

  await t.test('track ending while owner-ready is delayed cannot publish a late selected state', async () => {
    const harness = makeHarness({ stageReadyMode: 'deferred' })
    const startResult = harness.controller.start()
    await new Promise((resolve) => setImmediate(resolve))
    const track = harness.stream.videoTracks[0]
    track.readyState = 'ended'
    track.emit('ended')
    harness.sendStageReady()

    assert.deepEqual(await startResult, {
      ok: false,
      state: 'idle',
      result_class: 'capture_ended',
    })
    assert.equal(track.stopCount, 1)
    assert.equal(harness.stageWindow.closeCount, 1)
    assert.equal(harness.projectorWindow.closeCount, 1)
    assert.equal(
      harness.transitions.some((entry) =>
        ['source_selected', 'streaming'].includes(entry.state)
      ),
      false
    )
  })

  await t.test('an initially ended selected track is a failed start with exact cleanup', async () => {
    const stream = makeStream()
    stream.videoTracks[0].readyState = 'ended'
    const harness = makeHarness({ stream })

    assert.deepEqual(await harness.controller.start(), {
      ok: false,
      state: 'idle',
      result_class: 'capture_ended',
    })
    assert.equal(stream.videoTracks[0].stopCount, 1)
    assert.equal(harness.stageWindow.closeCount, 1)
    assert.equal(harness.projectorWindow.closeCount, 1)
    assert.equal(
      harness.transitions.some((entry) =>
        ['source_selected', 'streaming'].includes(entry.state)
      ),
      false
    )
  })

  await t.test('readyState ending without an event during owner wait is a failed start', async () => {
    const harness = makeHarness({ stageReadyMode: 'deferred' })
    const startResult = harness.controller.start()
    await new Promise((resolve) => setImmediate(resolve))
    harness.stream.videoTracks[0].readyState = 'ended'
    harness.sendStageReady()

    assert.deepEqual(await startResult, {
      ok: false,
      state: 'idle',
      result_class: 'capture_ended',
    })
    assert.equal(harness.stream.videoTracks[0].stopCount, 1)
    assert.equal(harness.stageWindow.closeCount, 1)
    assert.equal(harness.projectorWindow.closeCount, 1)
    assert.equal(
      harness.transitions.some((entry) =>
        ['source_selected', 'streaming'].includes(entry.state)
      ),
      false
    )
  })
})

test('capture session rejects missing, malformed, wrong-origin, and changed source identity', async (t) => {
  for (const entry of [
    ['missing API', makeStream({ hasCaptureHandleApi: false }), 'source_identity_unavailable'],
    [
      'wrong origin',
      makeStream({
        captureHandle: { ...canonicalCaptureHandle(), origin: 'http://localhost:3000' },
      }),
      'source_identity_unavailable',
    ],
    [
      'extra field',
      makeStream({
        captureHandle: {
          ...canonicalCaptureHandle(),
          extra: 'untrusted',
        },
      }),
      'source_identity_unavailable',
    ],
    [
      'malformed JSON',
      makeStream({
        captureHandle: { origin: 'http://127.0.0.1:3000', handle: '{' },
      }),
      'source_identity_unavailable',
    ],
    [
      'wrong role',
      makeStream({
        captureHandle: {
          origin: 'http://127.0.0.1:3000',
          handle: JSON.stringify({
            role: 'untrusted-role',
            version: CAPTURE_SOURCE_VERSION,
            ref: '00112233-4455-4677-8899-aabbccddeeff',
          }),
        },
      }),
      'source_identity_unavailable',
    ],
    [
      'invalid ref',
      makeStream({
        captureHandle: {
          origin: 'http://127.0.0.1:3000',
          handle: JSON.stringify({
            role: CAPTURE_SOURCE_ROLE,
            version: CAPTURE_SOURCE_VERSION,
            ref: 'private/raw/ref',
          }),
        },
      }),
      'source_identity_unavailable',
    ],
  ]) {
    await t.test(entry[0], async () => {
      const harness = makeHarness({ stream: entry[1] })
      const result = await harness.controller.start()
      assert.equal(result.result_class, entry[2])
      assert.equal(harness.stream.videoTracks[0].stopCount, 1)
    })
  }

  await t.test('changed handle terminates without publishing the ref', async () => {
    let handle = canonicalCaptureHandle()
    const track = makeTrack('browser')
    track.getCaptureHandle = () => handle
    const stream = {
      videoTracks: [track],
      audioTracks: [],
      getVideoTracks: () => [track],
      getAudioTracks: () => [],
      getTracks: () => [track],
    }
    const harness = makeHarness({ stream })
    assert.equal((await harness.controller.start()).ok, true)
    handle = {
      ...canonicalCaptureHandle(),
      handle: canonicalCaptureHandle().handle.replace(
        '00112233-4455-4677-8899-aabbccddeeff',
        '10112233-4455-4677-8899-aabbccddeeff'
      ),
    }
    track.emit('capturehandlechange')
    assert.deepEqual(harness.controller.getState(), {
      state: 'idle',
      result_class: 'source_identity_changed',
    })
    assert.doesNotMatch(JSON.stringify(harness.transitions), /00112233|10112233/)
  })
})

test('capture session fails closed before capture for an invalid or absent stage source', async () => {
  for (const stageSource of [
    null,
    { url: 'https://example.com', origin: 'https://example.com' },
    {
      url: 'http://127.0.0.1:3000/projection-visual?mode=stage-output&hud=0&captureOwnerOrigin=http%3A%2F%2Flocalhost%3A9001',
      origin: 'http://127.0.0.1:3000',
    },
    {
      url: 'http://user@127.0.0.1:3000/projection-visual?mode=stage-output&hud=0&captureOwnerOrigin=http%3A%2F%2F127.0.0.1%3A9001',
      origin: 'http://127.0.0.1:3000',
    },
  ]) {
    const harness = makeHarness({ stageSource })
    const result = await harness.controller.start()
    assert.equal(result.result_class, 'stage_source_unavailable')
    assert.equal(harness.captureCalls.length, 0)
  }
})

test('capture session closes only the stage window it opened when either popup is blocked', async () => {
  const stageBlocked = makeHarness({ stageWindowBlocked: true })
  assert.equal((await stageBlocked.controller.start()).result_class, 'stage_window_blocked')
  assert.equal(stageBlocked.captureCalls.length, 0)
  assert.equal(stageBlocked.projectorWindow.closeCount, 0)

  const projectorBlocked = makeHarness({ projectorWindowBlocked: true })
  assert.equal(
    (await projectorBlocked.controller.start()).result_class,
    'projector_window_blocked'
  )
  assert.equal(projectorBlocked.captureCalls.length, 0)
  assert.equal(projectorBlocked.stageWindow.closeCount, 1)
})

test('capture session rejects a source identity selected after the bounded window', async () => {
  let current = 0
  const harness = makeHarness({ now: () => (current += 130000) })
  const result = await harness.controller.start()
  assert.equal(result.result_class, 'source_identity_stale')
  assert.equal(harness.stream.videoTracks[0].stopCount, 1)
})

test('capture session rejects a negative source age without publishing timing data', async () => {
  let call = 0
  const harness = makeHarness({ now: () => (call++ === 0 ? 2000 : 1000) })
  const result = await harness.controller.start()
  assert.equal(result.result_class, 'source_identity_stale')
  assert.doesNotMatch(JSON.stringify(harness.transitions), /1000|2000/)
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
    openStageWindow: () => harness.stageWindow,
    getStageSource: () => ({
      url: 'http://127.0.0.1:3000/projection-visual?mode=stage-output&hud=0&captureOwnerOrigin=http%3A%2F%2F127.0.0.1%3A9001',
      origin: 'http://127.0.0.1:3000',
    }),
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
