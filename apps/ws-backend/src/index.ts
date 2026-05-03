import { WebSocketServer, WebSocket } from 'ws'
import http from 'http'
import jwt from 'jsonwebtoken'
import { JWT_SECRET } from '@repo/backend-common/config'
import { prismaClient } from '@repo/db/client'

const WS_PORT = Number(process.env.PORT ?? 8080)
const INTERNAL_PORT = Number(process.env.INTERNAL_PORT ?? 8081)

// ── Internal HTTP server ─────────────────────────────────────────────────────
// Used by the HTTP backend to push live notifications to online users.
// Never exposed to the internet — only reachable from within the same host/network.
const internalServer = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/internal/notify') {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      try {
        const { userId, notification } = JSON.parse(body)
        const clientWs = clients.get(String(userId))
        if (clientWs?.readyState === WebSocket.OPEN) {
          clientWs.send(JSON.stringify({ type: 'notification', notification }))
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ delivered: !!clientWs }))
      } catch {
        res.writeHead(400)
        res.end(JSON.stringify({ error: 'Invalid JSON' }))
      }
    })
    return
  }
  res.writeHead(404)
  res.end()
})

internalServer.listen(INTERNAL_PORT, () => console.log(`[Internal] HTTP server on port ${INTERNAL_PORT}`))

// ── WS Server ─────────────────────────────────────────────────────────────────
// maxPayload: reject any message larger than 64 KB to prevent DoS attacks
const wss = new WebSocketServer({ port: WS_PORT, host: '0.0.0.0', maxPayload: 64 * 1024 })

// ── In-memory state ───────────────────────────────────────────────────────────
const clients   = new Map<string, WebSocket>()                    // userId        → socket
const rooms     = new Map<string, Set<string>>()                  // roomId        → Set<userId>
const userRooms = new Map<string, Set<string>>()                  // userId        → Set<roomId>
const roleCache = new Map<string, 'OWNER' | 'EDITOR' | 'VIEWER'>() // userId:roomId → role

// ── Auth helper ───────────────────────────────────────────────────────────────
function verifyToken(token: string): string | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET)
    if (!decoded || typeof decoded === 'string') return null
    if (typeof (decoded as any).userId !== 'string' && typeof (decoded as any).userId !== 'number') return null
    return String((decoded as any).userId)
  } catch {
    return null
  }
}

// ── Role helpers ──────────────────────────────────────────────────────────────
// Resolve role from DB once on join, then read from cache on every draw/erase.
async function resolveRole(userId: string, roomId: string): Promise<'OWNER' | 'EDITOR' | 'VIEWER' | null> {
  const room = await prismaClient.room.findUnique({
    where: { id: parseInt(roomId) },
    select: { adminId: true },
  })
  if (!room) return null
  if (room.adminId === userId) return 'OWNER'

  const member = await prismaClient.roomMember.findUnique({
    where: { userId_roomId: { userId, roomId: parseInt(roomId) } },
    select: { role: true },
  })
  if (!member) return null
  return member.role as 'EDITOR' | 'VIEWER'
}

function canEdit(userId: string, roomId: string): boolean {
  const role = roleCache.get(`${userId}:${roomId}`)
  return role === 'OWNER' || role === 'EDITOR'
}

function evictRole(userId: string, roomId: string) {
  roleCache.delete(`${userId}:${roomId}`)
}

// ── Broadcast helper ──────────────────────────────────────────────────────────
function broadcastToRoom(roomId: string, senderId: string, payload: object) {
  const usersInRoom = rooms.get(roomId)
  if (!usersInRoom) return
  const msg = JSON.stringify(payload)
  usersInRoom.forEach((uid) => {
    if (uid === senderId) return
    const client = clients.get(uid)
    if (client?.readyState === WebSocket.OPEN) client.send(msg)
  })
}

