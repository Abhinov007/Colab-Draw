import { WebSocketServer, WebSocket } from 'ws'
import http from 'http'
import jwt from 'jsonwebtoken'
import { JWT_SECRET } from '@repo/backend-common/config'
import { prismaClient } from '@repo/db/client'

// ── Internal HTTP server (port 8081) ─────────────────────────────────────────
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

internalServer.listen(8081, () => console.log('[Internal] HTTP server on port 8081'))

// ── WS Server ─────────────────────────────────────────────────────────────────
// maxPayload: reject any message larger than 64 KB to prevent DoS attacks
const wss = new WebSocketServer({ port: 8080, maxPayload: 64 * 1024 })

// ── In-memory state ───────────────────────────────────────────────────────────
const clients   = new Map<string, WebSocket>()   // userId  → socket
const rooms     = new Map<string, Set<string>>() // roomId  → Set<userId>
const userRooms = new Map<string, Set<string>>() // userId  → Set<roomId>

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

      // Room authorization — verify the room exists in DB before admitting
      const room = await prismaClient.room.findUnique({
        where: { id: parseInt(roomId) },
        select: { id: true },
      })

      if (!room) {
        ws.send(JSON.stringify({ type: 'error', code: 403, message: 'Room not found or access denied' }))
        return
      }

      if (!rooms.has(roomId)) rooms.set(roomId, new Set())
      if (!userRooms.has(userId)) userRooms.set(userId, new Set())

      rooms.get(roomId)!.add(userId)
      userRooms.get(userId)!.add(roomId)

      ws.send(JSON.stringify({ type: 'joined', roomId }))
      return
    }

    // ── LEAVE ─────────────────────────────────────────────────────────────────
    if (type === 'leave') {
      rooms.get(roomId)?.delete(userId)
      userRooms.get(userId)?.delete(roomId)
      return
    }

    // ── DRAW ──────────────────────────────────────────────────────────────────
    if (type === 'draw') {
      if (!rooms.get(roomId)?.has(userId)) {
        ws.send(JSON.stringify({ type: 'error', message: 'Not in room' }))
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
      }).catch((err) => console.error('[DB] Failed to save shape:', err))

      return
    }

    // ── ERASE ─────────────────────────────────────────────────────────────────
    if (type === 'erase') {
      if (!rooms.get(roomId)?.has(userId)) {
        ws.send(JSON.stringify({ type: 'error', message: 'Not in room' }))
        return
      }

      broadcastToRoom(roomId, userId, { type: 'erase', roomId, deletedShapeIds })

      prismaClient.shape.updateMany({
        where: { id: { in: deletedShapeIds } },
        data: { isDeleted: true },
      }).catch((err) => console.error('[DB] Failed to soft-delete shapes:', err))

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

    userRooms.get(userId)?.forEach((rid) => rooms.get(rid)?.delete(userId!))
    clients.delete(userId)
    userRooms.delete(userId)
  })

  ws.on('error', (err) => console.error('[WS] Socket error:', err.message))
})

console.log('[WS] Server listening on port 8080')
