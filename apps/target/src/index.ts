import express from 'express';
import type { Request, Response } from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { COPY, SUBACCOUNT_TYPES, createReference, lookupMember } from './data.js';
import { activeFailure, failureMiddleware } from './failures.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 4000);
const TENANT = process.env.TENANT ?? 'a';

type Brand = {
  name: string;
  product: string;
  accent: string;
  idLabel: string;
};

const BRANDS: Record<string, Brand> = {
  a: {
    name: 'Meridian Trust',
    product: 'CoreServ 4.2',
    accent: '#1f4e79',
    idLabel: 'Member ID',
  },
  b: {
    name: 'Calder Savings Bank',
    product: 'CoreServ 4.2',
    accent: '#6b2d5c',
    idLabel: 'Account Number',
  },
};

const brand: Brand = BRANDS[TENANT] ?? BRANDS.a!;

const app = express();
app.disable('x-powered-by');

app.use(express.urlencoded({ extended: false }));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.locals.brand = brand;
app.locals.copy = COPY;
app.locals.subaccountTypes = SUBACCOUNT_TYPES;
app.locals.failQuery = '';

app.use(failureMiddleware);

/** Reads a form field as a trimmed string, whatever the body parser handed back. */
function field(body: unknown, name: string): string {
  if (typeof body !== 'object' || body === null) return '';
  const value = (body as Record<string, unknown>)[name];
  return typeof value === 'string' ? value.trim() : '';
}

const ID_PATTERN = /^\d{5}$/;

/** `1,234.56`, `1234.56`, `$25`, `25.00` — permissive, but not "abc". */
const MONEY_PATTERN = /^\$?(\d{1,3}(,\d{3})*|\d+)(\.\d{2})?$/;

app.get('/health', (_req, res) => {
  res.json({ ok: true, tenant: TENANT, brand: brand.name });
});

app.get('/', (_req, res) => {
  res.render('frame', { title: `${brand.name} — ${brand.product}` });
});

app.get('/nav', (_req, res) => {
  res.render('nav', { title: 'Navigation' });
});

app.get('/search', (req, res) => {
  res.render('search', {
    title: 'Member Search',
    error: null,
    value: '',
    interstitial: activeFailure(req) === 'interstitial',
  });
});

app.post('/search', (req, res) => {
  const value = field(req.body, 'memberId');

  if (!ID_PATTERN.test(value)) {
    res.render('search', {
      title: 'Member Search',
      error: `${brand.idLabel} must be exactly 5 digits.`,
      value,
      interstitial: false,
    });
    return;
  }

  const result = lookupMember(value);
  switch (result.kind) {
    case 'not_found':
      res.render('not-found', { title: 'Member Search' });
      return;
    case 'denied':
      res.render('denied', { title: 'Access Restricted' });
      return;
    case 'found':
      res.redirect(`/member/${result.member.id}${res.locals.failQuery}`);
      return;
  }
});

function resolveMember(req: Request, res: Response) {
  const id = req.params.id;
  const memberId = typeof id === 'string' ? id : '';
  const result = lookupMember(memberId);
  if (result.kind === 'not_found') {
    res.render('not-found', { title: 'Member Search' });
    return null;
  }
  if (result.kind === 'denied') {
    res.render('denied', { title: 'Access Restricted' });
    return null;
  }
  return result.member;
}

app.get('/member/:id', (req, res) => {
  const member = resolveMember(req, res);
  if (!member) return;
  res.render('member', { title: `Member ${member.id}`, member });
});

app.get('/member/:id/subaccount', (req, res) => {
  const member = resolveMember(req, res);
  if (!member) return;
  res.render('subaccount', {
    title: 'Open Sub-Account',
    member,
    errors: [],
    values: { type: '', nickname: '', deposit: '' },
  });
});

app.post('/member/:id/subaccount', (req, res) => {
  const member = resolveMember(req, res);
  if (!member) return;

  const values = {
    type: field(req.body, 'type'),
    nickname: field(req.body, 'nickname'),
    deposit: field(req.body, 'deposit'),
  };

  const errors: string[] = [];

  if (!(SUBACCOUNT_TYPES as readonly string[]).includes(values.type)) {
    errors.push('Select a sub-account type.');
  }
  if (values.nickname.length < 3) {
    errors.push('Nickname must be at least 3 characters.');
  }
  if (!MONEY_PATTERN.test(values.deposit)) {
    errors.push('Initial deposit must be a dollar amount, for example 250.00.');
  }
  
  if (errors.length === 0 && activeFailure(req) === 'validation_error') {
    errors.push('Initial deposit exceeds the daily limit for this account type.');
  }

  if (errors.length > 0) {
    res.render('subaccount', { title: 'Open Sub-Account', member, errors, values });
    return;
  }

  res.render('confirm', {
    title: 'Sub-Account Opened',
    member,
    values,
    reference: createReference(member.id),
  });
});

app.listen(PORT, () => {
  console.log(
    `[target] ${brand.name} (${brand.product}) tenant=${TENANT} -> http://localhost:${PORT}`,
  );
});