// ── Connection handler ────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  // Each socket starts unauthenticated — userId resolved after auth message
  let userId: string | null = null
  let authTimeout: ReturnType<typeof setTimeout>

  // If the client doesn't send a valid auth message within 5 s, close it
  authTimeout = setTimeout(() => {
    if (!userId) {
      ws.close(1008, 'Authentication timeout')
    }
  }, 5000)

  ws.on('message', async (data) => {
    // ── Guard: reject oversized frames (belt-and-suspenders over maxPayload) ──
    if (data.toString().length > 64 * 1024) {
      ws.send(JSON.stringify({ type: 'error', message: 'Payload too large' }))
      return
    }

    let parsed: any
    try {
      parsed = JSON.parse(data.toString())
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }))
      return
    }

    const { type, roomId, message, shape, deletedShapeIds, token } = parsed

    // ── AUTH (must be the first message) ──────────────────────────────────────
    // Token is sent as a message, never in the URL query string.
    // This prevents it leaking into server logs, proxy logs, and browser history.
    if (type === 'auth') {
      if (userId) {
        ws.send(JSON.stringify({ type: 'error', message: 'Already authenticated' }))
        return
      }

      const resolvedId = verifyToken(token ?? '')
      if (!resolvedId) {
        ws.close(1008, 'Invalid token')
        return
      }

      clearTimeout(authTimeout)
      userId = resolvedId

      // Guard against React Strict Mode double-mount: don't wipe a live Map Set
      clients.set(userId, ws)
      if (!userRooms.has(userId)) userRooms.set(userId, new Set())

      ws.send(JSON.stringify({ type: 'authenticated', userId }))
      console.log(`[WS] Authenticated: ${userId}`)
      return
    }

    // ── All other message types require authentication ────────────────────────
    if (!userId) {
      ws.close(1008, 'Not authenticated')
      return
    }

    // ── JOIN ──────────────────────────────────────────────────────────────────
    if (type === 'join') {
      if (!roomId) {
        ws.send(JSON.stringify({ type: 'error', message: 'roomId required' }))
        return
      }

      // Resolve role from DB (once per join) and cache it
      const role = await resolveRole(userId, roomId)
      if (!role) {
        ws.send(JSON.stringify({ type: 'error', code: 403, message: 'Room not found or access denied' }))
        return
      }

      roleCache.set(`${userId}:${roomId}`, role)

      if (!rooms.has(roomId)) rooms.set(roomId, new Set())
      if (!userRooms.has(userId)) userRooms.set(userId, new Set())

      rooms.get(roomId)!.add(userId)
      userRooms.get(userId)!.add(roomId)

      ws.send(JSON.stringify({ type: 'joined', roomId, role }))
      return
    }

    // ── LEAVE ─────────────────────────────────────────────────────────────────
    if (type === 'leave') {
      rooms.get(roomId)?.delete(userId)
      userRooms.get(userId)?.delete(roomId)
      evictRole(userId, roomId)
      return
    }

    // ── DRAW ──────────────────────────────────────────────────────────────────
    if (type === 'draw') {
      if (!rooms.get(roomId)?.has(userId)) {
        ws.send(JSON.stringify({ type: 'error', message: 'Not in room' }))
        return
      }

      // Role check — O(1) cache lookup, no DB query
      if (!canEdit(userId, roomId)) {
        ws.send(JSON.stringify({ type: 'error', code: 403, message: 'Viewers cannot edit' }))
        return
      }

      // Broadcast first for minimum peer latency, then persist
      broadcastToRoom(roomId, userId, { type: 'draw', roomId, shape })

      prismaClient.shape.create({
        data: {
          id: shape.id,
          roomId: parseInt(roomId),
          userId,
          type: shape.type,
          data: JSON.stringify(shape.data),
        },
      }).catch((err: unknown) => console.error('[DB] Failed to save shape:', err))

      return
    }

    // ── ERASE ─────────────────────────────────────────────────────────────────
    if (type === 'erase') {
      if (!rooms.get(roomId)?.has(userId)) {
        ws.send(JSON.stringify({ type: 'error', message: 'Not in room' }))
        return
      }

      // Role check — O(1) cache lookup, no DB query
      if (!canEdit(userId, roomId)) {
        ws.send(JSON.stringify({ type: 'error', code: 403, message: 'Viewers cannot edit' }))
        return
      }

      broadcastToRoom(roomId, userId, { type: 'erase', roomId, deletedShapeIds })

      prismaClient.shape.updateMany({
        where: { id: { in: deletedShapeIds } },
        data: { isDeleted: true },
      }).catch((err: unknown) => console.error('[DB] Failed to soft-delete shapes:', err))

      return
    }

    // ── MESSAGE ───────────────────────────────────────────────────────────────
    if (type === 'message') {
      if (!rooms.get(roomId)?.has(userId)) {
        ws.send(JSON.stringify({ type: 'error', message: 'Not in room' }))
        return
      }

      try {
        await prismaClient.chat.create({
          data: { roomId: parseInt(roomId), userId, message },
        })
      } catch {
        ws.send(JSON.stringify({ type: 'error', message: 'Failed to save message' }))
        return
      }

      broadcastToRoom(roomId, userId, { type: 'message', roomId, from: userId, message })
      // Also echo back to sender
      ws.send(JSON.stringify({ type: 'message', roomId, from: userId, message }))
      return
    }

    ws.send(JSON.stringify({ type: 'error', message: 'Unknown message type' }))
  })

  // ── Disconnect ────────────────────────────────────────────────────────────
  ws.on('close', () => {
    clearTimeout(authTimeout)
    if (!userId) return

    console.log(`[WS] Disconnected: ${userId}`)

    // Stale-socket guard: only clean up if this is still the active socket
    if (clients.get(userId) !== ws) return

    userRooms.get(userId)?.forEach((rid) => {
      rooms.get(rid)?.delete(userId!)
      evictRole(userId!, rid)
    })
    clients.delete(userId)
    userRooms.delete(userId)
  })

  ws.on('error', (err) => console.error('[WS] Socket error:', err.message))
})

console.log(`[WS] Server listening on port ${WS_PORT}`)
