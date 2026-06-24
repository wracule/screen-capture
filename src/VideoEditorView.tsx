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
import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown'
import ArrowDropUpIcon from '@mui/icons-material/ArrowDropUp'
import CheckRoundedIcon from '@mui/icons-material/CheckRounded'
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined'
import VisibilityOffOutlinedIcon from '@mui/icons-material/VisibilityOffOutlined'
import PlayArrowRoundedIcon from '@mui/icons-material/PlayArrowRounded'
import PauseRoundedIcon from '@mui/icons-material/PauseRounded'
import SkipPreviousRoundedIcon from '@mui/icons-material/SkipPreviousRounded'
import SkipNextRoundedIcon from '@mui/icons-material/SkipNextRounded'
import FastRewindRoundedIcon from '@mui/icons-material/FastRewindRounded'
import FastForwardRoundedIcon from '@mui/icons-material/FastForwardRounded'
import RecordVoiceOverRoundedIcon from '@mui/icons-material/RecordVoiceOverRounded'
import Tooltip from '@mui/material/Tooltip'
import ChatAddOnOutlined from './icons/ChatAddOnOutlined'
import './VideoEditorView.css'

type VideoEditorViewProps = {
  videoSrc: string
  onDone: () => void
  onSave: () => void
  onDelete: () => void
}

const FILMSTRIP_FRAMES = 14

/** Prototype callout markers (% of timeline width) with varied spacing across the clip. */
const CALLOUT_MARKER_PCTS = [0, 12, 21, 29, 38, 51, 59, 68, 79, 100]
const CALLOUT_EDGE_END_PCT = 100
/** Active dot size — must match `--timeline-callout-dot-size` in VideoEditorView.css. Inactive dots are 55% of this. */
const CALLOUT_DOT_SIZE_PX = 40
/** Pull playhead to dot center when pointer enters this radius (≈ dot edge + magnetic slop). */
const CALLOUT_SNAP_CAPTURE_PX = CALLOUT_DOT_SIZE_PX / 2 + 10
/** Keep snap until pointer is dragged beyond this distance from the locked dot center. */
const CALLOUT_SNAP_RELEASE_PX = CALLOUT_DOT_SIZE_PX / 2 + 18
/** Fine-tune active callout timing via focus chrome arrows (matches ruler notch interval). */
const CALLOUT_NUDGE_STEP_SEC = 0.25
const CALLOUT_NUDGE_MIN_GAP_SEC = CALLOUT_NUDGE_STEP_SEC / 2
/** Playhead rewind / fast-forward step (matches timeline keyboard nudge). */
const PLAYHEAD_NUDGE_STEP_SEC = 1

type CalloutSpeedId = 'skip' | '0.5' | '1' | '1.5' | '2' | '2.5' | '3'

/** Purple TTS bubble base width — must match `--timeline-tts-clip-core-base-w` in VideoEditorView.css. */
const TTS_CLIP_CORE_BASE_W_PX = 48
const TTS_CLIP_EXPANDED_SCALE = 3

function ttsClipCoreWidthPx(expanded: boolean): number {
  return TTS_CLIP_CORE_BASE_W_PX * (expanded ? TTS_CLIP_EXPANDED_SCALE : 1)
}

function ttsClipPurpleStartNorm(centerNorm: number, lineW: number, coreWPx = TTS_CLIP_CORE_BASE_W_PX): number {
  if (lineW <= 1e-6) return centerNorm
  return Math.min(1, Math.max(0, centerNorm - coreWPx / 2 / lineW))
}

function ttsClipPurpleEndNorm(centerNorm: number, lineW: number, coreWPx = TTS_CLIP_CORE_BASE_W_PX): number {
  if (lineW <= 1e-6) return centerNorm
  return Math.min(1, Math.max(0, centerNorm + coreWPx / 2 / lineW))
}

function clampTtsClipCenterNorm(centerNorm: number, lineW: number, coreWPx: number): number {
  if (lineW <= 1e-6) return centerNorm
  const halfNorm = coreWPx / 2 / lineW
  return Math.min(1 - halfNorm, Math.max(halfNorm, centerNorm))
}

function ttsClipCenterNormFromPurpleStart(startNorm: number, lineW: number, coreWPx: number): number {
  if (lineW <= 1e-6) return startNorm
  return clampTtsClipCenterNorm(startNorm + coreWPx / 2 / lineW, lineW, coreWPx)
}

function isPlayheadOverTtsClip(
  playheadNorm: number,
  centerNorm: number,
  lineW: number,
  coreWPx = TTS_CLIP_CORE_BASE_W_PX,
): boolean {
  return (
    playheadNorm >= ttsClipPurpleStartNorm(centerNorm, lineW, coreWPx) &&
    playheadNorm <= ttsClipPurpleEndNorm(centerNorm, lineW, coreWPx)
  )
}

function getTtsClipNudgeBoundsSec(
  clipId: string,
  clips: readonly TtsClip[],
  lineW: number,
  durationSec: number,
  coreWidthForClip: (id: string) => number,
): { minSec: number; maxSec: number } {
  if (durationSec <= 0 || lineW <= 1e-6) return { minSec: 0, maxSec: 0 }

  const coreWPx = coreWidthForClip(clipId)
  const halfBubbleSec = (coreWPx / 2 / lineW) * durationSec
  const minCenterSec = halfBubbleSec
  const maxCenterSec = durationSec - halfBubbleSec

  const sorted = [...clips].sort((a, b) => a.centerNorm - b.centerNorm)
  const index = sorted.findIndex((clip) => clip.id === clipId)
  if (index < 0) return { minSec: minCenterSec, maxSec: maxCenterSec }

  const minSecFromPrev =
    index > 0
      ? sorted[index - 1]!.centerNorm * durationSec +
        ((coreWidthForClip(sorted[index - 1]!.id) / 2 + coreWPx / 2) / lineW) * durationSec +
        CALLOUT_NUDGE_MIN_GAP_SEC
      : minCenterSec
  const maxSecFromNext =
    index < sorted.length - 1
      ? sorted[index + 1]!.centerNorm * durationSec -
        ((coreWidthForClip(sorted[index + 1]!.id) / 2 + coreWPx / 2) / lineW) * durationSec -
        CALLOUT_NUDGE_MIN_GAP_SEC
      : maxCenterSec

  return {
    minSec: Math.max(minCenterSec, minSecFromPrev),
    maxSec: Math.min(maxCenterSec, maxSecFromNext),
  }
}

const TTS_WAVE_BAR_HEIGHTS_PX = [11, 9, 4, 14, 9, 11, 9] as const
const TTS_WAVE_BAR_COUNT = TTS_WAVE_BAR_HEIGHTS_PX.length

function ttsWaveBarCount(expanded: boolean): number {
  return expanded ? TTS_WAVE_BAR_COUNT * TTS_CLIP_EXPANDED_SCALE * 2 : TTS_WAVE_BAR_COUNT
}

type TtsClip = {
  id: string
  centerNorm: number
  expanded: boolean
}

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

type CalloutGuide = {
  id: string
  centerNorm: number
}

type TimelineOccupiedSpan = {
  startSec: number
  endSec: number
}

function minCalloutCenterGapSec(lineW: number, durationSec: number): number {
  if (lineW <= 1e-6 || durationSec <= 0) return 0
  const dotWidthSec = (CALLOUT_DOT_SIZE_PX / lineW) * durationSec
  const edgeTouchGapSec = Math.max(0, dotWidthSec - CALLOUT_NUDGE_STEP_SEC)
  return Math.min(edgeTouchGapSec, PLAYHEAD_NUDGE_STEP_SEC)
}

function timelineSpansConflict(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
  gapSec = CALLOUT_NUDGE_MIN_GAP_SEC,
): boolean {
  return aStart < bEnd + gapSec - 1e-6 && bStart < aEnd + gapSec - 1e-6
}

