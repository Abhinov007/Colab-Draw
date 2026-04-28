/**
 * k6 WebSocket load test for ColabDraw
 *
 * Usage:
 *   k6 run load-test.js                        # 50 users, 30s
 *   k6 run --vus 200 --duration 60s load-test.js
 *   k6 run --vus 500 --duration 120s load-test.js
 *
 * What it tests:
 *   - Each virtual user signs in, joins room ROOM_ID, sends draw messages, then leaves
 *   - Measures: connection time, auth latency, message round-trip, error rate
 *
 * Prerequisites:
 *   - HTTP backend running on :3001
 *   - WS  backend running on :8080
 *   - A room already created (set ROOM_ID below)
 *   - A test user already created (set EMAIL/PASSWORD below)
 */

import ws from "k6/ws";
import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Counter, Rate } from "k6/metrics";

// ── Config ────────────────────────────────────────────────────────────────────
const HTTP_BASE = "http://localhost:3001";
const WS_URL    = "ws://localhost:8080";

// A single test account — all VUs share it (simplest setup).
// For multi-user isolation create N accounts and use __VU index.
const EMAIL    = "alice@test.com";
const PASSWORD = "password123";
const ROOM_ID  = "6";           // <-- set to your room ID

// ── Custom metrics ────────────────────────────────────────────────────────────
const authLatency   = new Trend("ws_auth_latency_ms",   true);
const joinLatency   = new Trend("ws_join_latency_ms",   true);
const drawLatency   = new Trend("ws_draw_latency_ms",   true);
const wsErrors      = new Counter("ws_errors");
const drawSuccess   = new Rate("draw_success_rate");

// ── k6 options ────────────────────────────────────────────────────────────────
export const options = {
  stages: [
    { duration: "10s", target: 50  },   // ramp up to 50 users
    { duration: "20s", target: 50  },   // hold
    { duration: "10s", target: 100 },   // ramp to 100
    { duration: "20s", target: 100 },   // hold
    { duration: "10s", target: 0   },   // ramp down
  ],
  thresholds: {
    ws_auth_latency_ms: ["p(95)<500"],   // 95% of auth handshakes under 500ms
    ws_join_latency_ms: ["p(95)<500"],
    draw_success_rate:  ["rate>0.95"],   // at least 95% of draws succeed
    ws_errors:          ["count<50"],    // fewer than 50 errors total
  },
};

// ── Main VU function ──────────────────────────────────────────────────────────
export default function () {
  // 1. Sign in via HTTP to get a JWT
  const signInRes = http.post(
    `${HTTP_BASE}/signin`,
    JSON.stringify({ email: EMAIL, password: PASSWORD }),
    { headers: { "Content-Type": "application/json" } }
  );

  const ok = check(signInRes, { "signed in": (r) => r.status === 200 });
  if (!ok) { wsErrors.add(1); return; }

  const token = signInRes.json("token");

  // 2. Open WebSocket
  const res = ws.connect(WS_URL, {}, function (socket) {
    let authenticated = false;
    let joined        = false;

    const authStart = Date.now();
    let   joinStart = 0;
    let   drawStart = 0;

    socket.on("open", () => {
      // Step 1 — authenticate
      socket.send(JSON.stringify({ type: "auth", token }));
    });

    socket.on("message", (raw) => {
      const msg = JSON.parse(raw);

      if (msg.type === "authenticated") {
        authLatency.add(Date.now() - authStart);
        authenticated = true;

        // Step 2 — join room
        joinStart = Date.now();
        socket.send(JSON.stringify({ type: "join", roomId: ROOM_ID }));
        return;
      }

      if (msg.type === "joined") {
        joinLatency.add(Date.now() - joinStart);
        joined = true;

        // Step 3 — send 5 draw messages
        for (let i = 0; i < 5; i++) {
          drawStart = Date.now();
          socket.send(JSON.stringify({
            type: "draw",
            roomId: ROOM_ID,
            shape: {
              id: `${__VU}-${__ITER}-${i}`,
              type: "rect",
              data: { x: Math.random() * 800, y: Math.random() * 600, width: 50, height: 50 },
            },
          }));
          drawSuccess.add(1);
          drawLatency.add(Date.now() - drawStart);
          sleep(0.1);
        }

        // Step 4 — leave
        socket.send(JSON.stringify({ type: "leave", roomId: ROOM_ID }));
        sleep(1);
        socket.close();
        return;
      }

      if (msg.type === "error") {
        wsErrors.add(1);
        drawSuccess.add(0);
        console.error(`[VU ${__VU}] WS error: ${msg.message}`);
        socket.close();
      }
    });

    socket.on("error", (e) => {
      wsErrors.add(1);
      console.error(`[VU ${__VU}] socket error: ${e.error()}`);
    });

    // Safety timeout — close after 30s no matter what
    socket.setTimeout(() => { socket.close(); }, 30000);
  });

  check(res, { "ws status 101": (r) => r && r.status === 101 });
  sleep(1);
}
