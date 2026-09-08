import express from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 4000);
const TENANT = process.env.TENANT ?? 'default';

const app = express();

app.use(express.urlencoded({ extended: false }));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.get('health', (_req, res) => {
    res.json({
        ok: true,
        tenant: TENANT,
    });
});

app.listen(PORT, () => {
    console.log(`Target app listening on port ${PORT}`);
});