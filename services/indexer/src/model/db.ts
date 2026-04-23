// Drizzle client factory. One pool per process.
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { config } from "../config.js";
import * as schema from "./schema.js";

const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
});

export const db = drizzle(pool, { schema });
export { schema };
export type Db = typeof db;
