import express, { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import rateLimit from "express-rate-limit";
import { JWT_SECRET } from "@repo/backend-common/config";
import { middleware } from "./middleware";
import { CreateRoomSchema, SignInSchema, CreateUserSchema } from "@repo/common/types";
import { prismaClient } from "@repo/db/client";
import bcrypt from "bcrypt";

const app = express();
app.use(express.json());

// ── CORS ─────────────────────────────────────────────────────────────────────
// Allow only the frontend origin. In production set ALLOWED_ORIGIN in env.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? "http://localhost:3000";

app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;
  if (origin === ALLOWED_ORIGIN) {
    res.header("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  }
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header("Vary", "Origin");
  if (req.method === "OPTIONS") { res.sendStatus(200); return; }
  next();
});

// ── Rate limiting ─────────────────────────────────────────────────────────────
// Applies only to auth endpoints to block brute-force attempts.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,                   // max 10 attempts per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many attempts, please try again after 15 minutes" },
});

app.get("/", (req, res) => {
  res.send("Hello World!");
});

app.post("/signup", authLimiter, async (req, res) => {
  const parsedData = CreateUserSchema.safeParse(req.body);

  if (!parsedData.success) {
    console.log(parsedData.error);
    return res.status(400).json({ message: "Invalid request body" });
  }

  // 🔐 Hash password
  const hashedPassword = await bcrypt.hash(parsedData.data.password, 10);

  const user = await prismaClient.user.create({
    data: {
      email: parsedData.data.email,
      password: hashedPassword, // ✅ store hashed password
      name: parsedData.data.name,
    },
  });

  res.json({
    userId: user.id,
  });
});


app.post("/signin", authLimiter, async (req, res) => {
  const parsedData = SignInSchema.safeParse(req.body);

  if (!parsedData.success) {
    return res.status(400).json({ message: "Invalid inputs" });
  }

  // Find user by email ONLY
  const user = await prismaClient.user.findUnique({
    where: {
      email: parsedData.data.email,
    },
  });

  if (!user) {
    return res.status(403).json({ message: "Invalid credentials" });
  }

  // Compare hashed password
  const isValid = await bcrypt.compare(
    parsedData.data.password,
    user.password
  );

  if (!isValid) {
    return res.status(403).json({ message: "Invalid credentials" });
  }

  // Generate JWT
  const token = jwt.sign(
    { userId: user.id },
    JWT_SECRET,
    { expiresIn: "7d" } 
  );

  res.json({ token, userId: user.id });
});
app.get("/me", middleware, async (req, res) => {
  // @ts-ignore
  const userId: string = req.userId;
  const user = await prismaClient.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, email: true },
  });
  if (!user) return res.status(404).json({ message: "User not found" });
  res.json({ user });
});

app.post("/room", middleware, async (req, res) => {
  const data = CreateRoomSchema.safeParse(req.body);

  if (!data.success) {
    return res.status(400).json({ message: "Invalid request body" });
  }

  // @ts-ignore
  const userId = req.userId;

  const room = await prismaClient.room.create({
    data: {
      slug: data.data.name,
      adminId: userId,
    },
  });

  res.json({
    roomId: room.id,
  });
});

// ── Current user info ────────────────────────────────────────────────────────
app.get("/me", middleware, async (req, res) => {
  // @ts-ignore
  const userId: string = req.userId;
  const user = await prismaClient.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, email: true },
  });
  if (!user) return res.status(404).json({ message: "User not found" });
  res.json({ user });
});

app.get("/rooms", middleware, async (req, res) => {
  // @ts-ignore
  const userId: string = req.userId;

  // Return only rooms the user created OR was invited to
  const rooms = await prismaClient.room.findMany({
    where: {
      OR: [
        { adminId: userId },
        { members: { some: { userId } } },
      ],
    },
    orderBy: { createAt: "desc" },
  });

  res.json({ rooms });
});

app.get("/room/slug/:slug", middleware, async (req: Request<{ slug: string }>, res) => {
  const room = await prismaClient.room.findUnique({ where: { slug: req.params.slug } });
  if (!room) return res.status(404).json({ message: "Room not found" });
  res.json({ room });
});

