import { Request } from "express";

export function getBaseUrl(req: Request): string {
  if (process.env.BACKEND_URL) return process.env.BACKEND_URL;
  const protocol = req.headers["x-forwarded-proto"] ?? req.protocol;
  const host = req.headers["x-forwarded-host"] ?? req.get("host");
  return `${protocol}://${host}`;
}