function ttsOccupiedSpanSec(
  centerNorm: number,
  lineW: number,
  durationSec: number,
  coreWPx: number,
): TimelineOccupiedSpan {
  const centerSec = centerNorm * durationSec
  const halfSec = lineW > 1e-6 ? (coreWPx / 2 / lineW) * durationSec : 0
  return { startSec: centerSec - halfSec, endSec: centerSec + halfSec }
}

function canPlaceCalloutGuideAtPlayhead(
  playheadNorm: number,
  guides: readonly CalloutGuide[],
  lineW: number,
  durationSec: number,
): boolean {
  if (durationSec <= 0 || lineW <= 1e-6) return false

  const centerNorm = clampCalloutCenterNorm(playheadNorm, lineW)
  const centerSec = centerNorm * durationSec
  const halfDotSec = (CALLOUT_DOT_SIZE_PX / 2 / lineW) * durationSec

  if (centerSec < halfDotSec - 1e-6 || centerSec > durationSec - halfDotSec + 1e-6) {
    return false
  }

  const minCenterGapSec = minCalloutCenterGapSec(lineW, durationSec)
  for (const guide of guides) {
    const otherCenterSec = clampCalloutCenterNorm(guide.centerNorm, lineW) * durationSec
    if (Math.abs(centerSec - otherCenterSec) < minCenterGapSec - 1e-6) {
      return false
    }
  }

  return true
}

function canPlaceTtsClipAtPlayhead(
  playheadNorm: number,
  clips: readonly TtsClip[],
  lineW: number,
  durationSec: number,
  coreWPx = TTS_CLIP_CORE_BASE_W_PX,
): boolean {
  if (durationSec <= 0 || lineW <= 1e-6) return false

  const centerNorm = ttsClipCenterNormFromPurpleStart(playheadNorm, lineW, coreWPx)
  const startNorm = ttsClipPurpleStartNorm(centerNorm, lineW, coreWPx)
  if (Math.abs(startNorm - playheadNorm) > 1e-6) {
    return false
  }

  const ttsSpan = ttsOccupiedSpanSec(centerNorm, lineW, durationSec, coreWPx)
  for (const clip of clips) {
    const otherSpan = ttsOccupiedSpanSec(
      clip.centerNorm,
      lineW,
      durationSec,
      ttsClipCoreWidthPx(clip.expanded),
    )
    if (timelineSpansConflict(ttsSpan.startSec, ttsSpan.endSec, otherSpan.startSec, otherSpan.endSec, 0)) {
      return false
    }
  }

  return true
}

type TimelineSegment = {
  startSec: number
  endSec: number
  guideId: string | null
}

function buildTimelineSegments(guides: readonly CalloutGuide[], durationSec: number): TimelineSegment[] {
  if (durationSec <= 0) return []

  const sorted = [...guides].sort((a, b) => a.centerNorm - b.centerNorm)
  if (sorted.length === 0) {
    return [{ startSec: 0, endSec: durationSec, guideId: null }]
  }

  const segments: TimelineSegment[] = [
    {
      startSec: 0,
      endSec: sorted[0]!.centerNorm * durationSec,
      guideId: null,
    },
  ]

  for (let i = 0; i < sorted.length - 1; i++) {
    segments.push({
      startSec: sorted[i]!.centerNorm * durationSec,
      endSec: sorted[i + 1]!.centerNorm * durationSec,
      guideId: sorted[i]!.id,
    })
  }

  segments.push({
    startSec: sorted[sorted.length - 1]!.centerNorm * durationSec,
    endSec: durationSec,
    guideId: sorted[sorted.length - 1]!.id,
  })

  return segments
}

function findSegmentIndex(segments: readonly TimelineSegment[], timeSec: number): number {
  if (segments.length === 0) return 0

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!
    const isLast = i === segments.length - 1
    if (timeSec >= seg.startSec - 1e-6 && (timeSec < seg.endSec - 1e-6 || isLast)) {
      return i
    }
  }

  return segments.length - 1
}

function getCalloutGuideIdAtTime(
  guides: readonly CalloutGuide[],
  durationSec: number,
  timeSec: number,
): string | null {
  if (durationSec <= 0) return null

  const sorted = [...guides].sort((a, b) => a.centerNorm - b.centerNorm)
  for (const guide of sorted) {
    const guideSec = guide.centerNorm * durationSec
    if (Math.abs(guideSec - timeSec) < 1e-3) {
      return guide.id
    }
  }

  if (timeSec >= durationSec - 1e-3 && sorted.length > 0) {
    return sorted[sorted.length - 1]!.id
  }

  return null
}

function getActiveGuideIdWhenSegmentStops(
  segments: readonly TimelineSegment[],
  segmentEndSec: number,
  durationSec: number,
  guides: readonly CalloutGuide[],
): string | null {
  const guideAtStop = getCalloutGuideIdAtTime(guides, durationSec, segmentEndSec)
  if (guideAtStop != null) return guideAtStop

  const nextSegment = segments.find((seg) => Math.abs(seg.startSec - segmentEndSec) < 1e-3)
  if (nextSegment?.guideId != null) return nextSegment.guideId

  const playingSegment = segments.find((seg) => Math.abs(seg.endSec - segmentEndSec) < 1e-3)
  return playingSegment?.guideId ?? null
}

function findTimelineSegmentByEndSec(
  segments: readonly TimelineSegment[],
  segmentEndSec: number,
): TimelineSegment | undefined {
  return segments.find((seg) => Math.abs(seg.endSec - segmentEndSec) < 1e-3)
}

function createSeedCalloutGuides(): CalloutGuide[] {
  return CALLOUT_MARKER_PCTS.map((pct, index) => ({
    id: `callout-seed-${index}`,
    centerNorm: pct / 100,
  }))
}

function createDefaultCalloutSpeedMap(guides: readonly CalloutGuide[]): Record<string, CalloutSpeedId> {
  const map: Record<string, CalloutSpeedId> = {}
  guides.forEach((guide) => {
    map[guide.id] = '1'
  })
  return map
}

function clampCalloutCenterNorm(centerNorm: number, lineW: number): number {
  if (lineW <= 1e-6) return centerNorm
  const halfNorm = CALLOUT_DOT_SIZE_PX / 2 / lineW
  return Math.min(1 - halfNorm, Math.max(halfNorm, centerNorm))
}

function calloutSpeedDisplay(speedId: CalloutSpeedId): string {
  const option = CALLOUT_SPEED_OPTIONS.find((entry) => entry.id === speedId)
  return option?.display ?? '1X'
}

function calloutSpeedIndex(speedId: CalloutSpeedId): number {
  const index = CALLOUT_SPEED_OPTIONS.findIndex((entry) => entry.id === speedId)
  return index >= 0 ? index : CALLOUT_SPEED_OPTIONS.findIndex((entry) => entry.id === '1')
}

