(() => {
  'use strict'

  const state = document.getElementById('projector-state')
  const setState = (value) => {
    state.textContent = value
  }

  const hasVerifiedOpener = () => {
    if (!window.opener || window.opener.closed || !document.referrer) {
      return false
    }
    try {
      return (
        new URL(document.referrer).origin === window.location.origin &&
        window.opener.location.origin === window.location.origin
      )
    } catch {
      return false
    }
  }

  if (!hasVerifiedOpener()) {
    setState('Unavailable')
    return
  }

  window.opener.postMessage(
    {
      type: 'display_projection_projector_ready',
      version: 1,
    },
    window.location.origin
  )
  setState('Source selected in operator window')
})()
