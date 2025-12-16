import { drizzle as drizzleNode } from "drizzle-orm/node-postgres";
import { drizzle as drizzleNeon } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import { env } from "@/data/env/server";
import * as schema from "@/drizzle/schema";

// Determine which driver to use based on environment
export const db = 
  process.env.NODE_ENV === "production"
    ? drizzleNeon(neon(env.DATABASE_URL), { schema })
    : drizzleNode(env.DATABASE_URL, { schema });
export const dbNode = drizzleNode(env.DATABASE_URL, { schema });