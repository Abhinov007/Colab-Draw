# ColabDraw

A real-time collaborative drawing application — think Excalidraw, but built from scratch. Multiple users can join a shared room and draw together simultaneously, with every stroke synced live across all connected clients.

---

## Features

- **Real-time collaboration** — draw with multiple users in the same room via WebSockets
- **Drawing tools** — Pencil (freehand), Rectangle, Circle
- **Persistent canvas** — shapes are saved to PostgreSQL and restored when you rejoin a room
- **JWT authentication** — secure sign-up / sign-in with bcrypt-hashed passwords
- **Room management** — create named rooms, join by slug, switch between rooms
- **Auto-reconnect** — WebSocket drops are detected and reconnected automatically

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 14 (App Router), React, HTML5 Canvas |
| HTTP Backend | Node.js, Express |
| WebSocket Backend | Node.js, `ws` library |
| Auth | JSON Web Tokens (JWT) + bcrypt |
| Database | PostgreSQL (Neon serverless) via Prisma ORM |
| Monorepo | Turborepo + pnpm workspaces |
| Deployment | PM2 (backends), Vercel (frontend) |

---

## System Design

```
                        ┌─────────────────────────────────┐
                        │           Browser (Next.js)      │
                        │                                  │
                        │  ┌──────────┐  ┌─────────────┐  │
                        │  │ Auth UI  │  │  Canvas UI  │  │
                        │  └────┬─────┘  └──────┬──────┘  │
                        └───────┼───────────────┼─────────┘
                                │               │
                    REST (HTTP) │               │ WebSocket (ws://)
                                │               │
               ┌────────────────▼───┐   ┌───────▼──────────────┐
               │   HTTP Backend     │   │   WebSocket Backend   │
               │   (Express :3001)  │   │   (ws :8080)         │
               │                   │   │                       │
               │  POST /signup      │   │  type: join           │
               │  POST /signin      │   │  type: draw  ─────────┼──► broadcast
               │  POST /room        │   │  type: leave          │    to room
               │  GET  /rooms       │   │                       │
               │  GET  /room/:id/   │   │  In-memory Maps:      │
               │       shapes       │   │  clients, rooms,      │
               └────────┬───────────┘   │  userRooms            │
                        │               └───────────┬───────────┘
                        │ Prisma ORM                │ Prisma ORM
                        └───────────────┬───────────┘
                                        │
                              ┌─────────▼──────────┐
                              │  PostgreSQL (Neon)  │
                              │                    │
                              │  User              │
                              │  Room              │
                              │  Shape             │
                              │  Chat              │
                              └────────────────────┘
```

### Real-time Draw Flow

```
User A draws a shape
        │
        ▼
  Canvas mouseUp
        │
        ├──► Add to local shapesRef (instant local feedback)
        │
        └──► ws.send({ type: "draw", roomId, shape })
                    │
                    ▼
          WebSocket Backend
                    │
                    ├──► Broadcast shape to all other users in room (immediate)
                    │         │
                    │         ▼
                    │    User B receives { type: "draw", shape }
                    │         │
                    │         ▼
                    │    shapesRef.push(shape) → redrawCanvas()
                    │
                    └──► prisma.shape.create(...) [non-blocking, async]
                              │
                              ▼
                         PostgreSQL saved
```

**Key design decision:** The WS backend broadcasts first, then saves to the database asynchronously. This keeps real-time latency low — users see each other's strokes immediately without waiting for a DB round-trip.

---

## Database Schema

```prisma
model User {
  id       String  @id @default(uuid())
  email    String  @unique
  password String          // bcrypt hashed
  name     String
  chats    Chat[]
  rooms    Room[]
  shapes   Shape[]
}

model Room {
  id       Int      @id @default(autoincrement())
  slug     String   @unique
  createAt DateTime @default(now())
  adminId  String
  chats    Chat[]
  shapes   Shape[]
  admin    User     @relation(fields: [adminId], references: [id])
}

model Shape {
  id        String   @id @default(uuid())
  roomId    Int
  userId    String
  type      String           // "pencil" | "rect" | "circle"
  data      String           // JSON-serialized shape coordinates
  createdAt DateTime @default(now())
  room      Room     @relation(fields: [roomId], references: [id])
  user      User     @relation(fields: [userId], references: [id])
}

model Chat {
  id      String @id @default(uuid())
  roomId  Int
  message String
  userId  String
  room    Room   @relation(fields: [roomId], references: [id])
  user    User   @relation(fields: [userId], references: [id])
}
```

---

## Project Structure

```
colab-draw/
├── apps/
│   ├── web/                        # Next.js frontend
│   │   └── app/
│   │       ├── page.tsx            # Auth + room list
│   │       └── rooms/[roomId]/
│   │           └── page.tsx        # Canvas + drawing tools
│   │
│   ├── http-backend/               # Express REST API (port 3001)
│   │   └── src/
│   │       ├── index.ts
│   │       └── middleware.ts       # JWT auth middleware
│   │
│   └── ws-backend/                 # WebSocket server (port 8080)
│       └── src/
│           └── index.ts
│
├── packages/
│   ├── db/                         # Prisma client + schema
│   │   └── prisma/
│   │       └── schema.prisma
│   ├── common/                     # Zod validation schemas
│   └── backend-common/             # Shared config (JWT_SECRET)
│
├── .github/
│   └── workflows/
│       └── deploy.yml              # GitHub Actions → EC2 auto-deploy
│
└── turbo.json
```

---

## Getting Started

### Prerequisites

