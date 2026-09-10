/// <reference types="node" />

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config as loadEnv } from 'dotenv';
import { defineConfig } from 'drizzle-kit';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
loadEnv({ path: path.join(repoRoot, '.env'), quiet: true });

const url = process.env.DATABASE_URL;

if (!url) {
  throw new Error(
    `DATABASE_URL is not set. Expected it in ${path.join(repoRoot, '.env')} — copy .env.example to .env.`,
  );
}

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url },
  strict: true,
  verbose: true,
});
