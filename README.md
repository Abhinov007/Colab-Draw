# ColabDraw

A real-time collaborative drawing application — think Excalidraw, built from scratch. Multiple users can join a shared room and draw together simultaneously, with every stroke synced live across all connected clients.

---

## Features

- **Real-time collaboration** — draw with multiple users in the same room via WebSockets
- **Drawing tools** — Pencil (freehand), Rectangle, Circle, Eraser
- **Persistent canvas** — shapes are saved to PostgreSQL and restored when you rejoin
- **Eraser** — hit-test based eraser with a live cursor circle overlay
- **JWT authentication** — secure sign-up / sign-in with bcrypt-hashed passwords
- **Role-based access** — room owners can invite collaborators as Editor or Viewer
- **Invite system** — invite by email directly from the room toolbar; invitee gets an instant in-app notification
- **Notification center** — live notification bell with unread badge, powered by WebSocket push
- **Room visibility** — users only see rooms they created or were invited to
- **User profile** — avatar icon in navbar shows name, email, and sign-out
- **Auto-reconnect** — WebSocket drops are detected and reconnected automatically
- **Security hardening** — CORS origin restriction, rate limiting on auth endpoints, WS token in message body (not URL), 64 KB payload cap, 5s auth timeout

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 16 (App Router), React, HTML5 Canvas |
| HTTP Backend | Node.js, Express |
| WebSocket Backend | Node.js, `ws` library |
| Auth | JSON Web Tokens (JWT) + bcrypt |
| Validation | Zod (email format, password min 8) |
| Rate Limiting | express-rate-limit (10 req / 15 min on auth) |
| Database | PostgreSQL (Neon serverless) via Prisma ORM |
| Monorepo | Turborepo + pnpm workspaces |

---

## System Design

```
                        ┌──────────────────────────────────────┐
                        │           Browser (Next.js)           │
                        │                                       │
                        │  ┌──────────┐  ┌──────────────────┐  │
                        │  │ Home UI  │  │  Room / Canvas   │  │
                        │  │ (auth,   │  │  (draw tools,    │  │
                        │  │  rooms,  │  │   invite panel,  │  │
                        │  │  notifs) │  │   viewer mode)   │  │
                        │  └────┬─────┘  └────────┬─────────┘  │
                        └───────┼─────────────────┼────────────┘
                                │                 │
                    REST (HTTP) │                 │ WebSocket
                                │                 │
               ┌────────────────▼───┐   ┌─────────▼────────────────┐
               │   HTTP Backend     │   │   WebSocket Backend       │
               │   (Express :3001)  │   │   (ws :8080)             │
               │                   │   │                           │
               │  POST /signup      │   │  auth-as-message protocol │
               │  POST /signin      │   │  type: auth  (JWT)       │
               │  GET  /me          │   │  type: join  (DB check)  │
               │  GET  /rooms       │   │  type: draw  (role check)│
               │  POST /room        │   │  type: erase (role check)│
               │  GET  /room/:id/   │   │  type: leave             │
               │       shapes       │   │  type: message           │
               │  GET  /room/:id/   │   │                           │
               │       my-role      │   │  In-memory Maps:          │
               │  POST /room/:id/   │   │  clients, rooms,          │
               │       invite       │   │  userRooms                │
               │  GET  /notifications│  │                           │
               │  PATCH /notifs/read│   └──────┬──────────┬─────────┘
               │                   │          │          │
               │  Internal notify  │◄─────────┘          │ Prisma
               │  POST :8081/      │  (live push)         │
               └────────┬──────────┘                      │
                        │ Prisma                           │
                        └──────────────┬───────────────────┘
                                       │
                             ┌─────────▼──────────┐
                             │  PostgreSQL (Neon)  │
                             │                    │
                             │  User              │
                             │  Room              │
                             │  Shape             │
                             │  Chat              │
                             │  RoomMember        │
                             │  Notification      │
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
                    ├──► Role check (OWNER or EDITOR only)
                    │
                    ├──► broadcastToRoom() — all peers in room (immediate)
                    │         │
                    │         ▼
                    │    User B receives { type: "draw", shape }
                    │         └──► redrawCanvas()
                    │
                    └──► prisma.shape.create(...) [non-blocking, fire-and-forget]
```

