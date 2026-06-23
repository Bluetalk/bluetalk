<script setup lang="ts">
const canvas = useTemplateRef<HTMLCanvasElement>('canvasRef')
let frame = 0
let resizeHandler: (() => void) | undefined
let schemeObserver: MutationObserver | undefined

type NodePoint = {
  x: number
  y: number
  vx: number
  vy: number
  r: number
}

function readBackdropRgb(): string {
  if (!import.meta.client) {
    return '59, 130, 246'
  }

  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue('--hero-backdrop-rgb')
    .trim()

  return raw || '59, 130, 246'
}

onMounted(() => {
  const element = canvas.value
  if (!element) {
    return
  }

  const media = window.matchMedia('(prefers-reduced-motion: reduce)')
  const context = element.getContext('2d')

  if (!context) {
    return
  }

  let width = 0
  let height = 0
  let ratio = 1
  let points: NodePoint[] = []
  let backdropRgb = readBackdropRgb()

  const buildPoints = () => Array.from({ length: 20 }, () => ({
    x: Math.random() * width,
    y: Math.random() * height,
    vx: (Math.random() - 0.5) * 0.3,
    vy: (Math.random() - 0.5) * 0.3,
    r: Math.random() * 1.6 + 1,
  }))

  const resize = () => {
    ratio = window.devicePixelRatio || 1
    width = element.offsetWidth
    height = element.offsetHeight
    element.width = Math.max(1, Math.floor(width * ratio))
    element.height = Math.max(1, Math.floor(height * ratio))
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    points = buildPoints()
  }

  const draw = () => {
    context.clearRect(0, 0, width, height)

    for (let i = 0; i < points.length; i += 1) {
      for (let j = i + 1; j < points.length; j += 1) {
        const dx = points[i].x - points[j].x
        const dy = points[i].y - points[j].y
        const distance = Math.sqrt(dx * dx + dy * dy)

        if (distance < 200) {
          const alpha = (1 - distance / 200) * 0.2
          context.beginPath()
          context.strokeStyle = `rgba(${backdropRgb}, ${alpha})`
          context.lineWidth = 1
          context.moveTo(points[i].x, points[i].y)
          context.lineTo(points[j].x, points[j].y)
          context.stroke()
        }
      }
    }

    points.forEach((point) => {
      context.beginPath()
      context.fillStyle = `rgba(${backdropRgb}, 0.16)`
      context.arc(point.x, point.y, point.r, 0, Math.PI * 2)
      context.fill()
    })
  }

  const tick = () => {
    points.forEach((point) => {
      point.x += point.vx
      point.y += point.vy

      if (point.x < 0 || point.x > width) {
        point.vx *= -1
      }

      if (point.y < 0 || point.y > height) {
        point.vy *= -1
      }
    })

    draw()

    if (!media.matches) {
      frame = window.requestAnimationFrame(tick)
    }
  }

  resize()
  draw()

  if (!media.matches) {
    frame = window.requestAnimationFrame(tick)
  }

  resizeHandler = () => {
    window.cancelAnimationFrame(frame)
    backdropRgb = readBackdropRgb()
    resize()
    draw()

    if (!media.matches) {
      frame = window.requestAnimationFrame(tick)
    }
  }

  schemeObserver = new MutationObserver(() => {
    const next = readBackdropRgb()
    if (next !== backdropRgb) {
      backdropRgb = next
      draw()
    }
  })

  schemeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-color-scheme'],
  })

  window.addEventListener('resize', resizeHandler)
})

onBeforeUnmount(() => {
  window.cancelAnimationFrame(frame)
  schemeObserver?.disconnect()

  if (resizeHandler) {
    window.removeEventListener('resize', resizeHandler)
  }
})
</script>

<template>
  <canvas ref="canvasRef" class="hero-backdrop" aria-hidden="true" />
</template>
