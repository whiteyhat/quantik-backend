import { Request } from "express";

const PRODUCTION_URL = "https://api.quantik.fun";

export function getBaseUrl(req: Request): string {
  if (process.env.BACKEND_URL) return process.env.BACKEND_URL;
  if (process.env.RAILWAY_ENVIRONMENT) return PRODUCTION_URL;
  const protocol = req.headers["x-forwarded-proto"] ?? req.protocol;
  const host = req.headers["x-forwarded-host"] ?? req.get("host");
  return `${protocol}://${host}`;
}
