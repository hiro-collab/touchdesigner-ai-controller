const serviceGrid = document.getElementById('service-grid')
const mediapipeStatus = document.getElementById('mediapipe-status')
const tdStatus = document.getElementById('td-status')
const eventLog = document.getElementById('event-log')
const magicBanner = document.getElementById('magic-banner')
const aituberFrame = document.getElementById('aituber-frame')
const fontSizeInput = document.getElementById('font-size')
const accentColorInput = document.getElementById('accent-color')
const matrixToggle = document.getElementById('matrix-toggle')
const tdTestButton = document.getElementById('td-test')
const hudPill = document.getElementById('hud-pill')
const canvas = document.getElementById('matrix-canvas')
const context = canvas.getContext('2d')

const colorPresets = ['#4cc9ff', '#ff3fd2', '#f4ff5c', '#ffffff']
const storageKey = 'touchdesigner-ai-controller-settings'
const serviceLabels = {
  home_assistant_bridge: 'Home control bridge',
  environment_state_server: 'Environment state',
  mediapipe: 'MediaPipe camera',
  aituber_kit: 'AITuber Kit',
  touchdesigner_control_gui: 'Display runtime GUI',
  dify: 'Legacy Dify runtime',
  voicevox: 'VOICEVOX',
  thought_core_api: 'Thought Core API',
  thought_core_watcher: 'Thought Core watcher',
  vision_snapshot_processor: 'Vision snapshot',
}
const legacyServices = new Set(['dify'])
let state = {
  fontSize: 14,
  accent: colorPresets[0],
  hudVisible: true,
  matrixEnabled: false,
}

const loadState = () => {
  try {
    state = { ...state, ...JSON.parse(localStorage.getItem(storageKey) || '{}') }
  } catch {
    // Ignore corrupt local settings.
  }
}

const saveState = () => {
  localStorage.setItem(storageKey, JSON.stringify(state))
}

const applyState = () => {
  document.documentElement.style.setProperty('--font-size', `${state.fontSize}px`)
  document.documentElement.style.setProperty('--accent', state.accent)
  document.documentElement.style.setProperty(
    '--accent-soft',
    `${state.accent}29`
  )
  document.documentElement.style.setProperty(
    '--accent-mid',
    `${state.accent}61`
  )
  document.body.classList.toggle('hud-hidden', !state.hudVisible)
  document.body.classList.toggle('matrix-enabled', state.matrixEnabled)
  fontSizeInput.value = String(state.fontSize)
  accentColorInput.value = state.accent
  matrixToggle.checked = state.matrixEnabled
}

const setFontSize = (fontSize) => {
  state.fontSize = Math.min(22, Math.max(11, fontSize))
  applyState()
  saveState()
}

const setAccent = (accent) => {
  state.accent = accent
  applyState()
  saveState()
}

const toggleHud = () => {
  state.hudVisible = !state.hudVisible
  applyState()
  saveState()
}

const toggleMatrix = () => {
  state.matrixEnabled = !state.matrixEnabled
  applyState()
  saveState()
}

const escapeHtml = (value) =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')

