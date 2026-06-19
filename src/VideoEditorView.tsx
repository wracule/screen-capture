import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react'
import type { CSSProperties } from 'react'
import EditOutlinedIcon from '@mui/icons-material/EditOutlined'
import ContentCopyOutlinedIcon from '@mui/icons-material/ContentCopyOutlined'
import ChatOutlinedIcon from '@mui/icons-material/ChatOutlined'
import MicNoneRoundedIcon from '@mui/icons-material/MicNoneRounded'
import ZoomInOutlinedIcon from '@mui/icons-material/ZoomInOutlined'
import ZoomOutOutlinedIcon from '@mui/icons-material/ZoomOutOutlined'
import ChevronLeftRoundedIcon from '@mui/icons-material/ChevronLeftRounded'
import ChevronRightRoundedIcon from '@mui/icons-material/ChevronRightRounded'
import KeyboardArrowDownRoundedIcon from '@mui/icons-material/KeyboardArrowDownRounded'
import CheckRoundedIcon from '@mui/icons-material/CheckRounded'
import VisibilityOffOutlinedIcon from '@mui/icons-material/VisibilityOffOutlined'
import Tooltip from '@mui/material/Tooltip'
import ChatAddOnOutlined from './icons/ChatAddOnOutlined'
import './VideoEditorView.css'

type VideoEditorViewProps = {
  videoSrc: string
  onDone: () => void
  onDelete: () => void
}

const FILMSTRIP_FRAMES = 14

/** Prototype callout markers (% of timeline width) with varied spacing across the clip. */
const CALLOUT_MARKER_PCTS = [0, 12, 21, 29, 38, 51, 59, 68, 79, 100]
const CALLOUT_EDGE_END_PCT = 100
/** Active dot size — must match `--timeline-callout-dot-size` in VideoEditorView.css. Inactive dots are 70% of this. */
const CALLOUT_DOT_SIZE_PX = 26
/** Pull playhead to dot center when pointer enters this radius (≈ dot edge + magnetic slop). */
const CALLOUT_SNAP_CAPTURE_PX = CALLOUT_DOT_SIZE_PX / 2 + 10
/** Keep snap until pointer is dragged beyond this distance from the locked dot center. */
const CALLOUT_SNAP_RELEASE_PX = CALLOUT_DOT_SIZE_PX / 2 + 18
/** Fine-tune active callout timing via focus chrome arrows (matches ruler notch interval). */
const CALLOUT_NUDGE_STEP_SEC = 0.25
const CALLOUT_NUDGE_MIN_GAP_SEC = CALLOUT_NUDGE_STEP_SEC / 2

type CalloutSpeedId = 'skip' | '0.5' | '1' | '1.5' | '2' | '2.5' | '3'

type CalloutSpeedOption = {
  id: CalloutSpeedId
  display: string | null
  label: string
  isSkip?: boolean
}

const CALLOUT_SPEED_OPTIONS: CalloutSpeedOption[] = [
  { id: 'skip', display: null, label: 'SKIP', isSkip: true },
  { id: '0.5', display: '.5X', label: 'HALF SPEED(SLOW)' },
  { id: '1', display: '1X', label: 'NORMAL' },
  { id: '1.5', display: '1.5X', label: 'FASTER' },
  { id: '2', display: '2X', label: 'DOUBLE SPEED' },
  { id: '2.5', display: '2.5X', label: 'VERY FAST' },
  { id: '3', display: '3X', label: 'MAX SPEED' },
]

function createDefaultCalloutSpeedMap(): Record<number, CalloutSpeedId> {
  const map: Record<number, CalloutSpeedId> = {}
  CALLOUT_MARKER_PCTS.forEach((_, index) => {
    map[index] = '1'
  })
  return map
}

function calloutSpeedDisplay(speedId: CalloutSpeedId): string {
  const option = CALLOUT_SPEED_OPTIONS.find((entry) => entry.id === speedId)
  return option?.display ?? '1X'
}

function calloutDotCenterNorm(leftPct: number, trackLineWidthPx: number): number {
  if (trackLineWidthPx <= 1e-6) return 0
  if (leftPct === 0) {
    return Math.min(1, CALLOUT_DOT_SIZE_PX / 2 / trackLineWidthPx)
  }
  if (leftPct >= CALLOUT_EDGE_END_PCT) {
    return Math.max(0, 1 - CALLOUT_DOT_SIZE_PX / 2 / trackLineWidthPx)
  }
  return leftPct / 100
}

function firstCalloutDotCenterNorm(trackLineWidthPx: number): number {
  return calloutDotCenterNorm(CALLOUT_MARKER_PCTS[0]!, trackLineWidthPx)
}

function getCalloutBaseNorm(index: number, lineW: number): number {
  return calloutDotCenterNorm(CALLOUT_MARKER_PCTS[index]!, lineW)
}

function getCalloutEffectiveNorm(
  index: number,
  nudgesSec: readonly number[],
  lineW: number,
  durationSec: number,
): number {
  const baseNorm = getCalloutBaseNorm(index, lineW)
  if (durationSec <= 0) return baseNorm
  return Math.min(1, Math.max(0, baseNorm + (nudgesSec[index] ?? 0) / durationSec))
}

function calloutEffectiveCenterClientX(
  rect: DOMRect,
  index: number,
  nudgesSec: readonly number[],
  lineW: number,
  durationSec: number,
): number {
  const norm = getCalloutEffectiveNorm(index, nudgesSec, lineW, durationSec)
  const half = CALLOUT_DOT_SIZE_PX / 2
  if (norm <= half / lineW + 1e-6) return rect.left + half
  if (norm >= 1 - half / lineW - 1e-6) return rect.right - half
  return rect.left + norm * rect.width
}

function getCalloutNudgeBoundsSec(
  index: number,
  nudgesSec: readonly number[],
  lineW: number,
  durationSec: number,
): { minSec: number; maxSec: number } {
  const minSec =
    index > 0
      ? getCalloutEffectiveNorm(index - 1, nudgesSec, lineW, durationSec) * durationSec +
        CALLOUT_NUDGE_MIN_GAP_SEC
      : 0
  const maxSec =
    index < CALLOUT_MARKER_PCTS.length - 1
      ? getCalloutEffectiveNorm(index + 1, nudgesSec, lineW, durationSec) * durationSec -
        CALLOUT_NUDGE_MIN_GAP_SEC
      : durationSec
  return { minSec, maxSec }
}

function calloutFocusChromeAnchorStyleFromNorm(norm: number, lineW: number): React.CSSProperties {
  const halfDot = CALLOUT_DOT_SIZE_PX / 2
  if (lineW > 1e-6 && norm <= halfDot / lineW + 1e-6) {
    return { left: halfDot, transform: 'translate(-50%, -50%)' }
  }
  if (lineW > 1e-6 && norm >= 1 - halfDot / lineW - 1e-6) {
    return { left: `calc(100% - ${halfDot}px)`, transform: 'translate(-50%, -50%)' }
  }
  return { left: `${norm * 100}%`, transform: 'translate(-50%, -50%)' }
}

type TourCalloutPreview = {
  anchorXPct: number
  anchorYPct: number
  bubbleSide: 'left' | 'right'
  title: string
  body: string
}

