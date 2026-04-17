"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useRouter, useParams } from "next/navigation";
import styles from "./page.module.css";
import {
  hitTestRect,
  hitTestCircle,
  hitTestPencil,
  type RectData,
  type CircleData,
  type PencilData,
} from "@/lib/eraser-hit";

type Tool = "pencil" | "rect" | "circle" | "eraser";

interface Point { x: number; y: number }

// Shape carries a stable client-generated id used for Map keying, WS events, and DB storage
interface Shape {
  id: string;
  type: "pencil" | "rect" | "circle";
  data: RectData | CircleData | PencilData;
}

const STROKE_COLOR = "#6366f1";
const STROKE_WIDTH = 2;
const ERASER_RADIUS = 20; // px

export default function RoomPage() {
  const router = useRouter();
  const params = useParams<{ roomId: string }>();
  const roomId = params.roomId;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  // Map<id, Shape> — O(1) lookup for erase events
  const shapesRef = useRef<Map<string, Shape>>(new Map());
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unmountedRef = useRef(false);
  const isDrawing = useRef(false);
  const startPos = useRef<Point>({ x: 0, y: 0 });
  const pencilPoints = useRef<Point[]>([]);
  const snapshotRef = useRef<ImageData | null>(null);
  // Accumulates erased shape ids during a single eraser drag — flushed on mouseUp/Leave
  const erasedIdsRef = useRef<string[]>([]);
  // Ref to the eraser cursor overlay div — updated via direct DOM for perf (no re-render)
  const cursorDivRef = useRef<HTMLDivElement>(null);

  const [tool, setTool] = useState<Tool>("pencil");
  const [connected, setConnected] = useState(false);
  const [roomSlug, setRoomSlug] = useState("");

  const getCtx = () => canvasRef.current?.getContext("2d") ?? null;

  const drawShape = useCallback((ctx: CanvasRenderingContext2D, shape: Shape) => {
    ctx.strokeStyle = STROKE_COLOR;
    ctx.lineWidth = STROKE_WIDTH;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    if (shape.type === "rect") {
      const d = shape.data as RectData;
      ctx.strokeRect(d.x, d.y, d.width, d.height);
    } else if (shape.type === "circle") {
      const d = shape.data as CircleData;
      ctx.beginPath();
      ctx.arc(d.cx, d.cy, d.radius, 0, 2 * Math.PI);
      ctx.stroke();
    } else if (shape.type === "pencil") {
      const d = shape.data as PencilData;
      if (d.points.length < 2) return;
      ctx.beginPath();
      ctx.moveTo(d.points[0].x, d.points[0].y);
      d.points.forEach((p) => ctx.lineTo(p.x, p.y));
      ctx.stroke();
    }
  }, []);

  // Maps iterate in insertion order — draw order is stable
  const redrawCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = getCtx();
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    shapesRef.current.forEach((shape) => drawShape(ctx, shape));
  }, [drawShape]);

  // Resize canvas to fill container
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      const parent = canvas.parentElement;
      if (!parent) return;
      canvas.width = parent.clientWidth;
      canvas.height = parent.clientHeight;
      redrawCanvas();
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [redrawCanvas]);

  // Auth, load shapes, connect WS
  useEffect(() => {
    const token = localStorage.getItem("token");
    if (!token) { router.push("/"); return; }

    // Load existing shapes — hydrate id from DB row
    fetch(`http://localhost:3001/room/${roomId}/shapes`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.shapes) {
          const map = new Map<string, Shape>();
          data.shapes.forEach((s: { id: string; type: "pencil" | "rect" | "circle"; data: string }) => {
            map.set(s.id, { id: s.id, type: s.type, data: JSON.parse(s.data) });
          });
          shapesRef.current = map;
          redrawCanvas();
        }
      })
      .catch(() => {});

    // Fetch room name
    fetch(`http://localhost:3001/rooms`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((data) => {
        const room = data.rooms?.find((r: { id: number }) => r.id === parseInt(roomId));
        if (room) setRoomSlug(room.slug);
      })
      .catch(() => {});

    // Connect WebSocket with auto-reconnect
    function connect() {
      if (unmountedRef.current) return;

      const ws = new WebSocket(`ws://localhost:8080?token=${token}`);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        ws.send(JSON.stringify({ type: "join", roomId }));
        console.log("[WS] Connected and joined room", roomId);
      };

      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        console.log("[WS] Received:", msg);

        if (msg.type === "draw") {
          shapesRef.current.set(msg.shape.id, msg.shape);
          redrawCanvas();
        }

        // Task 1.4 — receive erase from another user
        if (msg.type === "erase") {
          (msg.deletedShapeIds as string[]).forEach((id) => {
            shapesRef.current.delete(id);
          });
          redrawCanvas();
        }
      };

      ws.onerror = (e) => console.error("[WS] Error:", (e as ErrorEvent).message || "connection failed");

      ws.onclose = (e) => {
        setConnected(false);
        console.warn(`[WS] Disconnected — code=${e.code} reason="${e.reason}" wasClean=${e.wasClean}`);
        if (!unmountedRef.current) {
          reconnectRef.current = setTimeout(connect, 2000);
        }
      };
    }

    unmountedRef.current = false;
    connect();

    return () => {
      unmountedRef.current = true;
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      wsRef.current?.close();
    };
  }, [roomId, router, redrawCanvas]);

  const getPos = (e: React.MouseEvent<HTMLCanvasElement>): Point => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  // Flush accumulated erased ids over WS and reset the buffer
  const flushErase = useCallback(() => {
    if (erasedIdsRef.current.length > 0 && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: "erase",
        roomId,
        deletedShapeIds: erasedIdsRef.current,
      }));
    }
    erasedIdsRef.current = [];
  }, [roomId]);

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    isDrawing.current = true;
    const pos = getPos(e);
    startPos.current = pos;

    if (tool === "eraser") {
      erasedIdsRef.current = [];
      return; // no snapshot needed for eraser
    }

    if (tool === "pencil") pencilPoints.current = [pos];
    const ctx = getCtx();
    const canvas = canvasRef.current;
    if (ctx && canvas) {
      snapshotRef.current = ctx.getImageData(0, 0, canvas.width, canvas.height);
    }
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const pos = getPos(e);

    // Task 1.5 — update eraser cursor circle via direct DOM (avoids re-render on every move)
    if (tool === "eraser" && cursorDivRef.current) {
      cursorDivRef.current.style.left = `${pos.x - ERASER_RADIUS}px`;
      cursorDivRef.current.style.top = `${pos.y - ERASER_RADIUS}px`;
      cursorDivRef.current.style.display = "block";
    }

    if (!isDrawing.current) return;

    // Task 1.3 — eraser hit detection on every mousemove
    if (tool === "eraser") {
      const eraser = { cx: pos.x, cy: pos.y, radius: ERASER_RADIUS };
      let changed = false;

      shapesRef.current.forEach((shape, id) => {
        let hit = false;
        if (shape.type === "rect")   hit = hitTestRect(eraser, shape.data as RectData);
        else if (shape.type === "circle") hit = hitTestCircle(eraser, shape.data as CircleData);
        else if (shape.type === "pencil") hit = hitTestPencil(eraser, shape.data as PencilData);

        if (hit) {
          erasedIdsRef.current.push(id);
          shapesRef.current.delete(id);
          changed = true;
        }
      });

      if (changed) redrawCanvas();
      return;
    }

    // Drawing tools — restore snapshot then draw preview
    const ctx = getCtx();
    if (!ctx || !snapshotRef.current) return;

    ctx.putImageData(snapshotRef.current, 0, 0);
    ctx.strokeStyle = STROKE_COLOR;
    ctx.lineWidth = STROKE_WIDTH;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    if (tool === "rect") {
      ctx.strokeRect(
        startPos.current.x, startPos.current.y,
        pos.x - startPos.current.x, pos.y - startPos.current.y
      );
    } else if (tool === "circle") {
      const radius = Math.sqrt(
        Math.pow(pos.x - startPos.current.x, 2) + Math.pow(pos.y - startPos.current.y, 2)
      );
      ctx.beginPath();
      ctx.arc(startPos.current.x, startPos.current.y, radius, 0, 2 * Math.PI);
      ctx.stroke();
    } else if (tool === "pencil") {
      pencilPoints.current.push(pos);
      ctx.beginPath();
      ctx.moveTo(pencilPoints.current[0].x, pencilPoints.current[0].y);
      pencilPoints.current.forEach((p) => ctx.lineTo(p.x, p.y));
      ctx.stroke();
    }
  };

  const handleMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDrawing.current) return;
    isDrawing.current = false;

    if (tool === "eraser") {
      flushErase();
      return;
    }

    const pos = getPos(e);
    const id = crypto.randomUUID();
    let shape: Shape;

    if (tool === "rect") {
      shape = {
        id,
        type: "rect",
        data: {
          x: startPos.current.x,
          y: startPos.current.y,
          width: pos.x - startPos.current.x,
          height: pos.y - startPos.current.y,
        },
      };
    } else if (tool === "circle") {
      const radius = Math.sqrt(
        Math.pow(pos.x - startPos.current.x, 2) + Math.pow(pos.y - startPos.current.y, 2)
      );
      shape = { id, type: "circle", data: { cx: startPos.current.x, cy: startPos.current.y, radius } };
    } else {
      shape = { id, type: "pencil", data: { points: [...pencilPoints.current, pos] } };
    }

    shapesRef.current.set(shape.id, shape);
    redrawCanvas();

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "draw", roomId, shape }));
    }
  };

  const handleMouseLeave = () => {
    // Hide eraser cursor when leaving canvas
    if (cursorDivRef.current) {
      cursorDivRef.current.style.display = "none";
    }

    if (isDrawing.current) {
      isDrawing.current = false;

      if (tool === "eraser") {
        flushErase(); // send whatever was erased before leaving
        return;
      }

      const ctx = getCtx();
      if (ctx && snapshotRef.current) ctx.putImageData(snapshotRef.current, 0, 0);
    }
  };

  return (
    <div className={styles.shell}>
      {/* Toolbar */}
      <div className={styles.toolbar}>
        <button className={styles.backBtn} onClick={() => router.push("/")}>
          ← Back
        </button>
        <span className={styles.roomLabel}>{roomSlug || `Room #${roomId}`}</span>

        <div className={styles.tools}>
          <button
            className={`${styles.toolBtn} ${tool === "pencil" ? styles.active : ""}`}
            onClick={() => setTool("pencil")}
            title="Pencil"
          >
            ✏️ Pencil
          </button>
          <button
            className={`${styles.toolBtn} ${tool === "rect" ? styles.active : ""}`}
            onClick={() => setTool("rect")}
            title="Rectangle"
          >
            ▭ Rect
          </button>
          <button
            className={`${styles.toolBtn} ${tool === "circle" ? styles.active : ""}`}
            onClick={() => setTool("circle")}
            title="Circle"
          >
            ○ Circle
          </button>
          <button
            className={`${styles.toolBtn} ${tool === "eraser" ? styles.active : ""}`}
            onClick={() => setTool("eraser")}
            title="Eraser"
          >
            ⌫ Erase
          </button>
        </div>

        <div className={`${styles.status} ${connected ? styles.online : styles.offline}`}>
          {connected ? "● Live" : "○ Connecting..."}
        </div>
      </div>

      {/* Canvas — position:relative so the eraser cursor div is positioned inside it */}
      <div className={styles.canvasWrapper} style={{ position: "relative" }}>
        <canvas
          ref={canvasRef}
          className={styles.canvas}
          style={{ cursor: tool === "eraser" ? "none" : "default" }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseLeave}
          suppressHydrationWarning
        />

        {/* Task 1.5 — eraser cursor circle, updated via direct DOM ref (no re-render) */}
        <div
          ref={cursorDivRef}
          style={{
            display: "none",
            position: "absolute",
            width: ERASER_RADIUS * 2,
            height: ERASER_RADIUS * 2,
            borderRadius: "50%",
            border: "2px solid #64748b",
            pointerEvents: "none",
          }}
        />
      </div>
    </div>
  );
}
