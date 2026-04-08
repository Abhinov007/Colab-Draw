import express from "express";
import jwt from "jsonwebtoken";
import { JWT_SECRET } from "@repo/backend-common/config";
import { middleware } from "./middleware";
import { CreateRoomSchema, SignInSchema, CreateUserSchema } from "@repo/common/types";
import { prismaClient } from "@repo/db/client";

const app = express();

app.get("/", (req, res) => {
  res.send("Hello World!");
});

app.post("/signup", async (req, res) => {

  const parsedData = CreateUserSchema.safeParse(req.body);

  if (!parsedData.success) {
    return res.status(400).json({ message: "Invalid request body" });
  }

  const user = await prismaClient.user.create({
    data: {
      email: parsedData.data.email,
      password: parsedData.data.password,
      name: parsedData.data.name
    }
  })

  res.json({
    userId: user.id
  })
});

app.post("/signin", (req, res) => {
  const parsedData = SignInSchema.safeParse(req.body);
  if (!parsedData.success) {
    return res.status(400).json({ message: "Invalid inputs" });
  }

  // TODO: verify credentials against DB
  const userId = 1;
  const token = jwt.sign({ userId }, JWT_SECRET);

  res.json({ token });
});

app.post("/room", middleware, (req, res) => {
  const data = CreateRoomSchema.safeParse(req.body);

  if (!data.success) {
    return res.status(400).json({ message: "Invalid request body" });
  }

  res.json({
    roomId: "123"
  });
});

app.listen(3001, () => {
  console.log("Server is running on port 3001");
});