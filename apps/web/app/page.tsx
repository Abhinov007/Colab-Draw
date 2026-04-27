"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import styles from "./page.module.css";

interface Room {
  id: number;
  slug: string;
  createAt: string;
  adminId: string;
}

interface Notification {
  id: string;
  message: string;
  roomId: number | null;
  read: boolean;
  createdAt: string;
}

type ModalType = "signin" | "signup" | null;

export default function Home() {
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [rooms, setRooms] = useState<Room[]>([]);

  // notifications
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [showNotifs, setShowNotifs] = useState(false);
  const notifRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);

  // modal
  const [modal, setModal] = useState<ModalType>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState("");

  // create room
  const [roomName, setRoomName] = useState("");
  const [roomError, setRoomError] = useState("");

  // join room
  const [joinSlug, setJoinSlug] = useState("");
  const [joinError, setJoinError] = useState("");

  useEffect(() => {
    const t = localStorage.getItem("token");
    if (t) {
      setToken(t);
      fetchRooms(t);
      fetchNotifications(t);
      connectNotifWS(t);
    }
  }, []);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) {
        setShowNotifs(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  async function fetchRooms(t: string) {
    const res = await fetch("http://localhost:3001/rooms", {
      headers: { Authorization: `Bearer ${t}` },
    });
    if (res.ok) {
      const data = await res.json();
      setRooms(data.rooms);
    }
  }

  async function fetchNotifications(t: string) {
    const res = await fetch("http://localhost:3001/notifications", {
      headers: { Authorization: `Bearer ${t}` },
    });
    if (res.ok) {
      const data = await res.json();
      setNotifications(data.notifications);
    }
  }

  // Open a WS connection solely to receive live notifications on the home page.
  // Uses the same auth-as-first-message protocol as the room page.
  function connectNotifWS(t: string) {
    const ws = new WebSocket("ws://localhost:8080");
    wsRef.current = ws;

    ws.onopen = () => ws.send(JSON.stringify({ type: "auth", token: t }));

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === "notification") {
        setNotifications((prev) => [msg.notification, ...prev]);
      }
    };

    ws.onclose = () => {
      // Reconnect after 3s if still on page
      setTimeout(() => {
        const stored = localStorage.getItem("token");
        if (stored) connectNotifWS(stored);
      }, 3000);
    };
  }

  async function markAllRead(t: string) {
    await fetch("http://localhost:3001/notifications/read", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
  }

  async function doSignIn(emailVal: string, passwordVal: string): Promise<string | null> {
    const res = await fetch("http://localhost:3001/signin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: emailVal, password: passwordVal }),
    });
    const data = await res.json();
    if (!res.ok) return data.message;
    localStorage.setItem("token", data.token);
    localStorage.setItem("userId", data.userId);
    setToken(data.token);
    setModal(null);
    setEmail(""); setPassword(""); setName("");
    fetchRooms(data.token);
    return null;
  }

  async function handleSignIn() {
    setAuthError("");
    const err = await doSignIn(email, password);
    if (err) setAuthError(err);
  }

  async function handleSignUp() {
    setAuthError("");
    const res = await fetch("http://localhost:3001/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email, password }),
    });
    const data = await res.json();
    if (!res.ok) { setAuthError(data.message); return; }
    const err = await doSignIn(email, password);
    if (err) setAuthError(err);
  }

  async function handleCreateRoom() {
    if (!roomName.trim() || !token) return;
    setRoomError("");
    const res = await fetch("http://localhost:3001/room", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: roomName.trim() }),
    });
    const data = await res.json();
    if (!res.ok) { setRoomError(data.message); return; }
    router.push(`/rooms/${data.roomId}`);
  }

  async function handleJoinRoom() {
    if (!joinSlug.trim() || !token) return;
    setJoinError("");
    const res = await fetch(`http://localhost:3001/room/slug/${joinSlug.trim()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (!res.ok) { setJoinError("Room not found"); return; }
    router.push(`/rooms/${data.room.id}`);
  }

  function handleSignOut() {
    localStorage.removeItem("token");
    localStorage.removeItem("userId");
    wsRef.current?.close();
    wsRef.current = null;
    setToken(null);
    setRooms([]);
    setNotifications([]);
  }

  return (
    <div className={styles.appShell}>
      {/* Navbar */}
      <nav className={styles.navbar}>
        <span className={styles.brand}>ColabDraw</span>
        <div className={styles.navActions}>
          {token ? (
            <>
              {/* Notification Bell */}
              <div ref={notifRef} style={{ position: "relative" }}>
                <button
                  className={styles.btnOutline}
                  style={{ position: "relative", padding: "6px 12px" }}
                  onClick={() => {
                    setShowNotifs((v) => !v);
                    if (!showNotifs && notifications.some((n) => !n.read)) {
                      markAllRead(token);
                    }
                  }}
                  title="Notifications"
                >
                  🔔
                  {notifications.some((n) => !n.read) && (
                    <span style={{
                      position: "absolute", top: 2, right: 2,
                      background: "#ef4444", color: "#fff",
                      borderRadius: "50%", fontSize: 10,
                      width: 16, height: 16,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      fontWeight: 700, lineHeight: 1,
                    }}>
                      {notifications.filter((n) => !n.read).length}
                    </span>
                  )}
                </button>

                {showNotifs && (
                  <div style={{
                    position: "absolute", right: 0, top: "calc(100% + 8px)",
                    width: 320, background: "#fff", border: "1px solid #e2e8f0",
                    borderRadius: 10, boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
                    zIndex: 100, overflow: "hidden",
                  }}>
                    <div style={{
                      padding: "12px 16px", borderBottom: "1px solid #f1f5f9",
                      fontWeight: 600, fontSize: 14, color: "#1e293b",
                    }}>
                      Notifications
                    </div>
                    {notifications.length === 0 ? (
                      <p style={{ padding: "20px 16px", color: "#94a3b8", fontSize: 13, margin: 0 }}>
                        No notifications yet.
                      </p>
                    ) : (
                      <ul style={{ margin: 0, padding: 0, listStyle: "none", maxHeight: 360, overflowY: "auto" }}>
                        {notifications.map((n) => (
                          <li
                            key={n.id}
                            onClick={() => n.roomId && router.push(`/rooms/${n.roomId}`)}
                            style={{
                              padding: "12px 16px",
                              borderBottom: "1px solid #f8fafc",
                              background: n.read ? "#fff" : "#f0f9ff",
                              cursor: n.roomId ? "pointer" : "default",
                              transition: "background 0.15s",
                            }}
                          >
                            <p style={{ margin: 0, fontSize: 13, color: "#334155", lineHeight: 1.4 }}>
                              {n.message}
                            </p>
                            <p style={{ margin: "4px 0 0", fontSize: 11, color: "#94a3b8" }}>
                              {new Date(n.createdAt).toLocaleString()}
                            </p>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>

              <button className={styles.btnOutline} onClick={handleSignOut}>Sign Out</button>
            </>
          ) : (
            <>
              <button className={styles.btnOutline} onClick={() => { setModal("signin"); setAuthError(""); }}>Sign In</button>
              <button className={styles.btnPrimary} onClick={() => { setModal("signup"); setAuthError(""); }}>Sign Up</button>
            </>
          )}
        </div>
      </nav>

      <div className={styles.body}>
        {/* Sidebar */}
        <aside className={styles.sidebar}>
          {token ? (
            <>
              <div className={styles.sidebarSection}>
                <h3 className={styles.sidebarTitle}>Create Room</h3>
                <input
                  className={styles.roomInput}
                  type="text"
                  placeholder="Room name..."
                  value={roomName}
                  onChange={(e) => setRoomName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleCreateRoom()}
                />
                <button className={styles.btnPrimary} style={{ width: "100%", marginTop: 8 }} onClick={handleCreateRoom}>
                  + Create
                </button>
                {roomError && <p className={styles.errorText}>{roomError}</p>}
              </div>

              <div className={styles.sidebarSection}>
                <h3 className={styles.sidebarTitle}>Join Room</h3>
                <input
                  className={styles.roomInput}
                  type="text"
                  placeholder="Room slug..."
                  value={joinSlug}
                  onChange={(e) => setJoinSlug(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleJoinRoom()}
                />
                <button className={styles.btnOutline} style={{ width: "100%", marginTop: 8 }} onClick={handleJoinRoom}>
                  Join
                </button>
                {joinError && <p className={styles.errorText}>{joinError}</p>}
              </div>

              <div className={styles.sidebarSection}>
                <h3 className={styles.sidebarTitle}>Rooms</h3>
                {rooms.length === 0 ? (
                  <p className={styles.emptyState}>No rooms yet.</p>
                ) : (
                  <ul className={styles.roomList}>
                    {rooms.map((room) => (
                      <li key={room.id} className={styles.roomItem} onClick={() => router.push(`/rooms/${room.id}`)}>
                        <span className={styles.roomDot} />
                        <span>{room.slug}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          ) : (
            <p className={styles.emptyState}>Sign in to see rooms.</p>
          )}
        </aside>

        {/* Canvas placeholder */}
        <main className={styles.canvas}>
          <p className={styles.canvasHint}>Select or create a room to start drawing</p>
        </main>
      </div>

      {/* Auth Modal */}
      {modal && (
        <div className={styles.modalOverlay} onClick={() => setModal(null)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h2 className={styles.modalTitle}>{modal === "signin" ? "Sign In" : "Sign Up"}</h2>

            {modal === "signup" && (
              <input
                className={styles.modalInput}
                placeholder="Name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            )}
            <input
              className={styles.modalInput}
              placeholder="Email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <input
              className={styles.modalInput}
              placeholder="Password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && (modal === "signin" ? handleSignIn() : handleSignUp())}
            />

            {authError && <p className={styles.errorText}>{authError}</p>}

            <button
              className={styles.btnPrimary}
              style={{ width: "100%" }}
              onClick={modal === "signin" ? handleSignIn : handleSignUp}
            >
              {modal === "signin" ? "Sign In" : "Sign Up"}
            </button>

            <p className={styles.modalSwitch}>
              {modal === "signin" ? "No account? " : "Have an account? "}
              <span
                className={styles.modalLink}
                onClick={() => { setModal(modal === "signin" ? "signup" : "signin"); setAuthError(""); }}
              >
                {modal === "signin" ? "Sign Up" : "Sign In"}
              </span>
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
