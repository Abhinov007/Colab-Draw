import express, { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { JWT_SECRET } from "@repo/backend-common/config";
import { middleware } from "./middleware";
import { CreateRoomSchema, SignInSchema, CreateUserSchema } from "@repo/common/types";
import { prismaClient } from "@repo/db/client";
import bcrypt from "bcrypt";

const app = express();
app.use(express.json());

// CORS
app.use((req: Request, res: Response, next: NextFunction) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  if (req.method === "OPTIONS") { res.sendStatus(200); return; }
  next();
});

app.get("/", (req, res) => {
  res.send("Hello World!");
});

app.post("/signup", async (req, res) => {
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


app.post("/signin", async (req, res) => {
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

app.get("/rooms", middleware, async (req, res) => {
  const rooms = await prismaClient.room.findMany({ orderBy: { createAt: "desc" } });
  res.json({ rooms });
});

app.get("/room/slug/:slug", middleware, async (req: Request<{ slug: string }>, res) => {
  const room = await prismaClient.room.findUnique({ where: { slug: req.params.slug } });
  if (!room) return res.status(404).json({ message: "Room not found" });
  res.json({ room });
});

app.get("/room/:roomId/shapes", middleware, async (req: Request<{ roomId: string }>, res) => {
  const shapes = await prismaClient.shape.findMany({
    where: { roomId: parseInt(req.params.roomId) },
    orderBy: { createdAt: "asc" },
  });
  res.json({ shapes });
});

app.listen(3001, () => {
  console.log("Server is running on port 3001");
});