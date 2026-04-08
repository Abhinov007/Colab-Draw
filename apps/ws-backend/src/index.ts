import { WebSocketServer, WebSocket } from 'ws'
import jwt from 'jsonwebtoken'
import { JWT_SECRET } from '@repo/backend-common/config'
import { prismaClient } from '@repo/db/client'

const wss = new WebSocketServer({ port: 8080 })

// userId -> socket
const clients = new Map<string, WebSocket>()

// roomId -> userIds
const rooms = new Map<string, Set<string>>()

// userId -> roomIds
const userRooms = new Map<string, Set<string>>()

function CheckUser(token: string): string | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET)

    if (!decoded || typeof decoded === 'string') return null
    if (!decoded.userId) return null

    return decoded.userId
  } catch {
    return null
  }
}

wss.on('connection', (ws, request) => {
  const url = request.url
  if (!url) return

  const queryParams = new URLSearchParams(url.split('?')[1])
  const token = queryParams.get('token')

  if (!token) {
    ws.close(1008, 'Token missing')
    return
  }

  const userId = CheckUser(token)

  if (!userId) {
    ws.close(1008, 'Invalid token')
    return
  }

  // Store client
  clients.set(userId, ws)
  userRooms.set(userId, new Set())

  console.log(`User connected: ${userId}`)

  ws.on('message', (data) => {
    try {
      const parsed = JSON.parse(data.toString())

      const { type, roomId, message } = parsed

      // ✅ JOIN ROOM
      if (type === 'join') {
        if (!rooms.has(roomId)) {
          rooms.set(roomId, new Set())
        }

        rooms.get(roomId)!.add(userId)
        userRooms.get(userId)!.add(roomId)

        ws.send(JSON.stringify({
          type: 'joined',
          roomId
        }))
      }

      // ✅ LEAVE ROOM
      if (type === 'leave') {
        rooms.get(roomId)?.delete(userId)
        userRooms.get(userId)?.delete(roomId)
      }

      // ✅ SEND MESSAGE TO ROOM
      if (type === 'message') {
        const usersInRoom = rooms.get(roomId)

        if (!usersInRoom) return

        usersInRoom.forEach((uid) => {
          const client = clients.get(uid)
          if (client && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              type: 'message',
              roomId,
              from: userId,
              message
            }))
          }
        })
      }

    } catch (err) {
      ws.send(JSON.stringify({ error: 'Invalid message format' }))
    }
  })

  // ✅ HANDLE DISCONNECT
  ws.on('close', () => {
    console.log(`User disconnected: ${userId}`)

    const joinedRooms = userRooms.get(userId)

    if (joinedRooms) {
      joinedRooms.forEach((roomId) => {
        rooms.get(roomId)?.delete(userId)
      })
    }

    clients.delete(userId)
    userRooms.delete(userId)
  })
})