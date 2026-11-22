import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { config } from "./config.js";
import { formatError, log } from "./helpers/logger.js";

const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 1 });

try {
  await migrate(drizzle(pool), { migrationsFolder: "./drizzle" });
  log.info("migrations applied");
} catch (err) {
  log.error("migrations failed", formatError(err));
  process.exitCode = 1;
} finally {
  await pool.end();
}
