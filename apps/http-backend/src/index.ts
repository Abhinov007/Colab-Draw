import express from "express";
import jwt from "jsonwebtoken";
import { JWT_SECRET } from "@repo/backend-common/config";
import { middleware } from "./middleware";
import { CreateUserSchema } from "@repo/common/types";

const app = express();

app.get("/", (req, res) => {
  res.send("Hello World!");
});

app.post("/signup", (req, res) => {
  const { name, email, password } = req.body;

  if (!name || !email || !password) {
    return res.status(400).send("All fields are required");
  }

  res.json({
    userId: "123"
  })
});

app.post("/signin", (req, res) => {
  
    const userId=1;
   const token = jwt.sign({ userId }, JWT_SECRET);

   res.json({ token });
    

});

app.post("/room",middleware, (req, res) => {
  let body = "";
});

app.listen(3001, () => {
  console.log("Server is running on port 3001");
});