// ── Get the calling user's role in a room ────────────────────────────────────
// Returns { role: "OWNER" | "EDITOR" | "VIEWER" }
// OWNER  = the room admin (always can edit)
// EDITOR = invited with editor rights
// VIEWER = invited as read-only
app.get("/room/:roomId/my-role", middleware, async (req: Request<{ roomId: string }>, res) => {
  // @ts-ignore
  const userId: string = req.userId;
  const roomId = parseInt(req.params.roomId);

  const room = await prismaClient.room.findUnique({ where: { id: roomId }, select: { adminId: true } });
  if (!room) return res.status(404).json({ message: "Room not found" });

  if (room.adminId === userId) return res.json({ role: "OWNER" });

  const member = await prismaClient.roomMember.findUnique({
    where: { userId_roomId: { userId, roomId } },
    select: { role: true },
  });

  if (!member) return res.status(403).json({ message: "Not a member of this room" });
  return res.json({ role: member.role });
});

app.get("/room/:roomId/shapes", middleware, async (req: Request<{ roomId: string }>, res) => {
  const shapes = await prismaClient.shape.findMany({
    where: { roomId: parseInt(req.params.roomId), isDeleted: false },
    orderBy: { createdAt: "asc" },
  });
  res.json({ shapes });
});

// ── Invite a user to a room ───────────────────────────────────────────────────
// Only the room admin can invite. Invited user gets a RoomMember row + Notification.
// If they are currently online the WS backend will push it live via internal API.
app.post("/room/:roomId/invite", middleware, async (req: Request<{ roomId: string }>, res) => {
  // @ts-ignore
  const callerId: string = req.userId;
  const roomId = parseInt(req.params.roomId);
  const { email, role } = req.body as { email: string; role?: "EDITOR" | "VIEWER" };

  if (!email) return res.status(400).json({ message: "email is required" });

  const assignedRole = role === "VIEWER" ? "VIEWER" : "EDITOR";

  // Caller must be the room admin
  const room = await prismaClient.room.findUnique({ where: { id: roomId } });
  if (!room) return res.status(404).json({ message: "Room not found" });
  if (room.adminId !== callerId) return res.status(403).json({ message: "Only the room owner can invite" });

  // Find the user being invited
  const invitee = await prismaClient.user.findUnique({ where: { email } });
  if (!invitee) return res.status(404).json({ message: "No account found with that email" });

  if (invitee.id === callerId) return res.status(400).json({ message: "You are already the owner" });

  // Upsert membership (idempotent — re-inviting just updates the role)
  await prismaClient.roomMember.upsert({
    where: { userId_roomId: { userId: invitee.id, roomId } },
    update: { role: assignedRole },
    create: { userId: invitee.id, roomId, role: assignedRole },
  });

  // Create in-app notification
  const inviter = await prismaClient.user.findUnique({
    where: { id: callerId },
    select: { name: true },
  });

  const notification = await prismaClient.notification.create({
    data: {
      userId: invitee.id,
      roomId,
      message: `${inviter?.name ?? "Someone"} invited you to room "${room.slug}" as ${assignedRole.toLowerCase()}`,
    },
  });

  // Push live notification if the invitee is currently connected to WS backend
  const WS_INTERNAL = process.env.WS_INTERNAL_URL ?? "http://localhost:8081";
  fetch(`${WS_INTERNAL}/internal/notify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      userId: invitee.id,
      notification: {
        id: notification.id,
        message: notification.message,
        roomId: notification.roomId,
        createdAt: notification.createdAt,
      },
    }),
  }).catch(() => {
    // WS backend unreachable or user offline — notification already in DB, no action needed
  });

  res.json({ message: "Invited successfully" });
});

// ── Get notifications for the logged-in user ──────────────────────────────────
app.get("/notifications", middleware, async (req, res) => {
  // @ts-ignore
  const userId: string = req.userId;

  const notifications = await prismaClient.notification.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: 30,
  });

  res.json({ notifications });
});

// ── Mark notifications as read ────────────────────────────────────────────────
// Body: { ids: string[] }  — pass specific ids, or omit to mark ALL as read
app.patch("/notifications/read", middleware, async (req, res) => {
  // @ts-ignore
  const userId: string = req.userId;
  const { ids } = req.body as { ids?: string[] };

  await prismaClient.notification.updateMany({
    where: {
      userId,
      ...(ids?.length ? { id: { in: ids } } : {}),
    },
    data: { read: true },
  });

  res.json({ message: "Marked as read" });
});

app.listen(3001, () => {
  console.log("Server is running on port 3001");
});