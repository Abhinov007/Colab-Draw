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
## Contributing

1. Fork the repo
2. Create a feature branch: `git checkout -b feat/your-feature`
3. Commit your changes
4. Push and open a Pull Request

---

## License

MIT
