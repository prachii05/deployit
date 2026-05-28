import { getDb } from "@deployit/db";
import { env } from "./env.js";

export const db = getDb(env.DATABASE_URL);
