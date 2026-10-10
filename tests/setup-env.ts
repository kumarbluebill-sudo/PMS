import { randomBytes } from "node:crypto";
process.env.APP_ENCRYPTION_KEY ||= randomBytes(32).toString("base64");
process.env.AUTH_URL ||= "http://localhost:3000";