- Node.js 18+
- pnpm (`npm install -g pnpm`)
- A PostgreSQL database (e.g. [Neon](https://neon.tech) free tier)

### 1. Clone the repository

```bash
git clone https://github.com/your-username/colab-draw.git
cd colab-draw
```

### 2. Install dependencies

```bash
pnpm install
```

### 3. Set up environment variables

Create `apps/http-backend/.env`:

```env
DATABASE_URL=postgresql://user:password@host/dbname?sslmode=require
JWT_SECRET=your_super_secret_key
```

Create `apps/ws-backend/.env`:

```env
DATABASE_URL=postgresql://user:password@host/dbname?sslmode=require
JWT_SECRET=your_super_secret_key
```

> Both backends must use the **same** `JWT_SECRET` so tokens issued by the HTTP backend are valid on the WebSocket backend.

### 4. Push the database schema

```bash
cd packages/db
pnpm prisma db push
```

### 5. Start all servers

```bash
# From the repo root — starts all apps in parallel via Turborepo
pnpm run dev
```

| Service | URL |
|---|---|
| Frontend | http://localhost:3000 |
| HTTP Backend | http://localhost:3001 |
| WebSocket Backend | ws://localhost:8080 |

---

## How to Use

### Sign Up / Sign In

1. Open http://localhost:3000
2. Click **Sign Up** and create an account
3. Sign in — your JWT token is stored in `localStorage`

### Create a Room

1. Enter a room name in the **Create Room** input
2. Click **Create** — you'll be redirected to the canvas

### Join an Existing Room

1. See the list of all rooms on the home page
2. Click **Join** next to any room

### Drawing Tools

| Tool | How to use |
|---|---|
| **Pencil** | Click and drag for freehand strokes |
| **Rectangle** | Click and drag to define corner-to-corner |
| **Circle** | Click as center, drag to set radius |

Shapes drawn by any user in the room appear on all other connected users' canvases in real time.

---

## API Reference

### REST Endpoints (HTTP Backend — port 3001)

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/signup` | No | Create account `{ email, password, name }` |
| POST | `/signin` | No | Get JWT `{ email, password }` → `{ token, userId }` |
| POST | `/room` | Yes | Create room `{ name }` → `{ roomId }` |
| GET | `/rooms` | Yes | List all rooms |
| GET | `/room/slug/:slug` | Yes | Find room by slug |
| GET | `/room/:roomId/shapes` | Yes | Get all shapes in a room |

### WebSocket Events (WS Backend — port 8080)

Connect with: `ws://localhost:8080?token=<jwt>`

**Client → Server:**

```json
{ "type": "join",  "roomId": "42" }
{ "type": "leave", "roomId": "42" }
{ "type": "draw",  "roomId": "42", "shape": { "type": "rect", "data": { ... } } }
```

**Server → Client:**

```json
{ "type": "joined", "roomId": "42" }
{ "type": "draw",   "roomId": "42", "shape": { "type": "rect", "data": { ... } } }
```

### Shape Data Formats

```ts
// Rectangle
{ x: number, y: number, width: number, height: number }

// Circle
{ cx: number, cy: number, radius: number }

// Pencil
{ points: Array<{ x: number, y: number }> }
```

---

## Deployment

### Backend (EC2 with PM2)

```bash
# On the EC2 server
git clone https://github.com/your-username/colab-draw.git
cd colab-draw
pnpm install

# Write env files
echo "DATABASE_URL=..." > apps/http-backend/.env
echo "JWT_SECRET=..."  >> apps/http-backend/.env
echo "DATABASE_URL=..." > apps/ws-backend/.env
echo "JWT_SECRET=..."  >> apps/ws-backend/.env

# Build
cd apps/http-backend && pnpm run build
cd ~/colab-draw/apps/ws-backend && pnpm run build

# Start with PM2
pm2 start ~/colab-draw/apps/http-backend/dist/index.js --name http-backend
pm2 start ~/colab-draw/apps/ws-backend/dist/index.js  --name ws-backend
pm2 save
pm2 startup   # auto-start on reboot
```

**Auto-deploy on push:** The included `.github/workflows/deploy.yml` SSHes into your EC2, pulls, rebuilds, and restarts PM2 automatically on every push to `main`. Configure these GitHub Secrets:

| Secret | Value |
|---|---|
| `EC2_HOST` | Your EC2 public IP |
| `EC2_USER` | `ubuntu` (or `ec2-user`) |
| `EC2_SSH_KEY` | Contents of your `.pem` private key |
| `DATABASE_URL` | Neon connection string |
| `JWT_SECRET` | Your secret key |

### Frontend (Vercel)

```bash
# Install Vercel CLI
npm install -g vercel

cd apps/web
vercel --prod
```

Set these environment variables in the Vercel dashboard:

```
NEXT_PUBLIC_HTTP_URL=https://your-ec2-ip:3001
NEXT_PUBLIC_WS_URL=wss://your-ec2-ip:8080
```

> Update the hardcoded `localhost` URLs in `apps/web/app/rooms/[roomId]/page.tsx` to use these env vars before deploying.

---

## Known Limitations

- **Single server only** — in-memory Maps (`clients`, `rooms`) don't work across multiple WS server instances. For horizontal scaling, replace with Redis Pub/Sub.
- **No access control** — any authenticated user can join any room. Room-level permissions not yet implemented.
- **No undo** — shapes, once drawn, cannot be undone without a page reload.
- **Canvas is not infinite** — canvas is sized to the browser window; no pan/zoom support.
- **WebSocket URL hardcoded** — `localhost` URLs need to be replaced with env vars for production.

---

## Contributing

1. Fork the repo
2. Create a feature branch: `git checkout -b feat/your-feature`
3. Commit your changes
4. Push and open a Pull Request

---

## License

MIT
