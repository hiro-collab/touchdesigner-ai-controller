(function exposeDisplayCaptureSession(root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) {
    module.exports = api
  } else {
    root.DisplayCaptureSession = api
  }
})(typeof globalThis === 'object' ? globalThis : this, function buildApi() {
  'use strict'

  const READY_MESSAGE = 'display_projection_projector_ready'
  const READY_VERSION = 1
  const ALLOWED_DISPLAY_SURFACES = new Set(['browser', 'window'])
  const READY_KEYS = ['type', 'version']
  const CAPTURE_SOURCE_ROLE = 'projection-visual-stage-output'
  const CAPTURE_SOURCE_VERSION = 1
  const CAPTURE_SOURCE_READY_MESSAGE = 'projection_stage_capture_source_ready'
  const CAPTURE_SOURCE_READY_VERSION = 1
  const CAPTURE_SOURCE_HANDLE_MAX_AGE_MS = 120000
  const CAPTURE_HANDLE_KEYS = ['handle', 'origin']
  const CAPTURE_SOURCE_KEYS = ['ref', 'role', 'version']
  const CAPTURE_SOURCE_READY_KEYS = ['ref', 'type', 'version']
  const STAGE_SOURCE_KEYS = ['origin', 'url']
  const UUID_V4_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

  const fixedResult = (ok, state, resultClass) => ({
    ok,
    state,
    result_class: resultClass,
  })

  const hasExactReadyShape = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return false
    }
    const keys = Object.keys(value).sort()
    return (
      keys.length === READY_KEYS.length &&
      keys.every((key, index) => key === READY_KEYS[index]) &&
      value.type === READY_MESSAGE &&
      value.version === READY_VERSION
    )
  }

  const hasExactKeys = (value, expectedKeys) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const keys = Object.keys(value).sort()
    return (
      keys.length === expectedKeys.length &&
      keys.every((key, index) => key === expectedKeys[index])
    )
  }

  const readCaptureSourceReadyRef = (value) => {
    if (!hasExactKeys(value, CAPTURE_SOURCE_READY_KEYS)) return null
    if (value.type !== CAPTURE_SOURCE_READY_MESSAGE) return null
    if (value.version !== CAPTURE_SOURCE_READY_VERSION) return null
    if (typeof value.ref !== 'string' || !UUID_V4_PATTERN.test(value.ref)) {
      return null
    }
    return value.ref
  }

  const resolveStageSource = (value, ownerOrigin) => {
    if (!hasExactKeys(value, STAGE_SOURCE_KEYS)) return null
    try {
      const ownerUrl = new URL(ownerOrigin)
      if (!LOOPBACK_HOSTS.has(ownerUrl.hostname)) return null
      const url = new URL(value.url)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
      if (!LOOPBACK_HOSTS.has(url.hostname)) return null
      if (url.username || url.password) return null
      if (url.origin !== value.origin) return null
      if (url.searchParams.get('mode') !== 'stage-output') return null
      if (url.searchParams.get('hud') !== '0') return null
      const captureOwnerOrigin = new URL(
        url.searchParams.get('captureOwnerOrigin') || ''
      )
      if (captureOwnerOrigin.protocol !== 'http:' && captureOwnerOrigin.protocol !== 'https:') {
        return null
      }
      if (!LOOPBACK_HOSTS.has(captureOwnerOrigin.hostname)) return null
      if (captureOwnerOrigin.username || captureOwnerOrigin.password) return null
      if (captureOwnerOrigin.origin !== ownerOrigin) return null
      if (captureOwnerOrigin.pathname !== '/') return null
      if (captureOwnerOrigin.search || captureOwnerOrigin.hash) return null
      return { url: url.href, origin: url.origin }
    } catch {
      return null
    }
  }

  const readCaptureSourceIdentity = (track, expectedOrigin) => {
    if (!track || typeof track.getCaptureHandle !== 'function') return null
    let captureHandle
    try {
      captureHandle = track.getCaptureHandle()
    } catch {
      return null
    }
    if (!hasExactKeys(captureHandle, CAPTURE_HANDLE_KEYS)) return null
    if (captureHandle.origin !== expectedOrigin) return null
    if (
      typeof captureHandle.handle !== 'string' ||
      captureHandle.handle.length === 0 ||
      captureHandle.handle.length > 128
    ) {
      return null
    }
    try {
      const value = JSON.parse(captureHandle.handle)
      if (!hasExactKeys(value, CAPTURE_SOURCE_KEYS)) return null
      if (value.role !== CAPTURE_SOURCE_ROLE) return null
      if (value.version !== CAPTURE_SOURCE_VERSION) return null
      if (typeof value.ref !== 'string' || !UUID_V4_PATTERN.test(value.ref)) {
        return null
      }
      return { origin: captureHandle.origin, ref: value.ref }
    } catch {
      return null
    }
  }

  const createDisplayCaptureSession = (options = {}) => {
    const ownerWindow = options.ownerWindow || window
    const mediaDevices =
      options.mediaDevices || ownerWindow.navigator?.mediaDevices
    const openWindow =
      options.openWindow ||
      ((url) =>
        ownerWindow.open(
          url,
          '_blank',
          'popup=yes,noopener=no,width=1280,height=720'
        ))
    const openStageWindow =
      options.openStageWindow ||
      ((url) =>
        ownerWindow.open(
          url,
          '_blank',
          'popup=yes,noopener=no,width=1280,height=720'
        ))
    const getStageSource =
      typeof options.getStageSource === 'function'
        ? options.getStageSource
        : () => null
    const onState =
      typeof options.onState === 'function' ? options.onState : () => {}
    const setTimeoutFn = options.setTimeoutFn || ownerWindow.setTimeout.bind(ownerWindow)
    const clearTimeoutFn =
      options.clearTimeoutFn || ownerWindow.clearTimeout.bind(ownerWindow)
    const setIntervalFn =
      options.setIntervalFn || ownerWindow.setInterval.bind(ownerWindow)
    const clearIntervalFn =
      options.clearIntervalFn || ownerWindow.clearInterval.bind(ownerWindow)
    const projectorReadyTimeoutMs = Math.min(
      10000,
      Math.max(250, Number(options.projectorReadyTimeoutMs) || 5000)
    )
    const stageReadyTimeoutMs = Math.min(
      10000,
      Math.max(250, Number(options.stageReadyTimeoutMs) || 5000)
    )
    const userActivationActive =
      options.userActivationActive ||
      (() => ownerWindow.navigator?.userActivation?.isActive === true)
    const now = typeof options.now === 'function' ? options.now : Date.now
    const expectedOrigin = ownerWindow.location?.origin

    let state = 'idle'
    let resultClass = 'not_started'
    let activeSession = null

    const publish = (nextState, nextResultClass) => {
      state = nextState
      resultClass = nextResultClass
      onState({ state, result_class: resultClass })
    }

    const stopTrackOnce = (session, track) => {
      if (!track || session.stoppedTracks.has(track)) {
        return
      }
      session.stoppedTracks.add(track)
      try {
        track.stop()
      } catch {
        // A capture track can already be ended by the browser.
      }
    }

    const stopAllTracks = (session, stream) => {
      const tracks =
        stream && typeof stream.getTracks === 'function' ? stream.getTracks() : []
      for (const track of tracks) {
        stopTrackOnce(session, track)
      }
    }

    const clearProjectorVideo = (session) => {
      try {
        const video = session.projectorWindow?.document?.getElementById(
          'projection-stream'
        )
        if (video && (!session.stream || video.srcObject === session.stream)) {
          video.srcObject = null
          delete video.dataset?.streaming
        }
      } catch {
        // A closed or navigated projector is no longer an owned sink.
      }
    }

    const cleanup = (session) => {
      if (!session || session.cleaned) {
        return
      }
      session.cleaned = true
      session.readyReject?.(new Error('session_closed'))
      if (session.readyTimer !== null) {
        clearTimeoutFn(session.readyTimer)
        session.readyTimer = null
      }
      if (session.closePoll !== null) {
        clearIntervalFn(session.closePoll)
        session.closePoll = null
      }
      ownerWindow.removeEventListener('message', session.onMessage)
      ownerWindow.removeEventListener('pagehide', session.onOwnerUnload)
      ownerWindow.removeEventListener('beforeunload', session.onOwnerUnload)
      if (session.videoTrack && session.onTrackEnded) {
        session.videoTrack.removeEventListener?.('ended', session.onTrackEnded)
      }
      session.stageReadyReject?.(new Error('source_owner_unconfirmed'))
      if (session.stageReadyTimer !== null) {
        clearTimeoutFn(session.stageReadyTimer)
        session.stageReadyTimer = null
      }
      if (session.videoTrack && session.onCaptureHandleChange) {
        session.videoTrack.removeEventListener?.(
          'capturehandlechange',
          session.onCaptureHandleChange
        )
      }
      clearProjectorVideo(session)
      stopAllTracks(session, session.stream)
      if (
        session.projectorWindow &&
        !session.windowClosed &&
        !session.projectorWindow.closed
      ) {
        session.windowClosed = true
        try {
          session.projectorWindow.close()
        } catch {
          // The browser may have already reclaimed the owned popup.
        }
      }
      if (
        session.stageWindow &&
        !session.stageWindowClosed &&
        !session.stageWindow.closed
      ) {
        session.stageWindowClosed = true
        try {
          session.stageWindow.close()
        } catch {
          // The browser may have already reclaimed the owned stage window.
        }
      }
      session.stream = null
      session.videoTrack = null
      session.projectorWindow = null
      session.stageWindow = null
      session.captureSourceIdentity = null
      session.expectedCaptureSourceRef = null
      if (activeSession === session) {
        activeSession = null
      }
    }

    const terminate = (session, terminalState, terminalClass) => {
      if (!session || session.terminal) {
        return fixedResult(false, state, resultClass)
      }
      session.terminal = true
      publish(terminalState, terminalClass)
      cleanup(session)
      publish('idle', terminalClass)
      return fixedResult(terminalState === 'ended', 'idle', terminalClass)
    }

    const fail = (session, reason) => terminate(session, 'error', reason)

    const makeSession = () => {
      const session = {
        cleaned: false,
        terminal: false,
        stream: null,
        videoTrack: null,
        projectorWindow: null,
        stageWindow: null,
        stageWindowClosed: false,
        stageOpenedAt: null,
        stageSource: null,
        captureSourceIdentity: null,
        expectedCaptureSourceRef: null,
        captureSourceIdentityLocked: false,
        windowClosed: false,
        stoppedTracks: new Set(),
        readySeen: false,
        readyTimer: null,
        closePoll: null,
        readyResolve: null,
        readyReject: null,
        stageReadyTimer: null,
        stageReadyResolve: null,
        stageReadyReject: null,
        onTrackEnded: null,
        onCaptureHandleChange: null,
        onMessage: null,
        onOwnerUnload: null,
      }

      session.onMessage = (event) => {
        if (event?.data?.type === CAPTURE_SOURCE_READY_MESSAGE && !session.cleaned) {
          if (
            event.origin !== session.stageSource?.origin ||
            event.source !== session.stageWindow
          ) {
            fail(session, 'source_owner_mismatch')
            return
          }
          const readyRef = readCaptureSourceReadyRef(event.data)
          if (!readyRef) {
            fail(session, 'source_owner_invalid')
            return
          }
          if (
            session.expectedCaptureSourceRef &&
            session.expectedCaptureSourceRef !== readyRef
          ) {
            if (session.captureSourceIdentityLocked) {
              terminate(session, 'ended', 'source_identity_changed')
            } else {
              fail(session, 'source_owner_changed')
            }
            return
          }
          if (!session.expectedCaptureSourceRef) {
            session.expectedCaptureSourceRef = readyRef
            if (session.stageReadyTimer !== null) {
              clearTimeoutFn(session.stageReadyTimer)
              session.stageReadyTimer = null
            }
            session.stageReadyResolve?.()
          }
          return
        }
        if (event?.data?.type !== READY_MESSAGE || session.cleaned) {
          return
        }
        if (
          event.origin !== expectedOrigin ||
          event.source !== session.projectorWindow
        ) {
          fail(session, 'projector_owner_mismatch')
          return
        }
        if (!hasExactReadyShape(event.data)) {
          fail(session, 'projector_ack_invalid')
          return
        }
        if (session.readySeen) {
          fail(session, 'projector_owner_multiple')
          return
        }
        session.readySeen = true
        session.readyResolve?.()
      }
      session.onOwnerUnload = () => {
        terminate(session, 'ended', 'owner_unloaded')
      }
      return session
    }

    const awaitProjectorReady = (session) =>
      new Promise((resolve, reject) => {
        session.readyResolve = resolve
        session.readyReject = reject
        if (session.readySeen) {
          resolve()
          return
        }
        session.readyTimer = setTimeoutFn(() => {
          session.readyTimer = null
          reject(new Error('projector_ack_missing'))
        }, projectorReadyTimeoutMs)
      })

    const awaitStageReady = (session) =>
      new Promise((resolve, reject) => {
        session.stageReadyResolve = resolve
        session.stageReadyReject = reject
        if (session.expectedCaptureSourceRef) {
          resolve()
          return
        }
        session.stageReadyTimer = setTimeoutFn(() => {
          session.stageReadyTimer = null
          reject(new Error('source_owner_unconfirmed'))
        }, stageReadyTimeoutMs)
      })

    const verifyProjectorSink = (session) => {
      const projectorWindow = session.projectorWindow
      if (!projectorWindow || projectorWindow.closed) {
        throw new Error('projector_closed')
      }
      if (projectorWindow.opener !== ownerWindow) {
        throw new Error('projector_opener_mismatch')
      }
      if (projectorWindow.location?.origin !== expectedOrigin) {
        throw new Error('projector_origin_mismatch')
      }
      const video = projectorWindow.document?.getElementById('projection-stream')
      if (!video) {
        throw new Error('projector_sink_missing')
      }
      return video
    }

    const start = async () => {
      if (activeSession || state !== 'idle') {
        return fixedResult(false, state, 'session_already_active')
      }
      if (!expectedOrigin || expectedOrigin === 'null') {
        return fixedResult(false, state, 'owner_origin_unavailable')
      }
      if (!userActivationActive()) {
        return fixedResult(false, state, 'user_activation_required')
      }
      if (!mediaDevices || typeof mediaDevices.getDisplayMedia !== 'function') {
        return fixedResult(false, state, 'display_capture_unavailable')
      }

      const stageSource = resolveStageSource(getStageSource(), expectedOrigin)
      if (!stageSource) {
        return fixedResult(false, state, 'stage_source_unavailable')
      }

      const session = makeSession()
      session.stageSource = stageSource
      activeSession = session
      ownerWindow.addEventListener('message', session.onMessage)
      ownerWindow.addEventListener('pagehide', session.onOwnerUnload)
      ownerWindow.addEventListener('beforeunload', session.onOwnerUnload)
      publish('permission_requested', 'permission_requested')

      try {
        session.stageWindow = openStageWindow(stageSource.url)
        session.stageOpenedAt = now()
        if (!session.stageWindow || session.stageWindow.closed) {
          return fail(session, 'stage_window_blocked')
        }
        const projectorUrl = new URL('/projector.html', ownerWindow.location.href)
        if (projectorUrl.origin !== expectedOrigin) {
          return fail(session, 'projector_origin_mismatch')
        }
        session.projectorWindow = openWindow(projectorUrl.href)
        if (!session.projectorWindow) {
          return fail(session, 'projector_window_blocked')
        }
        session.closePoll = setIntervalFn(() => {
          if (session.projectorWindow?.closed) {
            terminate(session, 'ended', 'projector_closed')
          }
        }, 250)

        let stream
        try {
          stream = await mediaDevices.getDisplayMedia({
            video: true,
            audio: false,
          })
        } catch (error) {
          const errorName = error?.name
          return fail(
            session,
            errorName === 'NotAllowedError'
              ? 'permission_denied'
              : errorName === 'AbortError'
                ? 'selection_cancelled'
                : 'capture_failed'
          )
        }

        if (activeSession !== session || session.cleaned) {
          stopAllTracks(session, stream)
          return fixedResult(false, 'idle', resultClass)
        }
        session.stream = stream
        const videoTracks = stream.getVideoTracks?.() || []
        const audioTracks = stream.getAudioTracks?.() || []
        if (videoTracks.length !== 1) {
          return fail(session, 'video_track_missing')
        }
        if (audioTracks.length !== 0) {
          return fail(session, 'audio_track_not_allowed')
        }
        session.videoTrack = videoTracks[0]
        session.onTrackEnded = () => {
          terminate(session, 'ended', 'capture_ended')
        }
        session.videoTrack.addEventListener?.('ended', session.onTrackEnded)
        if (session.videoTrack.readyState === 'ended') {
          terminate(session, 'ended', 'capture_ended')
          return fixedResult(false, 'idle', 'capture_ended')
        }
        const displaySurface = session.videoTrack.getSettings?.().displaySurface
        if (!ALLOWED_DISPLAY_SURFACES.has(displaySurface)) {
          return fail(session, 'display_surface_not_allowed')
        }
        if (
          !Number.isFinite(session.stageOpenedAt) ||
          now() - session.stageOpenedAt < 0 ||
          now() - session.stageOpenedAt > CAPTURE_SOURCE_HANDLE_MAX_AGE_MS
        ) {
          return fail(session, 'source_identity_stale')
        }
        try {
          await awaitStageReady(session)
        } catch (error) {
          if (session.cleaned) {
            return fixedResult(false, 'idle', resultClass)
          }
          return fail(session, error?.message || 'source_owner_unconfirmed')
        }
        if (activeSession !== session || session.cleaned) {
          return fixedResult(false, 'idle', resultClass)
        }
        if (session.videoTrack.readyState === 'ended') {
          terminate(session, 'ended', 'capture_ended')
          return fixedResult(false, 'idle', 'capture_ended')
        }
        session.captureSourceIdentity = readCaptureSourceIdentity(
          session.videoTrack,
          stageSource.origin
        )
        if (!session.captureSourceIdentity) {
          return fail(session, 'source_identity_unavailable')
        }
        if (
          !session.expectedCaptureSourceRef ||
          session.captureSourceIdentity.ref !== session.expectedCaptureSourceRef
        ) {
          return fail(session, 'source_identity_mismatch')
        }
        session.captureSourceIdentityLocked = true
        session.onCaptureHandleChange = () => {
          const current = readCaptureSourceIdentity(
            session.videoTrack,
            stageSource.origin
          )
          if (
            !current ||
            current.origin !== session.captureSourceIdentity?.origin ||
            current.ref !== session.captureSourceIdentity?.ref ||
            current.ref !== session.expectedCaptureSourceRef
          ) {
            terminate(session, 'ended', 'source_identity_changed')
          }
        }
        session.videoTrack.addEventListener?.(
          'capturehandlechange',
          session.onCaptureHandleChange
        )
        publish('source_selected', 'source_selected')

        publish('projector_waiting', 'projector_waiting')
        try {
          await awaitProjectorReady(session)
        } catch (error) {
          if (session.cleaned) {
            return fixedResult(false, 'idle', resultClass)
          }
          return fail(session, error?.message || 'projector_ack_missing')
        }
        if (activeSession !== session || session.cleaned) {
          return fixedResult(false, 'idle', resultClass)
        }

        let video
        try {
          video = verifyProjectorSink(session)
        } catch (error) {
          return fail(session, error?.message || 'projector_sink_invalid')
        }
        video.srcObject = stream
        if (video.dataset) {
          video.dataset.streaming = 'true'
        }
        try {
          await Promise.resolve(video.play?.())
        } catch {
          return fail(session, 'projector_playback_failed')
        }
        if (activeSession !== session || session.cleaned) {
          return fixedResult(false, 'idle', resultClass)
        }
        publish('streaming', 'streaming')
        return fixedResult(true, 'streaming', 'streaming')
      } catch {
        return fail(session, 'capture_session_error')
      }
    }

    const stop = () => {
      if (!activeSession) {
        return fixedResult(true, 'idle', 'already_idle')
      }
      return terminate(activeSession, 'ended', 'operator_stopped')
    }

    const getState = () => ({ state, result_class: resultClass })

    publish('idle', 'not_started')
    return { start, stop, getState }
  }

  return {
    CAPTURE_SOURCE_ROLE,
    CAPTURE_SOURCE_VERSION,
    CAPTURE_SOURCE_READY_MESSAGE,
    CAPTURE_SOURCE_READY_VERSION,
    READY_MESSAGE,
    READY_VERSION,
    createDisplayCaptureSession,
  }
})