const TOUR_CALLOUT_TITLES = [
  'Trash',
  'Dashboard',
  'Filters',
  'Reports',
  'Settings',
  'Notifications',
  'Team',
  'Billing',
  'Integrations',
  'Analytics',
  'Shortcuts',
  'Search',
] as const

const TOUR_CALLOUT_BODIES = [
  'Effectively managing deleted things helps to free up storage space but also contributes to improved system performance and organization.',
  'Use the dashboard to monitor activity at a glance and jump into the areas that need attention first.',
  'Apply filters to narrow results quickly so you can focus on the records that matter right now.',
  'Generate reports to share progress with stakeholders and keep everyone aligned on outcomes.',
  'Adjust settings here to tailor the workspace to your team’s workflow and preferences.',
  'Stay on top of updates with notifications that surface the events you care about most.',
  'Invite teammates and manage access so the right people can collaborate in the tour.',
  'Review billing details and plan usage to keep subscriptions predictable and transparent.',
  'Connect external tools to streamline handoffs between systems during the demo.',
  'Explore analytics to understand trends and validate that the tour highlights the right moments.',
  'Keyboard shortcuts speed up repetitive steps and make live walkthroughs feel effortless.',
  'Search across the app to locate features instantly while guiding viewers through the flow.',
] as const

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function buildTourCalloutForIndex(index: number): TourCalloutPreview {
  const rand = mulberry32(index * 2654435761 + 1013904223)
  const anchorXPct = 22 + rand() * 56
  const anchorYPct = 24 + rand() * 52
  const bubbleSide: 'left' | 'right' = anchorXPct > 58 ? 'left' : 'right'
  const title = TOUR_CALLOUT_TITLES[index % TOUR_CALLOUT_TITLES.length]!
  const body =
    TOUR_CALLOUT_BODIES[(index + Math.floor(rand() * TOUR_CALLOUT_BODIES.length)) % TOUR_CALLOUT_BODIES.length]!

  return {
    anchorXPct,
    anchorYPct,
    bubbleSide,
    title,
    body,
  }
}

type CalloutDotSnap = { clientX: number; index: number }

function resolveCalloutDotSnap(
  clientX: number,
  trackLineEl: HTMLElement | null,
  lockedIndex: number | null,
  nudgesSec: readonly number[],
  durationSec: number,
): CalloutDotSnap | null {
  if (!trackLineEl) return null
  const rect = trackLineEl.getBoundingClientRect()
  const lineW = rect.width
  if (lineW <= 1e-6) return null

  if (
    lockedIndex != null &&
    lockedIndex >= 0 &&
    lockedIndex < CALLOUT_MARKER_PCTS.length
  ) {
    const centerX = calloutEffectiveCenterClientX(rect, lockedIndex, nudgesSec, lineW, durationSec)
    if (Math.abs(clientX - centerX) <= CALLOUT_SNAP_RELEASE_PX) {
      return { clientX: centerX, index: lockedIndex }
    }
  }

  let snap: CalloutDotSnap | null = null
  let nearestDist = CALLOUT_SNAP_CAPTURE_PX + 1

  for (let index = 0; index < CALLOUT_MARKER_PCTS.length; index++) {
    const centerX = calloutEffectiveCenterClientX(rect, index, nudgesSec, lineW, durationSec)
    const dist = Math.abs(clientX - centerX)
    if (dist <= CALLOUT_SNAP_CAPTURE_PX && dist < nearestDist) {
      nearestDist = dist
      snap = { clientX: centerX, index }
    }
  }

  return snap
}

type CropInsets = { top: number; left: number; right: number; bottom: number }

function cacheBustedSrc(base: string, token: number): string {
  const sep = base.includes('?') ? '&' : '?'
  return `${base}${sep}t=${token}`
}

type RulerTick = { t: number; kind: 'label' }

const RULER_LABEL_INTERVAL_SEC = 5
/** Notches every 0.25s between major 5s labels. */
const RULER_NOTCH_INTERVAL_SEC = 0.25
const RULER_MIN_NOTCH_STEP_PX = 1.01

function computeRulerNotchStepPx(durationSec: number, widthPx: number): number | null {
  if (!Number.isFinite(durationSec) || durationSec <= 0 || widthPx <= 0) return null
  const stepPx = (RULER_NOTCH_INTERVAL_SEC / durationSec) * widthPx
  if (stepPx < RULER_MIN_NOTCH_STEP_PX) return null
  return stepPx
}

/** Numeric labels every 5 seconds (m:ss). Notches are drawn via CSS gradient. */
function buildTimelineTicks(durationSec: number): RulerTick[] {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return []

  const ticks: RulerTick[] = []
  for (let t = 0; t <= durationSec + 1e-9; t += RULER_LABEL_INTERVAL_SEC) {
    const tt = Math.round(Math.min(t, durationSec) * 1000) / 1000
    ticks.push({ t: tt, kind: 'label' })
  }

  const end = Math.round(durationSec * 1000) / 1000
  if (!ticks.some((tick) => tick.t === end)) {
    ticks.push({ t: end, kind: 'label' })
  }

  return ticks.sort((a, b) => a.t - b.t)
}

