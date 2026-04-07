import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { JWT_SECRET } from "@repo/backend-common/config";

export function middleware(req: Request, res: Response, next: NextFunction) {
    const authHeader = req.headers["authorization"];
    if (!authHeader) {
        return res.status(401).json({ message: "Authorization header missing" });
    }

    const token = authHeader.split(" ")[1];
    if (!token) {
        return res.status(401).json({ message: "Token missing" });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET) as { userId: string }; // Add type assertion for decoded token
        // @ts-ignore
        req.userId = decoded.userId; // Assuming `userId` exists in the token payload
        next();
    } catch (err) {
        res.status(403).json({ message: "Unauthorized" });
    }
}