> **Key design decision:** broadcast first, persist after. Users see each other's strokes immediately without waiting for a DB round-trip.

### Invite & Notification Flow

```
Alice (owner) clicks "+ Invite" → enters bob@example.com
        │
        ▼
  POST /room/:id/invite
        │
        ├──► Upsert RoomMember (role: EDITOR | VIEWER)
        │
        ├──► Create Notification row in DB
        │
        └──► POST http://localhost:8081/internal/notify
                    │
                    ▼
          WebSocket Backend (internal HTTP server)
                    │
                    └──► If Bob is online → ws.send({ type: "notification", ... })
                                                │
                                                ▼
                                         Bob's 🔔 bell badge lights up instantly
```

### Role-Based Access

| Role | Can draw / erase | Can invite | Can view |
|------|:---:|:---:|:---:|
| **OWNER** (room creator) | ✅ | ✅ | ✅ |
| **EDITOR** (invited) | ✅ | ❌ | ✅ |
| **VIEWER** (invited) | ❌ | ❌ | ✅ |

Enforcement is applied at two layers:
- **WS backend** — `draw` and `erase` messages are rejected server-side for VIEWERs
- **Frontend** — drawing tools are hidden and canvas `pointerEvents` is disabled

---

## Project Structure

```
colab-draw/
├── apps/
│   ├── web/                        # Next.js frontend
│   │   └── app/
│   │       ├── page.tsx            # Home: auth, rooms, notifications, user avatar
│   │       ├── page.module.css
│   │       └── rooms/[roomId]/
│   │           ├── page.tsx        # Canvas, drawing tools, invite panel
│   │           └── page.module.css
│   │
│   ├── http-backend/               # Express REST API (port 3001)
│   │   └── src/
│   │       ├── index.ts
│   │       └── middleware.ts       # JWT auth middleware
│   │
│   └── ws-backend/                 # WebSocket server (port 8080)
│       └── src/
│           └── index.ts            # WS + internal HTTP server (port 8081)
│
├── packages/
│   ├── db/                         # Prisma client + schema
│   │   └── prisma/
│   │       └── schema.prisma       # User, Room, Shape, Chat, RoomMember, Notification
│   ├── common/                     # Zod validation schemas
│   └── backend-common/             # Shared config (JWT_SECRET)
│
├── load-test.js                    # k6 WebSocket load test
└── turbo.json
```

---

## Getting Started

### Prerequisites

