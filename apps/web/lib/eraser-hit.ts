/**
 * Vector hit-detection utilities for the eraser tool.
 * All functions treat the eraser as a circle (cx, cy, radius) and test
 * whether it overlaps a given shape. No canvas/pixel operations.
 */

export interface EraserCircle {
  cx: number
  cy: number
  radius: number
}

export interface RectData { x: number; y: number; width: number; height: number }
export interface CircleData { cx: number; cy: number; radius: number }
export interface PencilData { points: Array<{ x: number; y: number }> }

/** Minimum distance from point p to line segment a→b */
function pointToSegmentDist(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  // Project p onto the segment, clamped to [0, 1]
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

/**
 * True if the eraser circle overlaps the rectangle.
 * Handles rects with negative width/height (drawn right-to-left or bottom-to-top).
 */
export function hitTestRect(eraser: EraserCircle, rect: RectData): boolean {
  // Normalise so x/y is always the top-left corner
  const x = rect.width >= 0 ? rect.x : rect.x + rect.width
  const y = rect.height >= 0 ? rect.y : rect.y + rect.height
  const w = Math.abs(rect.width)
  const h = Math.abs(rect.height)
  // Closest point on the AABB to the eraser centre
  const closestX = Math.max(x, Math.min(eraser.cx, x + w))
  const closestY = Math.max(y, Math.min(eraser.cy, y + h))
  return Math.hypot(eraser.cx - closestX, eraser.cy - closestY) <= eraser.radius
}

/**
 * True if the eraser circle overlaps the circle shape.
 * Two circles overlap when the distance between centres ≤ sum of radii.
 */
export function hitTestCircle(eraser: EraserCircle, circle: CircleData): boolean {
  return Math.hypot(eraser.cx - circle.cx, eraser.cy - circle.cy) <= eraser.radius + circle.radius
}

/**
 * True if the eraser circle intersects any segment of the pencil polyline.
 * Also handles degenerate single-point strokes.
 */
export function hitTestPencil(eraser: EraserCircle, pencil: PencilData): boolean {
  const pts = pencil.points
  if (pts.length === 0) return false
  if (pts.length === 1) {
    return Math.hypot(eraser.cx - pts[0]!.x, eraser.cy - pts[0]!.y) <= eraser.radius
  }
  for (let i = 0; i < pts.length - 1; i++) {
    if (pointToSegmentDist({ x: eraser.cx, y: eraser.cy }, pts[i]!, pts[i + 1]!) <= eraser.radius) {
      return true
    }
  }
  return false
}