function formatRulerLabel(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

/** Map time → horizontal % inside the filmstrip strip so labels line up with contiguous thumbs (tick marks stay linear). */
function filmstripAlignedLabelLeftPct(
  tSec: number,
  durationSec: number,
  thumbCount: number,
  layout: { w: number; gapPx: number } | null,
): number {
  const linearPct = (tSec / durationSec) * 100
  if (
    !layout ||
    layout.w <= 0 ||
    !Number.isFinite(durationSec) ||
    durationSec <= 0 ||
    thumbCount <= 0
  ) {
    return linearPct
  }
  const u = Math.min(1, Math.max(0, tSec / durationSec))
  const { w, gapPx } = layout
  const n = thumbCount
  const thumbW = (w - (n - 1) * gapPx) / n
  if (thumbW <= 0) return linearPct
  const k = Math.min(n - 1, Math.floor(u * n))
  const fracInCell = u * n - k
  const xPx = k * (thumbW + gapPx) + fracInCell * thumbW
  return (xPx / w) * 100
}

function isRulerLabelAtStart(tSec: number): boolean {
  return tSec <= 1e-4
}

function isRulerLabelAtEnd(tSec: number, durationSec: number): boolean {
  return durationSec > 0 && Math.abs(tSec - durationSec) <= 1e-3
}

export function VideoEditorView({ videoSrc, onDone, onDelete }: VideoEditorViewProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const timelineRef = useRef<HTMLDivElement>(null)
  /** Ruler tick / label layout; scrub fallback when playhead overlay is not mounted yet. */
  const rulerInnerRef = useRef<HTMLDivElement>(null)
  /** Playhead slot uses `left: %` of this box — scrub geometry must match for cursor alignment. */
  const playheadRangeRef = useRef<HTMLDivElement>(null)
  const calloutTrackLineRef = useRef<HTMLDivElement>(null)
  const filmstripStripRef = useRef<HTMLDivElement>(null)
  const timelineScrubbingRef = useRef(false)
  const scrubPrevClientXRef = useRef<number | null>(null)
  const snappedCalloutIndexRef = useRef<number | null>(null)
  /** Callout kept in focus after snap/nudge until the user scrubs off it. */
  const focusedCalloutIndexRef = useRef<number | null>(null)
  const pendingInitialPlayheadSeekRef = useRef(true)
  /** True while pointer-drag scrubbing that began on the playhead tip (keep col-resize cursor). */
  const [scrubFromPlayheadTip, setScrubFromPlayheadTip] = useState(false)
  const [timelineScrubbing, setTimelineScrubbing] = useState(false)
  const [activeCalloutDotIndex, setActiveCalloutDotIndex] = useState<number | null>(null)
  const [visitedCalloutDots, setVisitedCalloutDots] = useState<Set<number>>(() => new Set())
  const [calloutTimeNudgesSec, setCalloutTimeNudgesSec] = useState<number[]>(() =>
    CALLOUT_MARKER_PCTS.map(() => 0),
  )
  const [calloutTrackLineWidthPx, setCalloutTrackLineWidthPx] = useState(0)
  const [calloutSpeedMenuOpen, setCalloutSpeedMenuOpen] = useState(false)
  const calloutSpeedMenuRef = useRef<HTMLDivElement>(null)
  const [calloutSpeedByIndex, setCalloutSpeedByIndex] = useState<Record<number, CalloutSpeedId>>(
    createDefaultCalloutSpeedMap,
  )
  const [reloadToken, setReloadToken] = useState(0)
  const [title, setTitle] = useState('The Title/Name of this Dynamic Tour')
  const [titleDraft, setTitleDraft] = useState('')
  const [editingTitle, setEditingTitle] = useState(false)
  const [duration, setDuration] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [loadError, setLoadError] = useState(false)
  const [filmstrip, setFilmstrip] = useState<string[]>([])
  const [filmstripReady, setFilmstripReady] = useState(false)
  const [videoIntrinsicSize, setVideoIntrinsicSize] = useState<{ w: number; h: number } | null>(null)
  const previewSurfaceRef = useRef<HTMLDivElement>(null)
  const [filmstripLayout, setFilmstripLayout] = useState<{ w: number; gapPx: number } | null>(null)
  const [rulerWidthPx, setRulerWidthPx] = useState(0)
  const previewVideoContain = false
  const cropUiOpen = false
  const [cropInsets] = useState<CropInsets>({
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  })
  const videoFrameRef = useRef<HTMLDivElement>(null)
  const mediaSrc = cacheBustedSrc(videoSrc, reloadToken)

  const syncCalloutDotStates = useCallback(
    (activeIndex: number | null, playheadNorm: number) => {
      if (activeIndex == null) {
        focusedCalloutIndexRef.current = null
      } else {
        focusedCalloutIndexRef.current = activeIndex
      }

      const visited = new Set<number>()
      const lineEl = calloutTrackLineRef.current
      const lineW = lineEl?.getBoundingClientRect().width ?? 0

      if (lineW > 1e-6 && duration > 0) {
        for (let i = 0; i < CALLOUT_MARKER_PCTS.length; i++) {
          if (getCalloutEffectiveNorm(i, calloutTimeNudgesSec, lineW, duration) <= playheadNorm + 1e-6) {
            visited.add(i)
          }
        }
      } else if (activeIndex != null) {
        visited.add(activeIndex)
      }

      setVisitedCalloutDots(visited)
      setActiveCalloutDotIndex(activeIndex)
    },
    [calloutTimeNudgesSec, duration],
  )

  useLayoutEffect(() => {
    const el = calloutTrackLineRef.current
    if (!el) return

    const measure = () => {
      setCalloutTrackLineWidthPx(el.clientWidth)
    }

    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [duration, filmstripReady])

  useLayoutEffect(() => {
    const el = filmstripStripRef.current
    if (!el) return

    const measure = () => {
      const cs = getComputedStyle(el)
      const gapRaw = cs.columnGap || cs.gap || '0'
      const gapPx = Number.parseFloat(gapRaw) || 0
      const w = el.clientWidth
      setFilmstripLayout({ w, gapPx })
    }

    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [filmstripReady, filmstrip.length])

  useLayoutEffect(() => {
    const el = rulerInnerRef.current
    if (!el) return

    const measure = () => {
      setRulerWidthPx(el.clientWidth)
    }

    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [duration])

  useLayoutEffect(() => {
    if (!pendingInitialPlayheadSeekRef.current) return
    const video = videoRef.current
    const lineEl = calloutTrackLineRef.current
    if (!video || loadError || !Number.isFinite(duration) || duration <= 0 || !lineEl) return

    const applyInitialPlayheadSeek = () => {
      const lineW = lineEl.getBoundingClientRect().width
      if (lineW <= 1e-6) return false
      const t = firstCalloutDotCenterNorm(lineW) * duration
      video.currentTime = t
      setCurrentTime(t)
      const playheadNorm = firstCalloutDotCenterNorm(lineW)
      syncCalloutDotStates(0, playheadNorm)
      pendingInitialPlayheadSeekRef.current = false
      return true
    }

    if (applyInitialPlayheadSeek()) return

    const ro = new ResizeObserver(() => {
      if (pendingInitialPlayheadSeekRef.current && applyInitialPlayheadSeek()) {
        ro.disconnect()
      }
    })
    ro.observe(lineEl)
    return () => ro.disconnect()
  }, [duration, loadError, mediaSrc, syncCalloutDotStates])

  const reloadVideoFile = useCallback(() => {
    setReloadToken((n) => n + 1)
    setLoadError(false)
    setDuration(0)
    setCurrentTime(0)
    setFilmstrip([])
    setFilmstripReady(false)
    setVideoIntrinsicSize(null)
    setActiveCalloutDotIndex(null)
    setVisitedCalloutDots(new Set())
    setCalloutTimeNudgesSec(CALLOUT_MARKER_PCTS.map(() => 0))
    setCalloutSpeedMenuOpen(false)
    setCalloutSpeedByIndex(createDefaultCalloutSpeedMap())
    focusedCalloutIndexRef.current = null
    pendingInitialPlayheadSeekRef.current = true
  }, [])

  const seekTo = useCallback((t: number) => {
    const el = videoRef.current
    if (!el) return
    const d =
      duration > 0 && Number.isFinite(duration)
        ? duration
        : Number.isFinite(el.duration) && el.duration > 0
          ? el.duration
          : 0
    if (d <= 0) return
    el.currentTime = Math.min(Math.max(0, t), d)
  }, [duration])

  const nudgeActiveCallout = useCallback(
    (delta: -1 | 1) => {
      const index = activeCalloutDotIndex ?? focusedCalloutIndexRef.current
      if (index == null || duration <= 0) return

      const lineEl = calloutTrackLineRef.current
      if (!lineEl) return
      const lineW = lineEl.getBoundingClientRect().width
      if (lineW <= 1e-6) return

      const { minSec, maxSec } = getCalloutNudgeBoundsSec(
        index,
        calloutTimeNudgesSec,
        lineW,
        duration,
      )
      const currentSec = getCalloutEffectiveNorm(index, calloutTimeNudgesSec, lineW, duration) * duration
      const nextSec = Math.min(maxSec, Math.max(minSec, currentSec + CALLOUT_NUDGE_STEP_SEC * delta))
      if (Math.abs(nextSec - currentSec) <= 1e-6) return

      const baseSec = getCalloutBaseNorm(index, lineW) * duration
      const nextNudgeSec = nextSec - baseSec

      setCalloutTimeNudgesSec((prev) => {
        const next = [...prev]
        next[index] = nextNudgeSec
        return next
      })

      const nextNorm = nextSec / duration
      setCurrentTime(nextSec)
      seekTo(nextSec)
      syncCalloutDotStates(index, nextNorm)
      snappedCalloutIndexRef.current = index
      focusedCalloutIndexRef.current = index
    },
    [activeCalloutDotIndex, calloutTimeNudgesSec, duration, seekTo, syncCalloutDotStates],
  )

  useEffect(() => {
    if (duration <= 0 || calloutTrackLineWidthPx <= 1e-6) return
    const index = focusedCalloutIndexRef.current
    if (index == null) return
    const norm = getCalloutEffectiveNorm(
      index,
      calloutTimeNudgesSec,
      calloutTrackLineWidthPx,
      duration,
    )
    syncCalloutDotStates(index, norm)
  }, [calloutTimeNudgesSec, calloutTrackLineWidthPx, duration, syncCalloutDotStates])

  useEffect(() => {
    setCalloutSpeedMenuOpen(false)
  }, [activeCalloutDotIndex])

  useEffect(() => {
    if (!calloutSpeedMenuOpen) return

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (calloutSpeedMenuRef.current?.contains(target)) return
      setCalloutSpeedMenuOpen(false)
    }

    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [calloutSpeedMenuOpen])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    const onLoadedMeta = () => {
      setDuration(video.duration || 0)
      setLoadError(false)
      const w = video.videoWidth
      const h = video.videoHeight
      if (w > 0 && h > 0) {
        setVideoIntrinsicSize({ w, h })
      }
    }
    const onTimeUpdate = () => {
      const d = video.duration
      if (!Number.isFinite(d) || d <= 0) {
        setCurrentTime(video.currentTime)
        return
      }
      const t = video.currentTime
      // seekTo already clamps while dragging; avoid rewriting currentTime from stale samples mid-seek.
      if (timelineScrubbingRef.current) {
        setCurrentTime(t)
        return
      }
      setCurrentTime(t)
      syncCalloutDotStates(focusedCalloutIndexRef.current, t / d)
    }
    const onError = () => setLoadError(true)

    video.addEventListener('loadedmetadata', onLoadedMeta)
    video.addEventListener('timeupdate', onTimeUpdate)
    video.addEventListener('error', onError)

    return () => {
      video.removeEventListener('loadedmetadata', onLoadedMeta)
      video.removeEventListener('timeupdate', onTimeUpdate)
      video.removeEventListener('error', onError)
    }
  }, [mediaSrc, syncCalloutDotStates])

  useEffect(() => {
    const video = videoRef.current
    if (!video || loadError || !Number.isFinite(video.duration) || video.duration <= 0) {
      setFilmstrip([])
      setFilmstripReady(false)
      return
    }

    let cancelled = false
    const w = 88
    const h = 50
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      setFilmstripReady(true)
      return
    }

    const prevTime = video.currentTime
    const wasPaused = video.paused

    void (async () => {
      const urls: string[] = []
      const d = video.duration
      for (let i = 0; i < FILMSTRIP_FRAMES; i++) {
        if (cancelled) return
        const t = d * (i + 0.5) / FILMSTRIP_FRAMES
        video.currentTime = t
        await new Promise<void>((resolve) => {
          const onSeeked = () => {
            video.removeEventListener('seeked', onSeeked)
            resolve()
          }
          video.addEventListener('seeked', onSeeked)
        })
        if (cancelled) return
        ctx.drawImage(video, 0, 0, w, h)
        urls.push(canvas.toDataURL('image/jpeg', 0.55))
      }
      video.currentTime = prevTime
      if (!wasPaused) void video.play()
      if (!cancelled) {
        setFilmstrip(urls)
        setFilmstripReady(true)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [mediaSrc, loadError, duration])

  const seekFromClientX = useCallback(
    (clientX: number, clientY: number) => {
      const d = duration
      if (!d || d <= 0) return

      const snap = timelineScrubbingRef.current
        ? resolveCalloutDotSnap(
            clientX,
            calloutTrackLineRef.current,
            snappedCalloutIndexRef.current,
            calloutTimeNudgesSec,
            d,
          )
        : null

      const rangeEl = playheadRangeRef.current
      let t: number

      if (snap != null) {
        const lineEl = calloutTrackLineRef.current
        if (!lineEl) return
        const lr = lineEl.getBoundingClientRect()
        if (lr.width <= 1e-6) return
        const u = getCalloutEffectiveNorm(snap.index, calloutTimeNudgesSec, lr.width, d)
        seekTo(u * d)
        syncCalloutDotStates(snap.index, u)
        snappedCalloutIndexRef.current = snap.index
        scrubPrevClientXRef.current = clientX
        return
      }

      snappedCalloutIndexRef.current = null

      if (rangeEl) {
        const trackEl = filmstripStripRef.current?.closest(
          '.video-editor__timeline-filmstrip-track',
        ) as HTMLElement | null
        const frameEl = filmstripStripRef.current?.closest(
          '.video-editor__timeline-filmstrip-frame',
        ) as HTMLElement | null

        if (trackEl && frameEl) {
          const fr = frameEl.getBoundingClientRect()
          const tr = trackEl.getBoundingClientRect()
          const inFilmstripTrackY =
            clientY >= tr.top - 2 && clientY <= tr.bottom + 2 && tr.width > 1e-6
          if (inFilmstripTrackY) {
            const inFrameX = clientX >= fr.left && clientX <= fr.right
            if (inFrameX && fr.width > 1e-6) {
              const u = Math.min(1, Math.max(0, (clientX - fr.left) / fr.width))
              t = u * d
            } else {
              const u = Math.min(1, Math.max(0, (clientX - tr.left) / tr.width))
              t = u * d
            }
          } else if (rangeEl) {
            const rr = rangeEl.getBoundingClientRect()
            if (rr.width <= 1e-6) return
            const u = Math.min(1, Math.max(0, (clientX - rr.left) / rr.width))
            t = u * d
          } else {
            return
          }
        } else {
          const refEl = trackEl ?? rangeEl
          const rr = refEl.getBoundingClientRect()
          if (rr.width <= 1e-6) return
          const u = Math.min(1, Math.max(0, (clientX - rr.left) / rr.width))
          t = u * d
        }
      } else {
        const inner = rulerInnerRef.current
        if (!inner) return
        const ruler = inner.querySelector<HTMLElement>('.video-editor__timeline-ruler')
        if (!ruler) return
        const w = ruler.scrollWidth
        if (w <= 0) return
        const r = ruler.getBoundingClientRect()
        t = ((clientX - r.left) / w) * d
      }

      seekTo(t)
      syncCalloutDotStates(null, t / d)
      scrubPrevClientXRef.current = clientX
    },
    [calloutTimeNudgesSec, duration, seekTo, syncCalloutDotStates],
  )

  const onFilmstripWheelPanScroll = (e: ReactWheelEvent<HTMLDivElement>) => {
    const el = timelineRef.current
    if (!el) return
    const dx = e.deltaX !== 0 ? e.deltaX : e.shiftKey ? e.deltaY : 0
    if (dx === 0) return
    el.scrollLeft += dx
    e.preventDefault()
  }

  const onTimelinePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!timelineScrubbingRef.current) return
    e.preventDefault()
    seekFromClientX(e.clientX, e.clientY)
  }

  const endTimelineScrub = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!timelineScrubbingRef.current) return
    timelineScrubbingRef.current = false
    scrubPrevClientXRef.current = null
    snappedCalloutIndexRef.current = null
    setTimelineScrubbing(false)
    setScrubFromPlayheadTip(false)
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* already released */
    }
  }

  const onTimelineStripLostPointerCapture = () => {
    timelineScrubbingRef.current = false
    scrubPrevClientXRef.current = null
    snappedCalloutIndexRef.current = null
    setTimelineScrubbing(false)
    setScrubFromPlayheadTip(false)
  }

  const onTimelinePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || loadError || duration <= 0) return
    const target = e.target
    const fromPlayheadTip =
      target instanceof Element &&
      (target.closest('.video-editor__timeline-playhead-tip') != null ||
        target.closest('.video-editor__timeline-playhead-above-filmstrip-hit') != null)
    e.preventDefault()
    timelineScrubbingRef.current = true
    setTimelineScrubbing(true)
    setScrubFromPlayheadTip(fromPlayheadTip)
    e.currentTarget.setPointerCapture(e.pointerId)
    scrubPrevClientXRef.current = e.clientX
    seekFromClientX(e.clientX, e.clientY)
  }

  const playheadPct =
    duration > 0 && Number.isFinite(currentTime)
      ? Math.min(100, Math.max(0, (currentTime / duration) * 100))
      : 0

  const activeTourCallout = useMemo(
    () => (activeCalloutDotIndex != null ? buildTourCalloutForIndex(activeCalloutDotIndex) : null),
    [activeCalloutDotIndex],
  )

  const activeCalloutNudgeState = useMemo(() => {
    if (activeCalloutDotIndex == null || duration <= 0 || calloutTrackLineWidthPx <= 1e-6) {
      return {
        canNudgeLeft: false,
        canNudgeRight: false,
        focusChromeStyle: undefined as CSSProperties | undefined,
      }
    }

    const index = activeCalloutDotIndex
    const lineW = calloutTrackLineWidthPx
    const { minSec, maxSec } = getCalloutNudgeBoundsSec(
      index,
      calloutTimeNudgesSec,
      lineW,
      duration,
    )
    const currentSec =
      getCalloutEffectiveNorm(index, calloutTimeNudgesSec, lineW, duration) * duration

    return {
      canNudgeLeft: currentSec > minSec + 1e-6,
      canNudgeRight: currentSec < maxSec - 1e-6,
      focusChromeStyle: calloutFocusChromeAnchorStyleFromNorm(
        getCalloutEffectiveNorm(index, calloutTimeNudgesSec, lineW, duration),
        lineW,
      ),
    }
  }, [activeCalloutDotIndex, calloutTimeNudgesSec, calloutTrackLineWidthPx, duration])

  const playheadTrackStyle = useMemo(
    (): CSSProperties => ({
      left: `${playheadPct}%`,
      transform: 'translateX(-50%)',
    }),
    [playheadPct],
  )

  const rulerTicks = useMemo(() => buildTimelineTicks(duration), [duration])

  const rulerNotchStepPx = useMemo(
    () => computeRulerNotchStepPx(duration, rulerWidthPx),
    [duration, rulerWidthPx],
  )

  const rulerNotchStyle = useMemo((): CSSProperties | undefined => {
    if (rulerNotchStepPx == null) return undefined
    return {
      backgroundImage: `repeating-linear-gradient(to right, rgba(255, 255, 255, 0.26) 0, rgba(255, 255, 255, 0.26) 1px, transparent 1px, transparent ${rulerNotchStepPx}px)`,
    }
  }, [rulerNotchStepPx])

  const cropClipPath = useMemo(() => {
    const { top, right, bottom, left } = cropInsets
    if (top <= 1e-5 && right <= 1e-5 && bottom <= 1e-5 && left <= 1e-5) return undefined
    return `inset(${top * 100}% ${right * 100}% ${bottom * 100}% ${left * 100}%)`
  }, [cropInsets])

  const previewSurfaceFullAspectStyle = useMemo((): CSSProperties | undefined => {
    if (loadError || !videoIntrinsicSize) return undefined
    const { w, h } = videoIntrinsicSize
    return { aspectRatio: `${w} / ${h}` } as CSSProperties
  }, [loadError, videoIntrinsicSize])

  const previewSurfaceCroppedAspectStyle = useMemo((): CSSProperties | undefined => {
    if (loadError || !videoIntrinsicSize) return undefined
    const { w, h } = videoIntrinsicSize
    const { top, left, right, bottom } = cropInsets
    const cw = w * (1 - left - right)
    const ch = h * (1 - top - bottom)
    const cropped =
      top > 1e-5 || bottom > 1e-5 || left > 1e-5 || right > 1e-5
    if (!cropped || cw <= 1 || ch <= 1) {
      return previewSurfaceFullAspectStyle
    }
    return { aspectRatio: `${cw} / ${ch}` } as CSSProperties
  }, [loadError, videoIntrinsicSize, cropInsets, previewSurfaceFullAspectStyle])

  const previewSurfaceAspectStyle = cropUiOpen
    ? previewSurfaceFullAspectStyle
    : previewSurfaceCroppedAspectStyle

  /** Matches the preview surface aspect for container-query sizing in CSS (see `VideoEditorView.css`). */
  const previewSurfaceFitVarsStyle = useMemo((): CSSProperties => {
    let aw = 16
    let ah = 9
    if (!loadError && videoIntrinsicSize) {
      if (cropUiOpen) {
        aw = videoIntrinsicSize.w
        ah = videoIntrinsicSize.h
      } else {
        const { w, h } = videoIntrinsicSize
        const { top, left, right, bottom } = cropInsets
        const cw = w * (1 - left - right)
        const ch = h * (1 - top - bottom)
        const cropped = top > 1e-5 || bottom > 1e-5 || left > 1e-5 || right > 1e-5
        if (cropped && cw > 1 && ch > 1) {
          aw = cw
          ah = ch
        } else {
          aw = w
          ah = h
        }
      }
    }
    return {
      ['--preview-fit-ar-w' as string]: String(aw),
      ['--preview-fit-ar-h' as string]: String(ah),
    }
  }, [loadError, videoIntrinsicSize, cropInsets, cropUiOpen])

  const videoStyle = useMemo((): CSSProperties | undefined => {
    if (!videoIntrinsicSize) return undefined
    const fit: CSSProperties['objectFit'] = previewVideoContain ? 'contain' : 'cover'
    const intrinsic = {
      ['--video-intrinsic-w']: `${videoIntrinsicSize.w}px`,
      ['--video-intrinsic-h']: `${videoIntrinsicSize.h}px`,
    } as CSSProperties
    if (!cropClipPath) return { ...intrinsic, objectFit: fit }
    if (cropUiOpen) {
      return {
        ...intrinsic,
        clipPath: cropClipPath,
        WebkitClipPath: cropClipPath,
        objectFit: fit,
      } as CSSProperties
    }
    const { top, left, right, bottom } = cropInsets
    const cx = (left + (1 - left - right) / 2) * 100
    const cy = (top + (1 - top - bottom) / 2) * 100
    return {
      ...intrinsic,
      objectFit: fit,
      objectPosition: previewVideoContain ? '50% 50%' : `${cx}% ${cy}%`,
    } as CSSProperties
  }, [videoIntrinsicSize, cropClipPath, cropInsets, previewVideoContain])

  const startTitleEdit = () => {
    setTitleDraft(title)
    setEditingTitle(true)
  }

  const commitTitle = () => {
    const next = titleDraft.trim()
    if (next) setTitle(next)
    setEditingTitle(false)
  }

  return (
    <div className={`video-editor${cropUiOpen && !loadError ? ' video-editor--crop-mode' : ''}`}>
      <header className="video-editor__top">
        <div className="video-editor__title-block">
          {editingTitle ? (
            <input
              className="video-editor__title-input"
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitTitle()
                if (e.key === 'Escape') setEditingTitle(false)
              }}
              autoFocus
              aria-label="Dynamic Tour title"
            />
          ) : (
            <>
              <span className="video-editor__title">{title}</span>
              <button
                type="button"
                className="video-editor__icon-btn"
                onClick={startTitleEdit}
                aria-label="Edit title"
              >
                <EditOutlinedIcon fontSize="small" />
              </button>
            </>
          )}
        </div>
        <div className="video-editor__brand" aria-hidden>
          <img
            src={`${import.meta.env.BASE_URL}images/dynamic-tour-logo.png`}
            alt=""
            className="video-editor__brand-logo"
            width={28}
            height={28}
          />
          <span className="video-editor__brand-text">Dynamic Tour</span>
        </div>
        <div className="video-editor__top-actions">
          <button
            type="button"
            className="video-editor__duplicate-session"
            onClick={onDelete}
            aria-label="Duplicate recording"
          >
            <ContentCopyOutlinedIcon className="video-editor__duplicate-session-icon" fontSize="small" aria-hidden />
            Duplicate
          </button>
          <button type="button" className="video-editor__done" onClick={onDone}>
            Preview
          </button>
        </div>
      </header>

      <div
        className={`video-editor__preview-block${loadError ? ' video-editor__preview-block--error' : ''}`}
      >
        <div className="video-editor__preview-stage">
          <div
            ref={previewSurfaceRef}
            className={`video-editor__preview-surface${cropUiOpen && !loadError ? ' video-editor__preview-surface--crop-open' : ''}`}
            style={{ ...previewSurfaceFitVarsStyle, ...previewSurfaceAspectStyle }}
          >
            <div className="video-editor__preview-window-chrome" aria-hidden>
              <span className="video-editor__preview-window-dot video-editor__preview-window-dot--lead" />
              <span className="video-editor__preview-window-dot" />
              <span className="video-editor__preview-window-dot" />
            </div>
          {loadError ? (
            <div className="video-editor__video-error">
              <p>Could not load video.</p>
              <p className="video-editor__video-error-hint">
                Add <code>preview.mp4</code> under <code>public/videos/</code> (served as{' '}
                <code>/videos/preview.mp4</code>). After adding or replacing the file, tap Reload video below.
              </p>
              <button type="button" className="video-editor__reload-fallback" onClick={reloadVideoFile}>
                Reload video
              </button>
            </div>
          ) : (
            <div className="video-editor__video-frame" ref={videoFrameRef}>
              <div className="video-editor__video-stack">
                <video
                  key={mediaSrc}
                  ref={videoRef}
                  className="video-editor__video"
                  src={mediaSrc}
                  muted
                  playsInline
                  controls={false}
                  style={videoStyle}
                  onClick={() => {
                    const v = videoRef.current
                    if (!v) return
                    if (v.paused) void v.play()
                    else v.pause()
                  }}
                />
                {activeTourCallout ? (
                  <div
                    key={`tour-callout-${activeCalloutDotIndex}`}
                    className="video-editor__tour-callout-layer"
                    aria-live="polite"
                  >
                    <div
                      className={
                        'video-editor__tour-callout-group' +
                        ` video-editor__tour-callout-group--bubble-${activeTourCallout.bubbleSide}`
                      }
                      style={{
                        left: `${activeTourCallout.anchorXPct}%`,
                        top: `${activeTourCallout.anchorYPct}%`,
                      }}
                    >
                      <div className="video-editor__tour-callout-anchor">
                        <span className="video-editor__tour-callout-dot-halo" aria-hidden />
                        <span className="video-editor__tour-callout-dot" aria-hidden />
                      </div>
                      <div
                        className={
                          'video-editor__tour-callout-bubble' +
                          (activeTourCallout.bubbleSide === 'right'
                            ? ' video-editor__tour-callout-bubble--pointer-left'
                            : ' video-editor__tour-callout-bubble--pointer-right')
                        }
                      >
                        <p className="video-editor__tour-callout-title">{activeTourCallout.title}</p>
                        <p className="video-editor__tour-callout-body">{activeTourCallout.body}</p>
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          )}
          </div>
        </div>
      </div>

      <div className="video-editor__transport-timeline-stack">
        <div className="video-editor__timeline-toolbar" role="toolbar" aria-label="Editor tools">
          <div className="video-editor__timeline-toolbar-group">
            <button type="button" className="video-editor__timeline-toolbar-consensus">
              <img
                src={`${import.meta.env.BASE_URL}images/ai-sparkle.svg`}
                alt=""
                className="video-editor__timeline-toolbar-consensus-sparkle"
                width={18}
                height={18}
                aria-hidden
              />
              <span>Consensus Ai</span>
            </button>
            <span className="video-editor__timeline-toolbar-separator" aria-hidden />
            <div className="video-editor__timeline-toolbar-actions">
              <button type="button" className="video-editor__timeline-toolbar-btn">
                <ChatAddOnOutlined className="video-editor__timeline-toolbar-btn-icon" fontSize="small" aria-hidden />
                Add Guide
              </button>
              <span className="video-editor__timeline-toolbar-separator" aria-hidden />
              <button type="button" className="video-editor__timeline-toolbar-btn">
                <MicNoneRoundedIcon className="video-editor__timeline-toolbar-btn-icon" fontSize="small" aria-hidden />
                Add text to speech
              </button>
            </div>
          </div>
          <div
            className="video-editor__timeline-toolbar-scrim"
            aria-label="Timeline zoom"
            role="group"
          >
            <button
              type="button"
              className="video-editor__timeline-toolbar-scrim-btn"
              aria-label="Zoom out"
              tabIndex={-1}
              disabled
            >
              <ZoomOutOutlinedIcon className="video-editor__timeline-toolbar-scrim-icon" fontSize="small" aria-hidden />
            </button>
            <div className="video-editor__timeline-toolbar-scrim-slider" aria-hidden>
              <div className="video-editor__timeline-toolbar-scrim-track">
                <div
                  className="video-editor__timeline-toolbar-scrim-fill"
                  style={{ width: '52%' }}
                />
                <div
                  className="video-editor__timeline-toolbar-scrim-thumb"
                  style={{ left: '52%' }}
                />
              </div>
            </div>
            <button
              type="button"
              className="video-editor__timeline-toolbar-scrim-btn"
              aria-label="Zoom in"
              tabIndex={-1}
              disabled
            >
              <ZoomInOutlinedIcon className="video-editor__timeline-toolbar-scrim-icon" fontSize="small" aria-hidden />
            </button>
          </div>
        </div>

      <div className="video-editor__timeline-row">
          <div className="video-editor__timeline-shell video-editor__timeline-shell--stacked">
            <div className="video-editor__timeline-band">
              <div
                className={
                  'video-editor__timeline-strip-wrap' +
                  (scrubFromPlayheadTip ? ' video-editor__timeline-strip-wrap--scrub-playhead-tip' : '') +
                  (timelineScrubbing ? ' video-editor__timeline-strip-wrap--scrubbing' : '')
                }
                role="slider"
                tabIndex={loadError || duration <= 0 ? -1 : 0}
                aria-label="Video timeline scrubber"
                aria-valuemin={0}
                aria-valuemax={duration > 0 ? Math.round(duration * 1000) / 1000 : 0}
                aria-valuenow={Math.round(currentTime * 1000) / 1000}
                aria-disabled={loadError || duration <= 0}
                onPointerDown={onTimelinePointerDown}
                onPointerMove={onTimelinePointerMove}
                onPointerUp={endTimelineScrub}
                onPointerCancel={endTimelineScrub}
                onLostPointerCapture={onTimelineStripLostPointerCapture}
                onKeyDown={(e) => {
                  if (loadError || duration <= 0) return
                  const step = e.shiftKey ? 5 : 1
                  if (e.key === 'ArrowLeft') {
                    e.preventDefault()
                    seekTo(currentTime - step)
                  } else if (e.key === 'ArrowRight') {
                    e.preventDefault()
                    seekTo(currentTime + step)
                  } else if (e.key === 'Home') {
                    e.preventDefault()
                    seekTo(0)
                  } else if (e.key === 'End') {
                    e.preventDefault()
                    seekTo(duration)
                  }
                }}
              >
                <div className="video-editor__timeline-scroll-col video-editor__timeline-playhead-scope">
                  <div className="video-editor__timeline-bottom-strip">
                    <div
                      className="video-editor__timeline-ruler-stack"
                      onWheel={onFilmstripWheelPanScroll}
                    >
                      <div ref={timelineRef} className="video-editor__timeline-ruler-scroll">
                        <div className="video-editor__timeline-ruler-track">
                          <div ref={rulerInnerRef} className="video-editor__timeline-ruler-inner">
                            {duration > 0 ? (
                              <div className="video-editor__timeline-ruler" aria-hidden>
                                {rulerNotchStyle ? (
                                  <div
                                    className="video-editor__timeline-ruler-notches"
                                    style={rulerNotchStyle}
                                  />
                                ) : null}
                                {rulerTicks.map((tick) => {
                                    const atStart = isRulerLabelAtStart(tick.t)
                                    const atEnd = isRulerLabelAtEnd(tick.t, duration)
                                    const cls =
                                      `video-editor__timeline-ruler-label` +
                                      (atStart ? ' video-editor__timeline-ruler-label--start' : '') +
                                      (atEnd ? ' video-editor__timeline-ruler-label--end' : '')
                                    return (
                                      <span
                                        key={`ruler-lbl-${tick.t}`}
                                        className={cls}
                                        style={{
                                          left: `${filmstripAlignedLabelLeftPct(
                                            tick.t,
                                            duration,
                                            FILMSTRIP_FRAMES,
                                            filmstripLayout,
                                          )}%`,
                                        }}
                                      >
                                        {formatRulerLabel(tick.t)}
                                      </span>
                                    )
                                  })}
                              </div>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    </div>
                    <div className="video-editor__timeline-track-rows" aria-hidden={loadError}>
                      <div
                        className={
                          'video-editor__timeline-track video-editor__timeline-track--callouts' +
                          (activeCalloutDotIndex != null
                            ? ' video-editor__timeline-track--callouts-focused'
                            : '')
                        }
                      >
                        <div className="video-editor__timeline-track-inner">
                          <span className="video-editor__timeline-track-icon" aria-hidden>
                            <ChatOutlinedIcon className="video-editor__timeline-track-icon-svg" fontSize="small" />
                          </span>
                          <div
                            ref={calloutTrackLineRef}
                            className="video-editor__timeline-track-line video-editor__timeline-track-line--callouts"
                            aria-label="Callouts"
                          >
                            <div
                              className="video-editor__timeline-callout-line-fill"
                              style={{ width: `${playheadPct}%` }}
                              aria-hidden
                            />
                            <div
                              className={
                                'video-editor__timeline-callout-focus-chrome' +
                                (activeCalloutDotIndex != null
                                  ? ' video-editor__timeline-callout-focus-chrome--visible'
                                  : '')
                              }
                              style={
                                activeCalloutDotIndex != null
                                  ? activeCalloutNudgeState.focusChromeStyle
                                  : undefined
                              }
                            >
                              <div className="video-editor__timeline-callout-focus-rail" aria-hidden />
                              <div className="video-editor__timeline-callout-focus-nav-row">
                                <div className="video-editor__timeline-callout-focus-nav-wing">
                                  <Tooltip
                                    title="Nudge left"
                                    placement="top"
                                    disableInteractive
                                    enterDelay={400}
                                    enterNextDelay={400}
                                  >
                                    <span className="video-editor__timeline-callout-nav-tooltip-wrap">
                                      <button
                                        type="button"
                                        className="video-editor__timeline-callout-nav video-editor__timeline-callout-nav--prev"
                                        aria-label="Nudge left"
                                        disabled={
                                          activeCalloutDotIndex == null ||
                                          !activeCalloutNudgeState.canNudgeLeft
                                        }
                                        onPointerDown={(e) => e.stopPropagation()}
                                        onClick={(e) => {
                                          e.stopPropagation()
                                          nudgeActiveCallout(-1)
                                        }}
                                      >
                                        <ChevronLeftRoundedIcon fontSize="small" aria-hidden />
                                      </button>
                                    </span>
                                  </Tooltip>
                                </div>
                                <span
                                  className="video-editor__timeline-callout-focus-badge-slot"
                                  aria-hidden
                                />
                                <div className="video-editor__timeline-callout-focus-nav-wing">
                                  <Tooltip
                                    title="Nudge right"
                                    placement="top"
                                    disableInteractive
                                    enterDelay={400}
                                    enterNextDelay={400}
                                  >
                                    <span className="video-editor__timeline-callout-nav-tooltip-wrap">
                                      <button
                                        type="button"
                                        className="video-editor__timeline-callout-nav video-editor__timeline-callout-nav--next"
                                        aria-label="Nudge right"
                                        disabled={
                                          activeCalloutDotIndex == null ||
                                          !activeCalloutNudgeState.canNudgeRight
                                        }
                                        onPointerDown={(e) => e.stopPropagation()}
                                        onClick={(e) => {
                                          e.stopPropagation()
                                          nudgeActiveCallout(1)
                                        }}
                                      >
                                        <ChevronRightRoundedIcon fontSize="small" aria-hidden />
                                      </button>
                                    </span>
                                  </Tooltip>
                                </div>
                              </div>
                            </div>
                            {CALLOUT_MARKER_PCTS.map((_baseLeftPct, index) => {
                              const dotAnchorStyle =
                                calloutTrackLineWidthPx > 1e-6 && duration > 0
                                  ? calloutFocusChromeAnchorStyleFromNorm(
                                      getCalloutEffectiveNorm(
                                        index,
                                        calloutTimeNudgesSec,
                                        calloutTrackLineWidthPx,
                                        duration,
                                      ),
                                      calloutTrackLineWidthPx,
                                    )
                                  : undefined
                              const isActive = activeCalloutDotIndex === index
                              const selectedSpeed = calloutSpeedByIndex[index] ?? '1'
                              return (
                              <span
                                key={`callout-${index}`}
                                className={
                                  'video-editor__timeline-callout-dot' +
                                  (isActive
                                    ? ' video-editor__timeline-callout-dot--active'
                                    : visitedCalloutDots.has(index)
                                      ? ' video-editor__timeline-callout-dot--visited'
                                      : '')
                                }
                                style={dotAnchorStyle}
                                aria-hidden={!isActive}
                              >
                                {isActive ? (
                                  <div
                                    ref={calloutSpeedMenuRef}
                                    className={
                                      'video-editor__timeline-callout-focus-badge-wrap' +
                                      (calloutSpeedMenuOpen
                                        ? ' video-editor__timeline-callout-focus-badge-wrap--menu-open'
                                        : '')
                                    }
                                  >
                                    {calloutSpeedMenuOpen ? (
                                      <div
                                        className="video-editor__timeline-callout-speed-menu"
                                        role="menu"
                                        aria-label="Callout speed"
                                      >
                                        {CALLOUT_SPEED_OPTIONS.map((option) => {
                                          const isSelected = selectedSpeed === option.id
                                          return (
                                            <button
                                              key={option.id}
                                              type="button"
                                              role="menuitemradio"
                                              aria-checked={isSelected}
                                              className={
                                                'video-editor__timeline-callout-speed-menu-item' +
                                                (isSelected
                                                  ? ' video-editor__timeline-callout-speed-menu-item--selected'
                                                  : '')
                                              }
                                              onPointerDown={(e) => e.stopPropagation()}
                                              onClick={(e) => {
                                                e.stopPropagation()
                                                setCalloutSpeedByIndex((prev) => ({
                                                  ...prev,
                                                  [index]: option.id,
                                                }))
                                                setCalloutSpeedMenuOpen(false)
                                              }}
                                            >
                                              <span className="video-editor__timeline-callout-speed-menu-leading">
                                                {isSelected ? (
                                                  <CheckRoundedIcon
                                                    className="video-editor__timeline-callout-speed-menu-check"
                                                    aria-hidden
                                                  />
                                                ) : (
                                                  <span
                                                    className="video-editor__timeline-callout-speed-menu-check-spacer"
                                                    aria-hidden
                                                  />
                                                )}
                                                {option.isSkip ? (
                                                  <VisibilityOffOutlinedIcon
                                                    className="video-editor__timeline-callout-speed-menu-skip-icon"
                                                    aria-hidden
                                                  />
                                                ) : (
                                                  <span className="video-editor__timeline-callout-speed-menu-value">
                                                    {option.display}
                                                  </span>
                                                )}
                                              </span>
                                              <span className="video-editor__timeline-callout-speed-menu-label">
                                                {option.label}
                                              </span>
                                            </button>
                                          )
                                        })}
                                      </div>
                                    ) : null}
                                    <div className="video-editor__timeline-callout-focus-badge">
                                      {selectedSpeed === 'skip' ? (
                                        <VisibilityOffOutlinedIcon
                                          className="video-editor__timeline-callout-focus-skip-icon"
                                          aria-hidden
                                        />
                                      ) : (
                                        <span className="video-editor__timeline-callout-focus-label">
                                          {calloutSpeedDisplay(selectedSpeed)}
                                        </span>
                                      )}
                                      <button
                                        type="button"
                                        className="video-editor__timeline-callout-focus-chevron-btn"
                                        aria-label="Callout speed menu"
                                        aria-expanded={calloutSpeedMenuOpen}
                                        aria-haspopup="menu"
                                        onPointerDown={(e) => e.stopPropagation()}
                                        onClick={(e) => {
                                          e.stopPropagation()
                                          setCalloutSpeedMenuOpen((open) => !open)
                                        }}
                                      >
                                        <KeyboardArrowDownRoundedIcon
                                          className="video-editor__timeline-callout-focus-chevron"
                                          fontSize="inherit"
                                          aria-hidden
                                        />
                                      </button>
                                    </div>
                                  </div>
                                ) : null}
                              </span>
                            )})}
                          </div>
                        </div>
                      </div>
                      <div className="video-editor__timeline-track video-editor__timeline-track--tts">
                        <div className="video-editor__timeline-track-inner">
                          <span className="video-editor__timeline-track-icon" aria-hidden>
                            <MicNoneRoundedIcon className="video-editor__timeline-track-icon-svg" fontSize="small" />
                          </span>
                          <button
                            type="button"
                            className="video-editor__timeline-tts-placeholder"
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={(e) => e.stopPropagation()}
                          >
                            Add text to speech
                          </button>
                        </div>
                      </div>
                    </div>
                    <div
                      className="video-editor__timeline-filmstrip-viewport"
                      onWheel={onFilmstripWheelPanScroll}
                    >
                      <div className="video-editor__timeline-filmstrip-track">
                        <div className="video-editor__timeline-filmstrip-frame">
                          <div className="video-editor__timeline-filmstrip-sizer">
                            <div className="video-editor__timeline-panel">
                              <div className="video-editor__timeline-filmstrip-thumbs-clip">
                                <div
                                  ref={filmstripStripRef}
                                  className="video-editor__timeline-strip"
                                >
                                {!filmstripReady && !loadError ? (
                                  <div className="video-editor__timeline-loading">Loading preview…</div>
                                ) : (
                                  filmstrip.map((src, thumbIdx) => (
                                    <div
                                      key={`thumb-${thumbIdx}`}
                                      className="video-editor__thumb"
                                      style={{ backgroundImage: `url(${src})` }}
                                      aria-hidden
                                    />
                                  ))
                                )}
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                    </div>
                    {filmstripReady && duration > 0 ? (
                      <div ref={playheadRangeRef} className="video-editor__timeline-playhead-range" aria-hidden>
                        <div
                          className="video-editor__timeline-playhead-above-filmstrip-hit"
                          style={playheadTrackStyle}
                          aria-hidden
                          onWheel={onFilmstripWheelPanScroll}
                        />
                        <div className="video-editor__timeline-playhead-slot" style={playheadTrackStyle}>
                          <div className="video-editor__timeline-playhead-bar" />
                        </div>
                        <div className="video-editor__timeline-playhead-tip-slot" style={playheadTrackStyle}>
                          <div className="video-editor__timeline-playhead-tip" />
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
