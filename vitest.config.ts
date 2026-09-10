import { config as loadEnv } from 'dotenv';
import { defineConfig } from 'vitest/config';

const fileEnv = loadEnv({ quiet: true }).parsed ?? {};

const env = Object.fromEntries(
  Object.entries(fileEnv).filter(([key]) => process.env[key] === undefined),
);

export default defineConfig({
  test: { env },
});
