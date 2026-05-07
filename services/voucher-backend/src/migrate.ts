import 'reflect-metadata';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from 'dotenv';
import { DataSource } from 'typeorm';

config();

const migrationsDir = join(process.cwd(), 'migrations');

const dataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  username: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

async function migrate(): Promise<void> {
  await dataSource.initialize();

  await dataSource.query(`
    CREATE TABLE IF NOT EXISTS voucher_schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamp with time zone NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(migrationsDir))
    .filter((file) => file.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const existing: Array<{ name: string }> = await dataSource.query(
      'SELECT name FROM voucher_schema_migrations WHERE name = $1',
      [file],
    );

    if (existing.length > 0) continue;

    const sql = await readFile(join(migrationsDir, file), 'utf8');
    const queryRunner = dataSource.createQueryRunner();

    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      await queryRunner.query(sql);
      await queryRunner.query(
        'INSERT INTO voucher_schema_migrations (name) VALUES ($1)',
        [file],
      );
      await queryRunner.commitTransaction();
      console.log(`voucher migration applied: ${file}`);
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
}

migrate()
  .catch((error) => {
    console.error('Voucher migration failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (dataSource.isInitialized) {
      await dataSource.destroy();
    }
  });