- Node.js 18+
- pnpm (`npm install -g pnpm`)
- A PostgreSQL database (e.g. [Neon](https://neon.tech) free tier)

### 1. Clone and install

```bash
git clone https://github.com/your-username/colab-draw.git
cd colab-draw
pnpm install
```

### 2. Environment variables

`apps/http-backend/.env`:
```env
DATABASE_URL=postgresql://user:password@host/dbname?sslmode=require
JWT_SECRET=your_super_secret_key
ALLOWED_ORIGIN=http://localhost:3000
```

`apps/ws-backend/.env`:
```env
DATABASE_URL=postgresql://user:password@host/dbname?sslmode=require
JWT_SECRET=your_super_secret_key
```

> Both backends must share the **same** `JWT_SECRET`.

### 3. Push the database schema

```bash
cd packages/db
pnpm prisma db push
```

### 4. Start all servers

```bash
pnpm run dev
# Starts: Next.js :3000, HTTP backend :3001, WS backend :8080 + internal :8081
```

---

## How to Use

### Auth
1. Open `http://localhost:3000`
2. Click **Sign Up** — name, email (validated), password (min 8 chars)
3. Sign in — JWT stored in `localStorage`
4. Click the **avatar icon** (top-right) to view your name, email, or sign out

### Rooms
| Action | How |
|---|---|
| Create | Enter a name in the sidebar → **+ Create** |
| Join by slug | Enter the room slug → **Join** |
| Browse | Sidebar lists only your rooms + rooms you were invited to |

### Drawing (Editors & Owners only)

| Tool | How to use |
|---|---|
| **Pencil** | Click and drag for freehand strokes |
| **Rectangle** | Click and drag corner-to-corner |
| **Circle** | Click as center, drag to set radius |
| **Eraser** | Drag over shapes to remove them |

Viewers see a **👁 View only** badge — drawing tools are hidden and the canvas is non-interactive.

### Inviting Collaborators
1. Open a room you own
2. Click **+ Invite** in the toolbar
3. Enter the collaborator's email and pick **Editor** or **Viewer**
4. Click **Send Invite** — they receive an instant notification

### Notifications
- The 🔔 bell shows a red badge for unread notifications
- Clicking the bell marks all as read and opens the list
- Clicking a notification navigates to that room

---

## Load Testing

A [k6](https://k6.io) script is included to measure how many concurrent users the WS backend can handle.

```bash
# Install k6
winget install k6

# Quick smoke test — 50 users, 30s
k6 run --vus 50 --duration 30s load-test.js

# Staged ramp-up — 50 → 100 users (defined in options.stages)
k6 run load-test.js
```

Edit `load-test.js` to set your `ROOM_ID` and credentials before running. The script signs in **once** in `setup()` and shares the JWT across all virtual users to avoid tripping the auth rate limiter.

### Metrics

| Metric | Description |
|---|---|
| `ws_auth_latency_ms` | Time from connect → authenticated |
| `ws_join_latency_ms` | Time from join sent → joined confirmed |
| `draw_success_rate` | % of draw messages that succeeded |
| `ws_errors` | Total WS error count |

### Results (Neon serverless DB, localhost)

| Run | VUs | Errors | Auth p95 | Join p95 | Draw p95 | Draw success | Outcome |
|-----|-----|--------|----------|----------|----------|--------------|---------|
| Baseline (bug: per-VU sign-in) | 50 | 35,729 | 41ms | 8.2s | — | 100% | ❌ Rate limiter blocked 99.9% of sign-ins |
| Shared token, no role cache | 50 | 0 | 160ms | 22.9s | 1ms | 100% | ⚠️ Join too slow |
| With in-memory role cache | 50 | 0 | 367ms | 7.5s | 1ms | 100% | ⚠️ Join slow (Neon cold-start) |
| Staged ramp 50 → 100 | 100 | ~80 at peak | — | — | 1ms | 100% | ❌ WS crashed at 100 simultaneous joins |

### Key findings

| Finding | Root cause | Fix applied |
|---------|------------|-------------|
| Rate limiter kills load test sign-ins | 10 req/15 min per IP, all VUs shared one IP | Sign in once in `setup()`, share token; skip localhost in limiter |
| Join latency 22s → 7.5s | 2 DB queries per draw (role check) | In-memory role cache — resolve once on join, O(1) lookup on draw |
| Remaining join latency (7.5s) | Neon serverless cold-starts connections | Infrastructure constraint, not a code bug |
| Crash at 100 simultaneous joins | Neon connection pool exhausted under burst | Known Neon free-tier limit |
| Draw latency always ≤ 1ms | In-memory cache + broadcast, zero DB queries | — |

### Practical capacity

| Database | Estimated concurrent users per room |
|----------|-------------------------------------|
| Neon free tier (serverless) | ~50 |
| Persistent Postgres (Railway, Supabase, self-hosted) | 300–500+ |

> Draw performance is effectively unlimited once users are joined — role checks are in-memory with no DB involvement.

---

## Security

| Measure | Detail |
|---|---|
| Password hashing | bcrypt, cost factor 10 |
| JWT expiry | 7 days |
| CORS | Restricted to `ALLOWED_ORIGIN` env var |
| Rate limiting | 10 requests / 15 min per IP on `/signup` and `/signin` |
| WS token transport | Sent as a message, never in the URL (prevents log leakage) |
| WS payload cap | 64 KB max per message |
| WS auth timeout | Connection closed after 5s if no auth message received |
| Role enforcement | VIEWER draw/erase rejected server-side, not just on the frontend |

---

## Contributing

1. Fork the repo
2. Create a feature branch: `git checkout -b feat/your-feature`
3. Commit your changes
4. Push and open a Pull Request

---

## License

MIT