const formatTime = (iso) => {
  if (!iso) {
    return '-'
  }
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) {
    return '-'
  }
  return date.toLocaleTimeString('ja-JP', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

const formatAge = (ageMs) => {
  if (typeof ageMs !== 'number') {
    return '-'
  }
  if (ageMs < 1000) {
    return `${Math.max(0, Math.round(ageMs))}ms`
  }
  return `${(ageMs / 1000).toFixed(1)}s`
}

const renderKv = (rows) =>
  rows
    .map(
      ([key, value]) => `
        <div class="kv">
          <span class="key">${escapeHtml(key)}</span>
          <span class="value" title="${escapeHtml(value)}">${escapeHtml(value)}</span>
        </div>
      `
    )
    .join('')

const renderServices = (services) => {
  serviceGrid.innerHTML = Object.values(services || {})
    .sort((left, right) => {
      const leftLegacy = legacyServices.has(left.name) ? 1 : 0
      const rightLegacy = legacyServices.has(right.name) ? 1 : 0
      return (
        leftLegacy - rightLegacy ||
        String(left.name).localeCompare(String(right.name))
      )
    })
    .map((service) => {
      const isLegacy = legacyServices.has(service.name)
      const label = serviceLabels[service.name] || service.name
      return `
        <article
          class="service-card${isLegacy ? ' service-legacy' : ''}"
          data-state="${escapeHtml(service.state)}"
        >
          <span class="service-led"></span>
          <span class="service-name" title="${escapeHtml(service.detail || service.http?.detail)}">
            ${escapeHtml(label)}
          </span>
          <span class="service-state">
            ${escapeHtml(isLegacy ? `${service.state} / legacy` : service.state)}
          </span>
        </article>
      `
    })
    .join('')
}

const renderMediapipe = (payload, service) => {
  if (!payload) {
    mediapipeStatus.innerHTML = renderKv([
      ['Process', service?.processAlive ? 'alive' : 'down'],
      ['WebSocket', service?.tcp?.ok ? 'listening' : 'not listening'],
      ['Status File', 'waiting for GUI telemetry'],
    ])
    return
  }

  mediapipeStatus.innerHTML = renderKv([
    ['Capture', payload.capture || '-'],
    ['WebSocket', payload.websocket || '-'],
    ['Clients', payload.clients ?? '-'],
    ['FPS', payload.fps ?? '-'],
    ['Primary', payload.primary_gesture || '-'],
    ['Best', payload.best_gesture || '-'],
    ['Raw', payload.sword_raw_state || '-'],
    ['Stable', payload.stable_state || '-'],
    ['Held', payload.held_for || '-'],
    ['Updated', formatAge(payload.age_ms)],
  ])
}

const renderTouchDesigner = (payload) => {
  tdStatus.innerHTML = renderKv([
    ['UDP Host', payload?.udpHost || '-'],
    ['UDP Port', payload?.udpPort || '-'],
    ['State', payload?.state || '-'],
    ['Detail', payload?.detail || '-'],
  ])
}

const normalizeFrameUrl = (url) => {
  try {
    return new URL(url, window.location.href).href
  } catch {
    return String(url || '')
  }
}

const renderAituberFrame = (payload) => {
  const url = payload?.url || 'http://127.0.0.1:3000'
  const normalizedUrl = normalizeFrameUrl(url)
  const currentUrl =
    aituberFrame.src && aituberFrame.src !== 'about:blank'
      ? normalizeFrameUrl(aituberFrame.src)
      : ''
  if (currentUrl !== normalizedUrl) {
    aituberFrame.src = normalizedUrl
  }
}

const renderEvents = (events) => {
  eventLog.innerHTML = [...(events || [])]
    .reverse()
    .slice(0, 5)
    .map(
      (event) => `
        <div class="event-row">
          <div class="event-main">${escapeHtml(event.action_id || event.event || '-')}</div>
          <div class="event-sub">${escapeHtml(formatTime(event.timestamp))} / ${escapeHtml(
            event.source || '-'
          )} / ${escapeHtml(event.user_text || event.request_id || '')}</div>
        </div>
      `
    )
    .join('')
}

const renderMagic = (magic) => {
  const active = Boolean(magic?.active)
  magicBanner.classList.toggle('active', active)
  magicBanner.textContent = active
    ? `MAGIC ${magic.lastActionId || ''}`.trim()
    : 'IDLE'
}

const refresh = async () => {
  try {
    const response = await fetch('/api/status', { cache: 'no-store' })
    const payload = await response.json()
    renderServices(payload.services)
    renderMediapipe(payload.mediapipe, payload.services?.mediapipe)
    renderTouchDesigner(payload.touchdesigner)
    renderAituberFrame(payload.aituber)
    renderEvents(payload.homeActions?.events)
    renderMagic(payload.magic)
  } catch (error) {
    renderServices({
      control_gui: {
        name: 'display_runtime_gui',
        state: 'DEGRADED',
        detail: error instanceof Error ? error.message : String(error),
      },
    })
  }
}

const sendTouchDesignerTest = async () => {
  tdTestButton.disabled = true
  tdTestButton.textContent = 'Sending...'
  try {
    const response = await fetch('/api/touchdesigner/test', { method: 'POST' })
    const payload = await response.json()
    tdTestButton.textContent = payload.ok ? 'Display Ping Sent' : 'Display Ping Failed'
  } catch {
    tdTestButton.textContent = 'Display Ping Failed'
  } finally {
    setTimeout(() => {
      tdTestButton.disabled = false
      tdTestButton.textContent = 'Send Display Ping'
    }, 900)
  }
}

const resizeCanvas = () => {
  canvas.width = window.innerWidth * window.devicePixelRatio
  canvas.height = window.innerHeight * window.devicePixelRatio
}

let matrixColumns = []
const resetMatrix = () => {
  resizeCanvas()
  const columnCount = Math.ceil(canvas.width / 18)
  matrixColumns = Array.from({ length: columnCount }, () =>
    Math.floor(Math.random() * canvas.height)
  )
}

const drawMatrix = () => {
  context.fillStyle = 'rgba(2, 7, 10, 0.12)'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.font = `${15 * window.devicePixelRatio}px Consolas, monospace`
  context.fillStyle = state.accent
  const glyphs = '01HOMEAI魔法制御状態同期'
  matrixColumns.forEach((y, index) => {
    const text = glyphs[Math.floor(Math.random() * glyphs.length)]
    const x = index * 18 * window.devicePixelRatio
    context.fillText(text, x, y)
    matrixColumns[index] =
      y > canvas.height + Math.random() * 900
        ? 0
        : y + 18 * window.devicePixelRatio
  })
  requestAnimationFrame(drawMatrix)
}

loadState()
applyState()
resetMatrix()
drawMatrix()
refresh()
setInterval(refresh, 1500)

fontSizeInput.addEventListener('input', () => {
  setFontSize(Number(fontSizeInput.value))
})
accentColorInput.addEventListener('input', () => {
  setAccent(accentColorInput.value)
})
matrixToggle.addEventListener('change', () => {
  state.matrixEnabled = matrixToggle.checked
  applyState()
  saveState()
})
tdTestButton.addEventListener('click', sendTouchDesignerTest)
hudPill.addEventListener('click', toggleHud)
window.addEventListener('resize', resetMatrix)

window.addEventListener('keydown', (event) => {
  const target = event.target
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    return
  }

  if (event.key.toLowerCase() === 'h') {
    toggleHud()
    event.preventDefault()
  } else if (event.key.toLowerCase() === 'm') {
    toggleMatrix()
    event.preventDefault()
  } else if (event.key === '[') {
    setFontSize(state.fontSize - 1)
    event.preventDefault()
  } else if (event.key === ']') {
    setFontSize(state.fontSize + 1)
    event.preventDefault()
  } else if (event.key.toLowerCase() === 'c') {
    const currentIndex = colorPresets.findIndex(
      (color) => color.toLowerCase() === state.accent.toLowerCase()
    )
    setAccent(colorPresets[(currentIndex + 1) % colorPresets.length])
    event.preventDefault()
  } else if (event.key.toLowerCase() === 't') {
    sendTouchDesignerTest()
    event.preventDefault()
  }
})
