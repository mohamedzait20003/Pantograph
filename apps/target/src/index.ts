import { BRANDS, createApp } from './app.js';

/** Process entry point. Everything interesting lives in `app.ts`. */

const PORT = Number(process.env.PORT ?? 4000);
const TENANT = process.env.TENANT ?? 'a';

const brand = BRANDS[TENANT] ?? BRANDS.a!;
const app = createApp({ tenant: TENANT });

app.listen(PORT, () => {
  console.log(
    `[target] ${brand.name} (${brand.product}) tenant=${TENANT} -> http://localhost:${PORT}`,
  );
});
