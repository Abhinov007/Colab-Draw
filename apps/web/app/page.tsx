"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import styles from "./page.module.css";

interface Room {
  id: number;
  slug: string;
  createAt: string;
  adminId: string;
}

type ModalType = "signin" | "signup" | null;

export default function Home() {
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [rooms, setRooms] = useState<Room[]>([]);

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
    }
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
    setToken(null);
    setRooms([]);
  }

  return (
    <div className={styles.appShell}>
      {/* Navbar */}
      <nav className={styles.navbar}>
        <span className={styles.brand}>ColabDraw</span>
        <div className={styles.navActions}>
          {token ? (
            <button className={styles.btnOutline} onClick={handleSignOut}>Sign Out</button>
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