function cycleCalloutSpeed(speedId: CalloutSpeedId, direction: 1 | -1): CalloutSpeedId {
  const index = calloutSpeedIndex(speedId)
  const nextIndex = Math.min(
    CALLOUT_SPEED_OPTIONS.length - 1,
    Math.max(0, index + direction),
  )
  return CALLOUT_SPEED_OPTIONS[nextIndex]!.id
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

function calloutGuideCenterClientX(rect: DOMRect, centerNorm: number, lineW: number): number {
  return rect.left + calloutGuideCenterOffsetPx(centerNorm, lineW)
}

function calloutGuideCenterOffsetPx(centerNorm: number, lineW: number): number {
  const half = CALLOUT_DOT_SIZE_PX / 2
  if (lineW <= 1e-6) return centerNorm * lineW
  if (centerNorm <= half / lineW + 1e-6) return half
  if (centerNorm >= 1 - half / lineW - 1e-6) return lineW - half
  return centerNorm * lineW
}

function resolveCalloutGuideSnapForPlayheadNudge(
  nextPlayheadNorm: number,
  currentPlayheadNorm: number,
  guides: readonly CalloutGuide[],
  lineW: number,
): CalloutGuide | null {
  if (lineW <= 1e-6 || guides.length === 0) return null

  const nextPx = nextPlayheadNorm * lineW
  const currentPx = currentPlayheadNorm * lineW

  let snapGuide: CalloutGuide | null = null
  let nearestDist = CALLOUT_SNAP_CAPTURE_PX + 1

  for (const guide of guides) {
    const centerPx = calloutGuideCenterOffsetPx(guide.centerNorm, lineW)
    const nextDist = Math.abs(nextPx - centerPx)
    if (nextDist > CALLOUT_SNAP_CAPTURE_PX) continue

    const currentDist = Math.abs(currentPx - centerPx)
    if (nextDist >= currentDist - 1e-6) continue

    if (nextDist < nearestDist) {
      nearestDist = nextDist
      snapGuide = guide
    }
  }

  return snapGuide
}

function getCalloutNudgeBoundsSec(
  guideId: string,
  guides: readonly CalloutGuide[],
  lineW: number,
  durationSec: number,
): { minSec: number; maxSec: number } {
  const halfDotSec = lineW > 1e-6 ? (CALLOUT_DOT_SIZE_PX / 2 / lineW) * durationSec : 0
  const minCenterSec = halfDotSec
  const maxCenterSec = durationSec - halfDotSec

  const sorted = [...guides].sort((a, b) => a.centerNorm - b.centerNorm)
  const index = sorted.findIndex((guide) => guide.id === guideId)
  if (index < 0) return { minSec: minCenterSec, maxSec: maxCenterSec }

  const gapSec = minCalloutCenterGapSec(lineW, durationSec)
  const minSecFromPrev =
    index > 0 ? sorted[index - 1]!.centerNorm * durationSec + gapSec : minCenterSec
  const maxSecFromNext =
    index < sorted.length - 1
      ? sorted[index + 1]!.centerNorm * durationSec - gapSec
      : maxCenterSec

  return {
    minSec: Math.max(minCenterSec, minSecFromPrev),
    maxSec: Math.min(maxCenterSec, maxSecFromNext),
  }
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

type CalloutDotSnap = { clientX: number; guideId: string }

function resolveCalloutDotSnap(
  clientX: number,
  trackLineEl: HTMLElement | null,
  lockedGuideId: string | null,
  guides: readonly CalloutGuide[],
): CalloutDotSnap | null {
  if (!trackLineEl) return null
  const rect = trackLineEl.getBoundingClientRect()
  const lineW = rect.width
  if (lineW <= 1e-6) return null

  if (lockedGuideId != null) {
    const lockedGuide = guides.find((guide) => guide.id === lockedGuideId)
    if (lockedGuide) {
      const centerX = calloutGuideCenterClientX(rect, lockedGuide.centerNorm, lineW)
      if (Math.abs(clientX - centerX) <= CALLOUT_SNAP_RELEASE_PX) {
        return { clientX: centerX, guideId: lockedGuideId }
      }
    }
  }

  let snap: CalloutDotSnap | null = null
  let nearestDist = CALLOUT_SNAP_CAPTURE_PX + 1

  for (const guide of guides) {
    const centerX = calloutGuideCenterClientX(rect, guide.centerNorm, lineW)
    const dist = Math.abs(clientX - centerX)
    if (dist <= CALLOUT_SNAP_CAPTURE_PX && dist < nearestDist) {
      nearestDist = dist
      snap = { clientX: centerX, guideId: guide.id }
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

export function VideoEditorView({ videoSrc, onDone, onSave, onDelete }: VideoEditorViewProps) {
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
  const snappedCalloutGuideIdRef = useRef<string | null>(null)
  /** Callout kept in focus after snap/nudge until the user scrubs off it. */
  const focusedCalloutGuideIdRef = useRef<string | null>(null)
  const pendingInitialPlayheadSeekRef = useRef(true)
  /** True while pointer-drag scrubbing that began on the playhead tip (keep col-resize cursor). */
  const [scrubFromPlayheadTip, setScrubFromPlayheadTip] = useState(false)
  const [timelineScrubbing, setTimelineScrubbing] = useState(false)
  const [calloutGuides, setCalloutGuides] = useState<CalloutGuide[]>(() => createSeedCalloutGuides())
  const calloutSeedsFixedRef = useRef(false)
  const calloutGuideIdRef = useRef(0)
  const [activeCalloutGuideId, setActiveCalloutGuideId] = useState<string | null>(null)
  const [visitedCalloutGuideIds, setVisitedCalloutGuideIds] = useState<Set<string>>(() => new Set())
  const [calloutTrackLineWidthPx, setCalloutTrackLineWidthPx] = useState(0)
  const [calloutSpeedMenuOpen, setCalloutSpeedMenuOpen] = useState(false)
  const calloutSpeedMenuRef = useRef<HTMLDivElement>(null)
  const [calloutSpeedByGuideId, setCalloutSpeedByGuideId] = useState<Record<string, CalloutSpeedId>>(() =>
    createDefaultCalloutSpeedMap(createSeedCalloutGuides()),
  )
  const [ttsClips, setTtsClips] = useState<TtsClip[]>([])
  const [focusedTtsClipId, setFocusedTtsClipId] = useState<string | null>(null)
  const ttsClipIdRef = useRef(0)
  const segmentPlayEndSecRef = useRef<number | null>(null)
  const calloutGuidesRef = useRef(calloutGuides)
  const timelineSegmentsRef = useRef<TimelineSegment[]>([])
  const [isVideoPlaying, setIsVideoPlaying] = useState(false)
  const [tourVoiceEnabled, setTourVoiceEnabled] = useState(true)
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
    (activeGuideId: string | null, playheadNorm: number) => {
      focusedCalloutGuideIdRef.current = activeGuideId

      const visited = new Set<string>()
      if (calloutTrackLineWidthPx > 1e-6 && duration > 0) {
        for (const guide of calloutGuides) {
          if (guide.centerNorm <= playheadNorm + 1e-6) {
            visited.add(guide.id)
          }
        }
      } else if (activeGuideId != null) {
        visited.add(activeGuideId)
      }

      setVisitedCalloutGuideIds(visited)
      setActiveCalloutGuideId(activeGuideId)
    },
    [calloutGuides, calloutTrackLineWidthPx, duration],
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
    if (calloutTrackLineWidthPx <= 1e-6 || calloutSeedsFixedRef.current) return
    calloutSeedsFixedRef.current = true
    setCalloutGuides((prev) => {
      const added = prev.filter((guide) => !guide.id.startsWith('callout-seed-'))
      const seeds = CALLOUT_MARKER_PCTS.map((pct, index) => ({
        id: `callout-seed-${index}`,
        centerNorm: calloutDotCenterNorm(pct, calloutTrackLineWidthPx),
      }))
      return [...seeds, ...added].sort((a, b) => a.centerNorm - b.centerNorm)
    })
  }, [calloutTrackLineWidthPx])

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
      const firstGuide = calloutGuides[0]
      if (!firstGuide) return false
      const t = firstGuide.centerNorm * duration
      video.currentTime = t
      setCurrentTime(t)
      syncCalloutDotStates(firstGuide.id, firstGuide.centerNorm)
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
  }, [duration, loadError, mediaSrc, syncCalloutDotStates, calloutGuides])

  const reloadVideoFile = useCallback(() => {
    setReloadToken((n) => n + 1)
    setLoadError(false)
    setDuration(0)
    setCurrentTime(0)
    setFilmstrip([])
    setFilmstripReady(false)
    setVideoIntrinsicSize(null)
    setActiveCalloutGuideId(null)
    setVisitedCalloutGuideIds(new Set())
    const seeds = createSeedCalloutGuides()
    setCalloutGuides(seeds)
    calloutSeedsFixedRef.current = false
    setCalloutSpeedMenuOpen(false)
    setCalloutSpeedByGuideId(createDefaultCalloutSpeedMap(seeds))
    focusedCalloutGuideIdRef.current = null
    snappedCalloutGuideIdRef.current = null
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

  const nudgePlayhead = useCallback(
    (delta: -1 | 1, stepSec = PLAYHEAD_NUDGE_STEP_SEC) => {
      if (loadError || duration <= 0) return

      const nextSec = Math.min(duration, Math.max(0, currentTime + stepSec * delta))
      if (Math.abs(nextSec - currentTime) <= 1e-6) return

      segmentPlayEndSecRef.current = null
      videoRef.current?.pause()

      const lineW =
        calloutTrackLineWidthPx > 1e-6
          ? calloutTrackLineWidthPx
          : (calloutTrackLineRef.current?.getBoundingClientRect().width ?? 0)

      const currentNorm = currentTime / duration
      const nextNorm = nextSec / duration
      const snappedGuide =
        lineW > 1e-6
          ? resolveCalloutGuideSnapForPlayheadNudge(
              nextNorm,
              currentNorm,
              calloutGuides,
              lineW,
            )
          : null

      if (snappedGuide) {
        const snapSec = snappedGuide.centerNorm * duration
        seekTo(snapSec)
        setCurrentTime(snapSec)
        syncCalloutDotStates(snappedGuide.id, snappedGuide.centerNorm)
        snappedCalloutGuideIdRef.current = snappedGuide.id
        focusedCalloutGuideIdRef.current = snappedGuide.id
        return
      }

      seekTo(nextSec)
      setCurrentTime(nextSec)
      snappedCalloutGuideIdRef.current = null
      syncCalloutDotStates(null, nextNorm)
    },
    [
      loadError,
      duration,
      currentTime,
      calloutTrackLineWidthPx,
      calloutGuides,
      seekTo,
      syncCalloutDotStates,
    ],
  )

  const nudgePlayheadBack = useCallback(() => {
    nudgePlayhead(-1)
  }, [nudgePlayhead])

  const nudgePlayheadForward = useCallback(() => {
    nudgePlayhead(1)
  }, [nudgePlayhead])

  const canNudgePlayheadBack = !loadError && duration > 0 && currentTime > 1e-6
  const canNudgePlayheadForward =
    !loadError && duration > 0 && currentTime < duration - 1e-6

  const nudgeActiveCallout = useCallback(
    (delta: -1 | 1) => {
      const guideId = activeCalloutGuideId ?? focusedCalloutGuideIdRef.current
      if (guideId == null || duration <= 0) return

      const guide = calloutGuides.find((entry) => entry.id === guideId)
      if (!guide) return

      const lineEl = calloutTrackLineRef.current
      if (!lineEl) return
      const lineW = lineEl.getBoundingClientRect().width
      if (lineW <= 1e-6) return

      const { minSec, maxSec } = getCalloutNudgeBoundsSec(guideId, calloutGuides, lineW, duration)
      const currentSec = guide.centerNorm * duration
      const nextSec = Math.min(maxSec, Math.max(minSec, currentSec + CALLOUT_NUDGE_STEP_SEC * delta))
      if (Math.abs(nextSec - currentSec) <= 1e-6) return

      const nextNorm = nextSec / duration
      setCalloutGuides((prev) =>
        prev.map((entry) =>
          entry.id === guideId ? { ...entry, centerNorm: nextNorm } : entry,
        ),
      )

      setCurrentTime(nextSec)
      seekTo(nextSec)
      syncCalloutDotStates(guideId, nextNorm)
      snappedCalloutGuideIdRef.current = guideId
      focusedCalloutGuideIdRef.current = guideId
    },
    [activeCalloutGuideId, calloutGuides, duration, seekTo, syncCalloutDotStates],
  )

  const addCalloutGuide = useCallback(() => {
    if (loadError || duration <= 0 || calloutTrackLineWidthPx <= 1e-6) return
    const playheadNormAtAdd = currentTime / duration
    if (
      !canPlaceCalloutGuideAtPlayhead(
        playheadNormAtAdd,
        calloutGuides,
        calloutTrackLineWidthPx,
        duration,
      )
    ) {
      return
    }
    const centerNorm = clampCalloutCenterNorm(playheadNormAtAdd, calloutTrackLineWidthPx)
    const id = `callout-${calloutGuideIdRef.current++}`
    setCalloutGuides((prev) =>
      [...prev, { id, centerNorm }].sort((a, b) => a.centerNorm - b.centerNorm),
    )
    setCalloutSpeedByGuideId((prev) => ({ ...prev, [id]: '1' }))
    setCurrentTime(centerNorm * duration)
    seekTo(centerNorm * duration)
    syncCalloutDotStates(id, centerNorm)
    snappedCalloutGuideIdRef.current = id
    focusedCalloutGuideIdRef.current = id
  }, [loadError, duration, calloutTrackLineWidthPx, currentTime, calloutGuides, ttsClips, seekTo, syncCalloutDotStates])

  useEffect(() => {
    if (duration <= 0 || calloutTrackLineWidthPx <= 1e-6) return
    const guideId = focusedCalloutGuideIdRef.current
    if (guideId == null) return
    const guide = calloutGuides.find((entry) => entry.id === guideId)
    if (!guide) return
    syncCalloutDotStates(guideId, guide.centerNorm)
  }, [calloutGuides, calloutTrackLineWidthPx, duration, syncCalloutDotStates])

  useEffect(() => {
    setCalloutSpeedMenuOpen(false)
  }, [activeCalloutGuideId])

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
    if (focusedTtsClipId == null) return

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Element)) return
      if (target.closest('.video-editor__timeline-tts-clip') != null) return
      if (target.closest('.video-editor__tts-dialogue-layer') != null) return
      setFocusedTtsClipId(null)
    }

    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [focusedTtsClipId])

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
      const segmentEnd = segmentPlayEndSecRef.current
      if (segmentEnd != null && t >= segmentEnd - 1e-3 && !video.paused) {
        video.pause()
        video.currentTime = segmentEnd
        setCurrentTime(segmentEnd)
        segmentPlayEndSecRef.current = null
        const activeGuideId = getActiveGuideIdWhenSegmentStops(
          timelineSegmentsRef.current,
          segmentEnd,
          d,
          calloutGuidesRef.current,
        )
        syncCalloutDotStates(activeGuideId, segmentEnd / d)
        snappedCalloutGuideIdRef.current = activeGuideId
        return
      }
      if (segmentEnd != null && !video.paused) {
        const playingSegment = findTimelineSegmentByEndSec(timelineSegmentsRef.current, segmentEnd)
        syncCalloutDotStates(playingSegment?.guideId ?? focusedCalloutGuideIdRef.current, t / d)
        return
      }
      syncCalloutDotStates(focusedCalloutGuideIdRef.current, t / d)
    }
    const onPlay = () => setIsVideoPlaying(true)
    const onPause = () => {
      setIsVideoPlaying(false)
      segmentPlayEndSecRef.current = null
    }
    const onError = () => setLoadError(true)

    video.addEventListener('loadedmetadata', onLoadedMeta)
    video.addEventListener('timeupdate', onTimeUpdate)
    video.addEventListener('play', onPlay)
    video.addEventListener('pause', onPause)
    video.addEventListener('error', onError)

    return () => {
      video.removeEventListener('loadedmetadata', onLoadedMeta)
      video.removeEventListener('timeupdate', onTimeUpdate)
      video.removeEventListener('play', onPlay)
      video.removeEventListener('pause', onPause)
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
    const w = 44
    const h = 25
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
            snappedCalloutGuideIdRef.current,
            calloutGuides,
          )
        : null

      const rangeEl = playheadRangeRef.current
      let t: number

      if (snap != null) {
        const snappedGuide = calloutGuides.find((entry) => entry.id === snap.guideId)
        if (!snappedGuide) return
        seekTo(snappedGuide.centerNorm * d)
        syncCalloutDotStates(snap.guideId, snappedGuide.centerNorm)
        snappedCalloutGuideIdRef.current = snap.guideId
        scrubPrevClientXRef.current = clientX
        return
      }

      snappedCalloutGuideIdRef.current = null

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
      segmentPlayEndSecRef.current = null
      syncCalloutDotStates(null, t / d)
      scrubPrevClientXRef.current = clientX
    },
    [calloutGuides, duration, seekTo, syncCalloutDotStates],
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
    snappedCalloutGuideIdRef.current = null
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
    snappedCalloutGuideIdRef.current = null
    setTimelineScrubbing(false)
    setScrubFromPlayheadTip(false)
  }

  const onTimelinePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || loadError || duration <= 0) return
    const target = e.target
    if (
      !(target instanceof Element && target.closest('.video-editor__timeline-tts-clip') != null)
    ) {
      setFocusedTtsClipId(null)
    }
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

  const playheadNorm = duration > 0 ? currentTime / duration : 0

  const canAddCalloutGuide = useMemo(
    () =>
      !loadError &&
      duration > 0 &&
      calloutTrackLineWidthPx > 1e-6 &&
      canPlaceCalloutGuideAtPlayhead(
        playheadNorm,
        calloutGuides,
        calloutTrackLineWidthPx,
        duration,
      ),
    [loadError, duration, calloutTrackLineWidthPx, playheadNorm, calloutGuides],
  )

  const canAddTtsClip = useMemo(
    () =>
      !loadError &&
      duration > 0 &&
      calloutTrackLineWidthPx > 1e-6 &&
      canPlaceTtsClipAtPlayhead(
        playheadNorm,
        ttsClips,
        calloutTrackLineWidthPx,
        duration,
      ),
    [loadError, duration, calloutTrackLineWidthPx, playheadNorm, ttsClips],
  )

  const timelineSegments = useMemo(
    () => buildTimelineSegments(calloutGuides, duration),
    [calloutGuides, duration],
  )

  calloutGuidesRef.current = calloutGuides
  timelineSegmentsRef.current = timelineSegments

  const currentSegmentIndex = useMemo(
    () => findSegmentIndex(timelineSegments, currentTime),
    [timelineSegments, currentTime],
  )

  const canSkipSegmentBack = currentSegmentIndex > 0
  const canSkipSegmentForward =
    timelineSegments.length > 0 && currentSegmentIndex < timelineSegments.length - 1

  const goToSegmentStart = useCallback(
    (segmentIndex: number) => {
      if (duration <= 0) return
      const segment = timelineSegments[segmentIndex]
      if (!segment) return

      const video = videoRef.current
      segmentPlayEndSecRef.current = null
      video?.pause()

      seekTo(segment.startSec)
      setCurrentTime(segment.startSec)
      const norm = segment.startSec / duration
      if (segment.guideId) {
        syncCalloutDotStates(segment.guideId, norm)
        snappedCalloutGuideIdRef.current = segment.guideId
      } else {
        syncCalloutDotStates(null, norm)
        snappedCalloutGuideIdRef.current = null
      }
    },
    [duration, timelineSegments, seekTo, syncCalloutDotStates],
  )

  const skipToPreviousSegment = useCallback(() => {
    if (!canSkipSegmentBack) return
    goToSegmentStart(currentSegmentIndex - 1)
  }, [canSkipSegmentBack, currentSegmentIndex, goToSegmentStart])

  const skipToNextSegment = useCallback(() => {
    if (!canSkipSegmentForward) return
    goToSegmentStart(currentSegmentIndex + 1)
  }, [canSkipSegmentForward, currentSegmentIndex, goToSegmentStart])

  const toggleSegmentPlayback = useCallback(() => {
    const video = videoRef.current
    if (!video || loadError || duration <= 0 || timelineSegments.length === 0) return

    if (!video.paused) {
      video.pause()
      segmentPlayEndSecRef.current = null
      return
    }

    const segment = timelineSegments[currentSegmentIndex]
    if (!segment) return

    segmentPlayEndSecRef.current = segment.endSec
    if (video.currentTime < segment.startSec || video.currentTime >= segment.endSec - 1e-3) {
      seekTo(segment.startSec)
      setCurrentTime(segment.startSec)
    }

    const norm = Math.min(segment.endSec, Math.max(segment.startSec, video.currentTime)) / duration
    if (segment.guideId) {
      syncCalloutDotStates(segment.guideId, norm)
      snappedCalloutGuideIdRef.current = segment.guideId
    } else {
      syncCalloutDotStates(null, norm)
      snappedCalloutGuideIdRef.current = null
    }

    void video.play()
  }, [
    loadError,
    duration,
    timelineSegments,
    currentSegmentIndex,
    seekTo,
    syncCalloutDotStates,
  ])

  const addTtsClip = useCallback(() => {
    if (loadError || duration <= 0 || calloutTrackLineWidthPx <= 1e-6) return
    const playheadNormAtAdd = currentTime / duration
    if (
      !canPlaceTtsClipAtPlayhead(
        playheadNormAtAdd,
        ttsClips,
        calloutTrackLineWidthPx,
        duration,
      )
    ) {
      return
    }
    const centerNorm = ttsClipCenterNormFromPurpleStart(
      playheadNormAtAdd,
      calloutTrackLineWidthPx,
      TTS_CLIP_CORE_BASE_W_PX,
    )
    const id = `tts-${ttsClipIdRef.current++}`
    setTtsClips((prev) => [...prev, { id, centerNorm, expanded: false }])
    setFocusedTtsClipId(id)
    seekTo(playheadNormAtAdd * duration)
    setCurrentTime(playheadNormAtAdd * duration)
  }, [loadError, duration, calloutTrackLineWidthPx, currentTime, ttsClips, seekTo])

  const getTtsClipCoreWidthForId = useCallback(
    (clipId: string) => {
      const clip = ttsClips.find((entry) => entry.id === clipId)
      return ttsClipCoreWidthPx(clip?.expanded ?? false)
    },
    [ttsClips],
  )

  const focusTtsClip = useCallback(
    (clip: TtsClip) => {
      setFocusedTtsClipId(clip.id)
      if (duration <= 0 || calloutTrackLineWidthPx <= 1e-6) return
      const coreWPx = ttsClipCoreWidthPx(clip.expanded)
      const startNorm = ttsClipPurpleStartNorm(clip.centerNorm, calloutTrackLineWidthPx, coreWPx)
      seekTo(startNorm * duration)
    },
    [duration, calloutTrackLineWidthPx, seekTo],
  )

  const toggleTtsDialogueBubbleSize = useCallback(() => {
    if (focusedTtsClipId == null || duration <= 0 || calloutTrackLineWidthPx <= 1e-6) return

    const clip = ttsClips.find((entry) => entry.id === focusedTtsClipId)
    if (!clip) return

    const nextExpanded = !clip.expanded
    const currentCoreWPx = ttsClipCoreWidthPx(clip.expanded)
    const nextCoreWPx = ttsClipCoreWidthPx(nextExpanded)
    const purpleStartNorm = ttsClipPurpleStartNorm(
      clip.centerNorm,
      calloutTrackLineWidthPx,
      currentCoreWPx,
    )
    const nextCenterNorm = ttsClipCenterNormFromPurpleStart(
      purpleStartNorm,
      calloutTrackLineWidthPx,
      nextCoreWPx,
    )

    setTtsClips((prev) =>
      prev.map((entry) =>
        entry.id === focusedTtsClipId
          ? { ...entry, expanded: nextExpanded, centerNorm: nextCenterNorm }
          : entry,
      ),
    )

    const startNorm = ttsClipPurpleStartNorm(nextCenterNorm, calloutTrackLineWidthPx, nextCoreWPx)
    setCurrentTime(startNorm * duration)
    seekTo(startNorm * duration)
  }, [focusedTtsClipId, ttsClips, duration, calloutTrackLineWidthPx, seekTo])

  const nudgeFocusedTtsClip = useCallback(
    (delta: -1 | 1) => {
      if (focusedTtsClipId == null || duration <= 0 || calloutTrackLineWidthPx <= 1e-6) return

      const clip = ttsClips.find((entry) => entry.id === focusedTtsClipId)
      if (!clip) return

      const coreWPx = getTtsClipCoreWidthForId(focusedTtsClipId)
      const { minSec, maxSec } = getTtsClipNudgeBoundsSec(
        focusedTtsClipId,
        ttsClips,
        calloutTrackLineWidthPx,
        duration,
        getTtsClipCoreWidthForId,
      )
      const currentSec = clip.centerNorm * duration
      const nextSec = Math.min(maxSec, Math.max(minSec, currentSec + CALLOUT_NUDGE_STEP_SEC * delta))
      if (Math.abs(nextSec - currentSec) <= 1e-6) return

      const nextCenterNorm = nextSec / duration
      setTtsClips((prev) =>
        prev.map((entry) =>
          entry.id === focusedTtsClipId ? { ...entry, centerNorm: nextCenterNorm } : entry,
        ),
      )

      const startNorm = ttsClipPurpleStartNorm(nextCenterNorm, calloutTrackLineWidthPx, coreWPx)
      setCurrentTime(startNorm * duration)
      seekTo(startNorm * duration)
    },
    [focusedTtsClipId, duration, calloutTrackLineWidthPx, ttsClips, getTtsClipCoreWidthForId, seekTo],
  )

  const activeTourCallout = useMemo(() => {
    if (activeCalloutGuideId == null) return null
    const guideIndex = calloutGuides.findIndex((guide) => guide.id === activeCalloutGuideId)
    return buildTourCalloutForIndex(guideIndex >= 0 ? guideIndex : 0)
  }, [activeCalloutGuideId, calloutGuides])

  const showTtsMicBadge = useMemo(() => {
    if (focusedTtsClipId != null) return false
    if (duration <= 0 || calloutTrackLineWidthPx <= 1e-6 || ttsClips.length === 0) return false
    const playheadNorm = Math.min(1, Math.max(0, currentTime / duration))
    return ttsClips.some((clip) =>
      isPlayheadOverTtsClip(
        playheadNorm,
        clip.centerNorm,
        calloutTrackLineWidthPx,
        ttsClipCoreWidthPx(clip.expanded),
      ),
    )
  }, [focusedTtsClipId, duration, calloutTrackLineWidthPx, ttsClips, currentTime])

  const openTtsDialogueFromMicBadge = useCallback(() => {
    if (duration <= 0 || calloutTrackLineWidthPx <= 1e-6) return
    const playheadNorm = Math.min(1, Math.max(0, currentTime / duration))
    const clip = ttsClips.find((entry) =>
      isPlayheadOverTtsClip(
        playheadNorm,
        entry.centerNorm,
        calloutTrackLineWidthPx,
        ttsClipCoreWidthPx(entry.expanded),
      ),
    )
    if (clip) focusTtsClip(clip)
  }, [duration, calloutTrackLineWidthPx, ttsClips, currentTime, focusTtsClip])

  const focusedTtsNudgeState = useMemo(() => {
    if (focusedTtsClipId == null || duration <= 0 || calloutTrackLineWidthPx <= 1e-6) {
      return { canNudgeLeft: false, canNudgeRight: false }
    }

    const clip = ttsClips.find((entry) => entry.id === focusedTtsClipId)
    if (!clip) return { canNudgeLeft: false, canNudgeRight: false }

    const { minSec, maxSec } = getTtsClipNudgeBoundsSec(
      focusedTtsClipId,
      ttsClips,
      calloutTrackLineWidthPx,
      duration,
      getTtsClipCoreWidthForId,
    )
    const currentSec = clip.centerNorm * duration

    return {
      canNudgeLeft: currentSec > minSec + 1e-6,
      canNudgeRight: currentSec < maxSec - 1e-6,
    }
  }, [focusedTtsClipId, duration, calloutTrackLineWidthPx, ttsClips, getTtsClipCoreWidthForId])

  const activeCalloutNudgeState = useMemo(() => {
    if (activeCalloutGuideId == null || duration <= 0 || calloutTrackLineWidthPx <= 1e-6) {
      return {
        canNudgeLeft: false,
        canNudgeRight: false,
        focusChromeStyle: undefined as CSSProperties | undefined,
      }
    }

    const guide = calloutGuides.find((entry) => entry.id === activeCalloutGuideId)
    if (!guide) {
      return {
        canNudgeLeft: false,
        canNudgeRight: false,
        focusChromeStyle: undefined as CSSProperties | undefined,
      }
    }

    const { minSec, maxSec } = getCalloutNudgeBoundsSec(
      activeCalloutGuideId,
      calloutGuides,
      calloutTrackLineWidthPx,
      duration,
    )
    const currentSec = guide.centerNorm * duration

    return {
      canNudgeLeft: currentSec > minSec + 1e-6,
      canNudgeRight: currentSec < maxSec - 1e-6,
      focusChromeStyle: calloutFocusChromeAnchorStyleFromNorm(
        guide.centerNorm,
        calloutTrackLineWidthPx,
      ),
    }
  }, [activeCalloutGuideId, calloutGuides, calloutTrackLineWidthPx, duration])

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
          <div className="video-editor__top-actions-history" role="group" aria-label="History">
            <button
              type="button"
              className="video-editor__top-history-btn"
              aria-label="Undo"
              aria-disabled="true"
            >
              <img
                src={`${import.meta.env.BASE_URL}images/undo.png`}
                alt=""
                className="video-editor__top-history-btn-icon"
                width={22}
                height={22}
                aria-hidden
              />
            </button>
            <button
              type="button"
              className="video-editor__top-history-btn"
              aria-label="Redo"
              aria-disabled="true"
            >
              <img
                src={`${import.meta.env.BASE_URL}images/redo.png`}
                alt=""
                className="video-editor__top-history-btn-icon"
                width={22}
                height={22}
                aria-hidden
              />
            </button>
          </div>
          <span className="video-editor__top-actions-pipe" aria-hidden />
          <div className="video-editor__top-actions-primary">
            <button
              type="button"
              className="video-editor__duplicate-session"
              onClick={onDelete}
              aria-label="Duplicate recording"
            >
              <ContentCopyOutlinedIcon className="video-editor__duplicate-session-icon" fontSize="small" aria-hidden />
              Duplicate
            </button>
            <button type="button" className="video-editor__preview-btn" onClick={onDone}>
              Preview
              <VisibilityOutlinedIcon className="video-editor__preview-btn-icon" fontSize="small" aria-hidden />
            </button>
            <button type="button" className="video-editor__save-btn" onClick={onSave}>
              Save
            </button>
          </div>
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
                    key={`tour-callout-${activeCalloutGuideId}`}
                    className={
                      'video-editor__tour-callout-layer' +
                      (focusedTtsClipId != null ? ' video-editor__tour-callout-layer--tts-dimmed' : '')
                    }
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
                {showTtsMicBadge ? (
                  <div className="video-editor__tts-mic-badge-layer">
                    <button
                      type="button"
                      className="video-editor__tts-mic-badge-hit"
                      aria-label="Open voiceover editor"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation()
                        openTtsDialogueFromMicBadge()
                      }}
                    >
                      <img
                        className="video-editor__tts-mic-badge"
                        src={`${import.meta.env.BASE_URL}images/tts-mic-badge.png`}
                        alt=""
                        draggable={false}
                      />
                    </button>
                  </div>
                ) : null}
                {focusedTtsClipId != null ? (
                  <div
                    className="video-editor__tts-dialogue-layer"
                    role="dialog"
                    aria-label="Voiceover editor"
                  >
                    <button
                      type="button"
                      className="video-editor__tts-dialogue-hit"
                      aria-label="Extend voiceover clip on timeline"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation()
                        toggleTtsDialogueBubbleSize()
                      }}
                    >
                      <img
                        className="video-editor__tts-dialogue"
                        src={`${import.meta.env.BASE_URL}images/tts-dialogue.png`}
                        alt=""
                        draggable={false}
                      />
                    </button>
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
          <div className="video-editor__timeline-toolbar-start">
            <div className="video-editor__timeline-toolbar-voice">
              <RecordVoiceOverRoundedIcon
                className="video-editor__timeline-toolbar-voice-icon"
                aria-hidden
              />
              <Tooltip title="Tour voice" placement="top" disableInteractive enterDelay={400}>
                <button
                  type="button"
                  className="video-editor__timeline-toolbar-voice-toggle"
                  role="switch"
                  aria-pressed={tourVoiceEnabled}
                  aria-label="Tour voice"
                  onClick={() => setTourVoiceEnabled((enabled) => !enabled)}
                >
                  <span className="video-editor__timeline-toolbar-voice-toggle-track" aria-hidden>
                    <span className="video-editor__timeline-toolbar-voice-toggle-handle">
                      {tourVoiceEnabled ? (
                        <CheckRoundedIcon className="video-editor__timeline-toolbar-voice-toggle-check" aria-hidden />
                      ) : null}
                    </span>
                  </span>
                </button>
              </Tooltip>
            </div>
            <span className="video-editor__timeline-toolbar-separator" aria-hidden />
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
          </div>
          <div className="video-editor__timeline-toolbar-center">
            <div className="video-editor__timeline-toolbar-transport-anchor">
              <div className="video-editor__timeline-toolbar-transport-tube">
                <div
                  className="video-editor__timeline-toolbar-transport"
                  role="group"
                  aria-label="Timeline playback and editing"
                >
              <Tooltip
                title={`Add callout at ${formatRulerLabel(currentTime)}`}
                placement="top"
                disableInteractive
                enterDelay={400}
              >
                <span className="video-editor__timeline-toolbar-transport-tooltip-wrap">
                  <button
                    type="button"
                    className="video-editor__timeline-toolbar-btn"
                    disabled={!canAddCalloutGuide}
                    onClick={addCalloutGuide}
                  >
                    <ChatAddOnOutlined className="video-editor__timeline-toolbar-btn-icon" fontSize="small" aria-hidden />
                    Add callout
                  </button>
                </span>
              </Tooltip>
              <span className="video-editor__timeline-toolbar-separator" aria-hidden />
              <Tooltip title="Previous segment" placement="top" disableInteractive enterDelay={400}>
                <span className="video-editor__timeline-toolbar-transport-tooltip-wrap">
                  <button
                    type="button"
                    className="video-editor__timeline-toolbar-transport-btn"
                    aria-label="Previous segment"
                    disabled={loadError || duration <= 0 || !canSkipSegmentBack}
                    onClick={skipToPreviousSegment}
                  >
                    <SkipPreviousRoundedIcon fontSize="small" aria-hidden />
                  </button>
                </span>
              </Tooltip>
              <Tooltip title="Rewind playhead" placement="top" disableInteractive enterDelay={400}>
                <span className="video-editor__timeline-toolbar-transport-tooltip-wrap">
                  <button
                    type="button"
                    className="video-editor__timeline-toolbar-transport-btn"
                    aria-label="Rewind playhead"
                    disabled={!canNudgePlayheadBack}
                    onClick={nudgePlayheadBack}
                  >
                    <FastRewindRoundedIcon fontSize="small" aria-hidden />
                  </button>
                </span>
              </Tooltip>
              <span
                className="video-editor__timeline-toolbar-transport-play-cluster"
                aria-label={`${formatRulerLabel(currentTime)} of ${formatRulerLabel(duration)}`}
              >
                <span
                  className="video-editor__timeline-toolbar-transport-time video-editor__timeline-toolbar-transport-time--current"
                  aria-hidden
                >
                  {formatRulerLabel(currentTime)}
                </span>
                <Tooltip
                  title={isVideoPlaying ? 'Pause segment' : 'Play segment'}
                  placement="top"
                  disableInteractive
                  enterDelay={400}
                >
                  <span className="video-editor__timeline-toolbar-transport-tooltip-wrap">
                    <button
                      type="button"
                      className={
                        'video-editor__timeline-toolbar-transport-btn video-editor__timeline-toolbar-transport-btn--play'
                      }
                      aria-label={isVideoPlaying ? 'Pause segment' : 'Play segment'}
                      disabled={loadError || duration <= 0 || timelineSegments.length === 0}
                      onClick={toggleSegmentPlayback}
                    >
                      {isVideoPlaying ? (
                        <PauseRoundedIcon fontSize="small" aria-hidden />
                      ) : (
                        <PlayArrowRoundedIcon fontSize="small" aria-hidden />
                      )}
                    </button>
                  </span>
                </Tooltip>
                <span
                  className="video-editor__timeline-toolbar-transport-time video-editor__timeline-toolbar-transport-time--total"
                  aria-hidden
                >
                  {formatRulerLabel(duration)}
                </span>
              </span>
              <Tooltip title="Fast forward playhead" placement="top" disableInteractive enterDelay={400}>
                <span className="video-editor__timeline-toolbar-transport-tooltip-wrap">
                  <button
                    type="button"
                    className="video-editor__timeline-toolbar-transport-btn"
                    aria-label="Fast forward playhead"
                    disabled={!canNudgePlayheadForward}
                    onClick={nudgePlayheadForward}
                  >
                    <FastForwardRoundedIcon fontSize="small" aria-hidden />
                  </button>
                </span>
              </Tooltip>
              <Tooltip title="Next segment" placement="top" disableInteractive enterDelay={400}>
                <span className="video-editor__timeline-toolbar-transport-tooltip-wrap">
                  <button
                    type="button"
                    className="video-editor__timeline-toolbar-transport-btn"
                    aria-label="Next segment"
                    disabled={loadError || duration <= 0 || !canSkipSegmentForward}
                    onClick={skipToNextSegment}
                  >
                    <SkipNextRoundedIcon fontSize="small" aria-hidden />
                  </button>
                </span>
              </Tooltip>
              <span className="video-editor__timeline-toolbar-separator" aria-hidden />
              <Tooltip
                title={`Add voiceover at ${formatRulerLabel(currentTime)}`}
                placement="top"
                disableInteractive
                enterDelay={400}
              >
                <span className="video-editor__timeline-toolbar-transport-tooltip-wrap">
                  <button
                    type="button"
                    className="video-editor__timeline-toolbar-btn"
                    disabled={!canAddTtsClip}
                    onClick={addTtsClip}
                  >
                    <MicNoneRoundedIcon className="video-editor__timeline-toolbar-btn-icon" fontSize="small" aria-hidden />
                    Add voiceover
                  </button>
                </span>
              </Tooltip>
                </div>
              </div>
            </div>
          </div>
          <div className="video-editor__timeline-toolbar-end">
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
                  const step = e.shiftKey ? 5 : PLAYHEAD_NUDGE_STEP_SEC
                  if (e.key === 'ArrowLeft') {
                    e.preventDefault()
                    nudgePlayhead(-1, step)
                  } else if (e.key === 'ArrowRight') {
                    e.preventDefault()
                    nudgePlayhead(1, step)
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
                          (activeCalloutGuideId != null
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
                            aria-label="callouts"
                          >
                            <div
                              className="video-editor__timeline-callout-line-fill"
                              style={{ width: `${playheadPct}%` }}
                              aria-hidden
                            />
                            <div
                              className={
                                'video-editor__timeline-callout-focus-chrome' +
                                (activeCalloutGuideId != null
                                  ? ' video-editor__timeline-callout-focus-chrome--visible'
                                  : '')
                              }
                              style={
                                activeCalloutGuideId != null
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
                                          activeCalloutGuideId == null ||
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
                                          activeCalloutGuideId == null ||
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
                            {calloutGuides.map((guide) => {
                              const dotAnchorStyle =
                                calloutTrackLineWidthPx > 1e-6 && duration > 0
                                  ? calloutFocusChromeAnchorStyleFromNorm(
                                      guide.centerNorm,
                                      calloutTrackLineWidthPx,
                                    )
                                  : undefined
                              const isActive = activeCalloutGuideId === guide.id
                              const selectedSpeed = calloutSpeedByGuideId[guide.id] ?? '1'
                              const isSkipped = selectedSpeed === 'skip'
                              const selectedSpeedIndex = calloutSpeedIndex(selectedSpeed)
                              const canCycleSpeedUp =
                                selectedSpeedIndex < CALLOUT_SPEED_OPTIONS.length - 1
                              const canCycleSpeedDown = selectedSpeedIndex > 0
                              return (
                              <span
                                key={guide.id}
                                className={
                                  'video-editor__timeline-callout-dot' +
                                  (isActive
                                    ? ' video-editor__timeline-callout-dot--active'
                                    : visitedCalloutGuideIds.has(guide.id)
                                      ? ' video-editor__timeline-callout-dot--visited'
                                      : '') +
                                  (isSkipped ? ' video-editor__timeline-callout-dot--skip' : '')
                                }
                                style={dotAnchorStyle}
                                aria-hidden={!isActive}
                              >
                                {!isActive && isSkipped ? (
                                  <VisibilityOffOutlinedIcon
                                    className="video-editor__timeline-callout-dot-skip-icon"
                                    aria-hidden
                                  />
                                ) : null}
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
                                        aria-label="callout speed"
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
                                                setCalloutSpeedByGuideId((prev) => ({
                                                  ...prev,
                                                  [guide.id]: option.id,
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
                                      <button
                                        type="button"
                                        className="video-editor__timeline-callout-focus-step-btn video-editor__timeline-callout-focus-step-btn--up"
                                        aria-label="Faster callout speed"
                                        disabled={!canCycleSpeedUp}
                                        onPointerDown={(e) => e.stopPropagation()}
                                        onClick={(e) => {
                                          e.stopPropagation()
                                          setCalloutSpeedMenuOpen(false)
                                          setCalloutSpeedByGuideId((prev) => ({
                                            ...prev,
                                            [guide.id]: cycleCalloutSpeed(selectedSpeed, 1),
                                          }))
                                        }}
                                      >
                                        <ArrowDropUpIcon
                                          className="video-editor__timeline-callout-focus-step-icon"
                                          fontSize="inherit"
                                          aria-hidden
                                        />
                                      </button>
                                      <button
                                        type="button"
                                        className="video-editor__timeline-callout-focus-label-btn"
                                        aria-label="callout speed menu"
                                        aria-expanded={calloutSpeedMenuOpen}
                                        aria-haspopup="menu"
                                        onPointerDown={(e) => e.stopPropagation()}
                                        onClick={(e) => {
                                          e.stopPropagation()
                                          setCalloutSpeedMenuOpen((open) => !open)
                                        }}
                                      >
                                        {isSkipped ? (
                                          <VisibilityOffOutlinedIcon
                                            className="video-editor__timeline-callout-focus-skip-icon"
                                            aria-hidden
                                          />
                                        ) : (
                                          <span className="video-editor__timeline-callout-focus-label">
                                            {calloutSpeedDisplay(selectedSpeed)}
                                          </span>
                                        )}
                                      </button>
                                      <button
                                        type="button"
                                        className="video-editor__timeline-callout-focus-step-btn video-editor__timeline-callout-focus-step-btn--down"
                                        aria-label="Slower callout speed"
                                        disabled={!canCycleSpeedDown}
                                        onPointerDown={(e) => e.stopPropagation()}
                                        onClick={(e) => {
                                          e.stopPropagation()
                                          setCalloutSpeedMenuOpen(false)
                                          setCalloutSpeedByGuideId((prev) => ({
                                            ...prev,
                                            [guide.id]: cycleCalloutSpeed(selectedSpeed, -1),
                                          }))
                                        }}
                                      >
                                        <ArrowDropDownIcon
                                          className="video-editor__timeline-callout-focus-step-icon"
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
                      <div
                        className={
                          'video-editor__timeline-track video-editor__timeline-track--tts' +
                          (focusedTtsClipId != null ? ' video-editor__timeline-track--tts-focused' : '')
                        }
                      >
                        <div className="video-editor__timeline-track-inner">
                          <span className="video-editor__timeline-track-icon" aria-hidden>
                            <MicNoneRoundedIcon className="video-editor__timeline-track-icon-svg" fontSize="small" />
                          </span>
                          <div
                            className={
                              'video-editor__timeline-track-line video-editor__timeline-track-line--tts' +
                              (ttsClips.length > 0 ? ' video-editor__timeline-track-line--tts-active' : '')
                            }
                            aria-label="Voiceover"
                          >
                            <button
                              type="button"
                              className="video-editor__timeline-tts-placeholder"
                              disabled={!canAddTtsClip}
                              onPointerDown={(e) => e.stopPropagation()}
                              onClick={(e) => {
                                e.stopPropagation()
                                addTtsClip()
                              }}
                            >
                              Add voiceover
                            </button>
                            {ttsClips.map((clip) => (
                              <div
                                key={clip.id}
                                className={
                                  'video-editor__timeline-tts-clip' +
                                  (clip.expanded ? ' video-editor__timeline-tts-clip--expanded' : '') +
                                  (focusedTtsClipId === clip.id
                                    ? ' video-editor__timeline-tts-clip--focused'
                                    : '')
                                }
                                style={{ left: `${clip.centerNorm * 100}%` }}
                                role="group"
                                aria-label="Voiceover clip"
                                onPointerDown={(e) => {
                                  e.stopPropagation()
                                  focusTtsClip(clip)
                                }}
                              >
                                <div className="video-editor__timeline-tts-clip-wing video-editor__timeline-tts-clip-wing--left">
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
                                          focusedTtsClipId !== clip.id || !focusedTtsNudgeState.canNudgeLeft
                                        }
                                        onPointerDown={(e) => e.stopPropagation()}
                                        onClick={(e) => {
                                          e.stopPropagation()
                                          nudgeFocusedTtsClip(-1)
                                        }}
                                      >
                                        <ChevronLeftRoundedIcon fontSize="small" aria-hidden />
                                      </button>
                                    </span>
                                  </Tooltip>
                                </div>
                                <span className="video-editor__timeline-tts-clip-core">
                                  <span className="video-editor__timeline-tts-clip-wave" aria-hidden>
                                    {Array.from({ length: ttsWaveBarCount(clip.expanded) }, (_, barIndex) => (
                                      <span
                                        key={barIndex}
                                        style={{
                                          height: `${TTS_WAVE_BAR_HEIGHTS_PX[barIndex % TTS_WAVE_BAR_COUNT]}px`,
                                        }}
                                      />
                                    ))}
                                  </span>
                                </span>
                                <div className="video-editor__timeline-tts-clip-wing video-editor__timeline-tts-clip-wing--right">
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
                                          focusedTtsClipId !== clip.id || !focusedTtsNudgeState.canNudgeRight
                                        }
                                        onPointerDown={(e) => e.stopPropagation()}
                                        onClick={(e) => {
                                          e.stopPropagation()
                                          nudgeFocusedTtsClip(1)
                                        }}
                                      >
                                        <ChevronRightRoundedIcon fontSize="small" aria-hidden />
                                      </button>
                                    </span>
                                  </Tooltip>
                                </div>
                              </div>
                            ))}
                          </div>
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
