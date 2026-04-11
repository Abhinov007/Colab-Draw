"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useRouter, useParams } from "next/navigation";
import styles from "./page.module.css";

type Tool = "pencil" | "rect" | "circle" | "eraser";

interface Point { x: number; y: number }
interface RectData { x: number; y: number; width: number; height: number }
interface CircleData { cx: number; cy: number; radius: number }
interface PencilData { points: Point[] }
interface Shape { type: Tool; data: RectData | CircleData | PencilData }

const STROKE_COLOR = "#6366f1";
const STROKE_WIDTH = 2;

export default function RoomPage() {
  const router = useRouter();
  const params = useParams<{ roomId: string }>();
  const roomId = params.roomId;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const shapesRef = useRef<Shape[]>([]);
  const isDrawing = useRef(false);
  const startPos = useRef<Point>({ x: 0, y: 0 });
  const pencilPoints = useRef<Point[]>([]);
  const snapshotRef = useRef<ImageData | null>(null);

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
    } else if (shape.type === "eraser") {
      const d = shape.data as PencilData;
      if (d.points.length < 2) return;
      ctx.save();
      ctx.globalCompositeOperation = "destination-out";
      ctx.lineWidth = 20;
      ctx.beginPath();
      ctx.moveTo(d.points[0].x, d.points[0].y);
      d.points.forEach((p) => ctx.lineTo(p.x, p.y));
      ctx.stroke();
      ctx.restore();
    }
  }, []);

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

    // Load existing shapes
    fetch(`http://localhost:3001/room/${roomId}/shapes`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.shapes) {
          shapesRef.current = data.shapes.map((s: { type: Tool; data: string }) => ({
            type: s.type,
            data: JSON.parse(s.data),
          }));
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

    // Connect WebSocket
    const ws = new WebSocket(`ws://localhost:8080?token=${token}`);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      ws.send(JSON.stringify({ type: "join", roomId }));
    };

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === "draw") {
        shapesRef.current.push(msg.shape);
        redrawCanvas();
      }
    };

    ws.onclose = () => setConnected(false);

    return () => ws.close();
  }, [roomId, router, redrawCanvas]);

  const getPos = (e: React.MouseEvent<HTMLCanvasElement>): Point => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    isDrawing.current = true;
    const pos = getPos(e);
    startPos.current = pos;
    if (tool === "pencil" || tool === "eraser") pencilPoints.current = [pos];
    const ctx = getCtx();
    const canvas = canvasRef.current;
    if (ctx && canvas) {
      snapshotRef.current = ctx.getImageData(0, 0, canvas.width, canvas.height);
    }
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDrawing.current) return;
    const ctx = getCtx();
    if (!ctx || !snapshotRef.current) return;
    const pos = getPos(e);

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
    } else if (tool === "eraser") {
      pencilPoints.current.push(pos);
      ctx.save();
      ctx.globalCompositeOperation = "destination-out";
      ctx.lineWidth = 20;
      ctx.beginPath();
      ctx.moveTo(pencilPoints.current[0].x, pencilPoints.current[0].y);
      pencilPoints.current.forEach((p) => ctx.lineTo(p.x, p.y));
      ctx.stroke();
      ctx.restore();
    }
  };

  const handleMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDrawing.current) return;
    isDrawing.current = false;
    const pos = getPos(e);

    let shape: Shape;

    if (tool === "rect") {
      shape = {
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
      shape = { type: "circle", data: { cx: startPos.current.x, cy: startPos.current.y, radius } };
    } else if (tool === "eraser") {
      shape = { type: "eraser", data: { points: [...pencilPoints.current, pos] } };
    } else {
      shape = { type: "pencil", data: { points: [...pencilPoints.current, pos] } };
    }

    shapesRef.current.push(shape);
    redrawCanvas();

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "draw", roomId, shape }));
    }
  };

  const handleMouseLeave = () => {
    if (isDrawing.current) {
      isDrawing.current = false;
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
            ◻ Erase
          </button>
        </div>

        <div className={`${styles.status} ${connected ? styles.online : styles.offline}`}>
          {connected ? "● Live" : "○ Connecting..."}
        </div>
      </div>

      {/* Canvas */}
      <div className={styles.canvasWrapper}>
        <canvas
          ref={canvasRef}
          className={styles.canvas}
          style={{ cursor: tool === "eraser" ? "cell" : "crosshair" }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseLeave}
        />
      </div>
    </div>
  );
}
