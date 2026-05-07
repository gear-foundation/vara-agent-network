import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pool } from "./db.js";
import { log } from "./logger.js";

const migrationsDir = join(process.cwd(), "migrations");

await pool.query(`
  CREATE TABLE IF NOT EXISTS seed_schema_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )
`);

const files = (await readdir(migrationsDir))
  .filter((file) => file.endsWith(".sql"))
  .sort();

for (const file of files) {
  const existing = await pool.query<{ name: string }>(
    `SELECT name FROM seed_schema_migrations WHERE name = $1`,
    [file],
  );
  if (existing.rows.length > 0) continue;

  const sql = await readFile(join(migrationsDir, file), "utf8");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query(
      `INSERT INTO seed_schema_migrations (name) VALUES ($1)`,
      [file],
    );
    await client.query("COMMIT");
    log.info("seed migration applied", { file });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

await pool.end();
