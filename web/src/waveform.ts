type AudioContextWindow = Window & {
  webkitAudioContext?: typeof AudioContext
}

type CanvasMargins = {
  left: number
  right: number
  top: number
  bottom: number
}

const PLOT_MARGINS: CanvasMargins = {
  left: 36,
  right: 10,
  top: 8,
  bottom: 22,
}

export type DecodedAudio = {
  samples: Float32Array
  sampleRate: number
  durationSec: number
}

function createAudioContext(): AudioContext {
  const AudioContextClass =
    window.AudioContext || (window as AudioContextWindow).webkitAudioContext
  if (!AudioContextClass) {
    throw new Error('AudioContext is not supported.')
  }
  return new AudioContextClass()
}

function getCanvasCssSize(canvas: HTMLCanvasElement): { width: number; height: number } {
  const attrWidth = Number(canvas.getAttribute('width')) || canvas.width || 1
  const attrHeight = Number(canvas.getAttribute('height')) || canvas.height || 1
  const width = canvas.clientWidth || attrWidth
  const height = canvas.clientHeight || attrHeight
  return {
    width: Math.max(1, Math.floor(width)),
    height: Math.max(1, Math.floor(height)),
  }
}

function prepareCanvas(canvas: HTMLCanvasElement): {
  context: CanvasRenderingContext2D
  width: number
  height: number
} {
  const context = canvas.getContext('2d')
  if (!context) {
    throw new Error('Canvas 2D context is not available.')
  }

  const { width, height } = getCanvasCssSize(canvas)
  const dpr = Math.max(1, window.devicePixelRatio || 1)
  const internalWidth = Math.max(1, Math.floor(width * dpr))
  const internalHeight = Math.max(1, Math.floor(height * dpr))

  if (canvas.width !== internalWidth || canvas.height !== internalHeight) {
    canvas.width = internalWidth
    canvas.height = internalHeight
  }

  context.setTransform(1, 0, 0, 1, 0, 0)
  context.scale(dpr, dpr)
  return { context, width, height }
}

function formatSecondsLabel(value: number): string {
  const rounded = Math.round(value * 10) / 10
  const isInteger = Math.abs(rounded - Math.round(rounded)) < 0.0001
  return `${isInteger ? Math.round(rounded) : rounded}s`
}

function getAxisTicks(durationSec: number, tickSec: number): number[] {
  if (durationSec <= 0 || tickSec <= 0) {
    return [0]
  }

  const ticks: number[] = []
  const fullTicks = Math.floor(durationSec / tickSec)
  for (let i = 0; i <= fullTicks; i += 1) {
    ticks.push(i * tickSec)
  }

  const lastTick = ticks[ticks.length - 1] ?? 0
  if (Math.abs(lastTick - durationSec) > 0.001) {
    ticks.push(durationSec)
  }

  return ticks
}

function drawAxes(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  durationSec: number,
  tickSec: number,
): {
  plotX: number
  plotY: number
  plotWidth: number
  plotHeight: number
  midY: number
} {
  const plotX = PLOT_MARGINS.left
  const plotY = PLOT_MARGINS.top
  const plotWidth = Math.max(1, width - PLOT_MARGINS.left - PLOT_MARGINS.right)
  const plotHeight = Math.max(1, height - PLOT_MARGINS.top - PLOT_MARGINS.bottom)
  const midY = plotY + plotHeight / 2

  context.clearRect(0, 0, width, height)
  context.fillStyle = '#f8fbff'
  context.fillRect(0, 0, width, height)

  context.strokeStyle = '#cbd5e1'
  context.lineWidth = 1
  context.beginPath()
  context.moveTo(plotX, midY)
  context.lineTo(plotX + plotWidth, midY)
  context.stroke()

  const axisY = plotY + plotHeight
  context.strokeStyle = '#94a3b8'
  context.beginPath()
  context.moveTo(plotX, axisY)
  context.lineTo(plotX + plotWidth, axisY)
  context.stroke()

  const ticks = getAxisTicks(durationSec, tickSec)
  context.fillStyle = '#475569'
  context.font = '11px "Hiragino Sans", "Noto Sans JP", sans-serif'
  context.textBaseline = 'top'
  context.textAlign = 'center'

  for (let i = 0; i < ticks.length; i += 1) {
    const tick = ticks[i] ?? 0
    const ratio = durationSec > 0 ? tick / durationSec : 0
    const x = plotX + ratio * plotWidth

    context.strokeStyle = '#bfdbfe'
    context.beginPath()
    context.moveTo(x, plotY)
    context.lineTo(x, plotY + plotHeight)
    context.stroke()

    context.strokeStyle = '#94a3b8'
    context.beginPath()
    context.moveTo(x, axisY)
    context.lineTo(x, axisY + 6)
    context.stroke()

    if (i === 0) {
      context.textAlign = 'left'
    } else if (i === ticks.length - 1) {
      context.textAlign = 'right'
    } else {
      context.textAlign = 'center'
    }
    context.fillText(formatSecondsLabel(tick), x, axisY + 7)
  }

  return { plotX, plotY, plotWidth, plotHeight, midY }
}

export async function decodeAudioBlob(blob: Blob): Promise<DecodedAudio> {
  const arrayBuffer = await blob.arrayBuffer()
  const audioContext = createAudioContext()
  try {
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer)
    return {
      samples: audioBuffer.getChannelData(0).slice(),
      sampleRate: audioBuffer.sampleRate,
      durationSec: audioBuffer.duration,
    }
  } finally {
    await audioContext.close()
  }
}

export function toWaveformLine(
  samples: Float32Array,
  points: number,
): Float32Array {
  if (points <= 0) {
    throw new Error('points must be greater than zero')
  }

  const line = new Float32Array(points)
  if (samples.length === 0) {
    return line
  }

  for (let i = 0; i < points; i += 1) {
    const ratio = points === 1 ? 0 : i / (points - 1)
    const sampleIndex = Math.min(
      samples.length - 1,
      Math.max(0, Math.floor(ratio * (samples.length - 1))),
    )
    const sample = samples[sampleIndex] ?? 0
    line[i] = Math.max(-1, Math.min(1, sample))
  }

  return line
}

export function clearWaveform(
  canvas: HTMLCanvasElement,
  durationSec = 0,
  tickSec = 1,
): void {
  const { context, width, height } = prepareCanvas(canvas)
  drawAxes(context, width, height, durationSec, tickSec)
}

export function drawWaveform(
  canvas: HTMLCanvasElement,
  line: Float32Array,
  durationSec: number,
  tickSec = 1,
): void {
  const { context, width, height } = prepareCanvas(canvas)
  const { plotX, plotWidth, plotHeight, midY } = drawAxes(
    context,
    width,
    height,
    durationSec,
    tickSec,
  )

  if (line.length === 0) {
    return
  }

  const halfHeight = Math.max(1, plotHeight / 2 - 2)
  context.strokeStyle = '#1d4ed8'
  context.lineWidth = 1.1
  context.beginPath()

  for (let i = 0; i < line.length; i += 1) {
    const amp = line[i] ?? 0
    const x = plotX + (i / (line.length - 1 || 1)) * plotWidth
    const y = midY - amp * halfHeight
    if (i === 0) {
      context.moveTo(x, y)
    } else {
      context.lineTo(x, y)
    }
  }
  context.stroke()
}
