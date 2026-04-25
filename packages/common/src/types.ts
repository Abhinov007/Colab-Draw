import { z } from "zod";

export const CreateUserSchema = z.object({
    name: z.string().min(1, "Name is required").max(50),
    email: z.string().email("Invalid email address"),
    password: z
        .string()
        .min(8, "Password must be at least 8 characters")
        .max(72, "Password too long"), // bcrypt silently truncates at 72 bytes
});

export const SignInSchema = z.object({
    email: z.string().email("Invalid email address"),
    password: z.string().min(1, "Password is required"),
});

export const CreateRoomSchema = z.object({
    name: z.string().min(3).max(20)
});