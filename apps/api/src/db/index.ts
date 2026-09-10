import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import * as schema from './schema.js';

export * from './schema.js';


export function createDb(connectionString: string, options: { max?: number } = {}) {
  const client = postgres(connectionString, { max: options.max ?? 10 });
  const db = drizzle(client, { schema });
  
  return { db, client };
}

export type DbHandle = ReturnType<typeof createDb>;
export type Database = DbHandle['db'];

let cached: DbHandle | null = null;

export function getDb(): DbHandle {
  if (cached) return cached;

  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env, then run `docker compose up -d db`.',
    );
  }

  cached = createDb(url);
  return cached;
}
