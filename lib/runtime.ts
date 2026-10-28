import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readFile, writeFile, link, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

/** Runtime data lives on the ECS data volume, never in the build output. */
export function dataDirectory() {
  return resolve(process.env.DATA_DIR || join(process.cwd(), 'data'));
}

export type LocalStatement = {
  bind: (...values: SQLInputValue[]) => LocalStatement;
  first: <T = Record<string, unknown>>(column?: string) => Promise<T | null>;
  all: <T = Record<string, unknown>>() => Promise<{ results: T[]; success: boolean }>;
  run: () => Promise<{ success: boolean; meta: { changes: number; last_row_id: number } }>;
};

export class SQLiteStore {
  readonly connection: DatabaseSync;

  constructor(directory: string) {
    // Construction is lazy, so importing routes during a build writes nothing.
    this.connection = new DatabaseSync(join(directory, 'catalog.sqlite'));
    this.connection.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS catalog (
        id INTEGER PRIMARY KEY, data TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS admin (id INTEGER PRIMARY KEY, user_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS favorites (user_id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS admin_login_attempts (
        key TEXT PRIMARY KEY, window INTEGER NOT NULL, attempts INTEGER NOT NULL
      );
    `);
  }

  prepare(sql: string): LocalStatement {
    const statement = this.connection.prepare(sql);
    const make = (parameters: SQLInputValue[] = []): LocalStatement => ({
      bind: (...values: SQLInputValue[]) => make(values),
      first: async <T = Record<string, unknown>>(column?: string): Promise<T | null> => {
        const result = statement.get(...parameters);
        return ((column ? result?.[column] : result) as T | undefined) ?? null;
      },
      all: async <T = Record<string, unknown>>() => ({
        results: statement.all(...parameters) as T[], success: true,
      }),
      run: async () => {
        const result = statement.run(...parameters);
        return { success: true, meta: {
          changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid),
        } };
      },
    });
    return make();
  }

  close() { this.connection.close(); }
}

// Next may load separate server bundles; retain one connection per data path
// in each process, and use SQLite WAL for concurrency between processes.
const runtimeGlobal = globalThis as typeof globalThis & {
  __pairdeerDatabases?: Map<string, Promise<SQLiteStore>>;
};

export async function openDatabase(directory: string): Promise<SQLiteStore> {
  await mkdir(join(directory, 'media'), { recursive: true, mode: 0o700 });
  return new SQLiteStore(directory);
}

export function getDatabase(): Promise<SQLiteStore> {
  const directory = dataDirectory();
  const databases = runtimeGlobal.__pairdeerDatabases ??= new Map<string, Promise<SQLiteStore>>();
  let instance = databases.get(directory);
  if (!instance) {
    instance = openDatabase(directory).catch(error => {
      databases.delete(directory);
      throw error;
    });
    databases.set(directory, instance);
  }
  return instance;
}

// Preserve the route handlers' prepare/bind interface while lazily opening disk.
export const localDatabase = {
  prepare(sql: string): LocalStatement {
    const make = (parameters: SQLInputValue[] = []): LocalStatement => ({
      bind: (...values: SQLInputValue[]) => make(values),
      first: async <T = Record<string, unknown>>(column?: string) =>
        (await getDatabase()).prepare(sql).bind(...parameters).first<T>(column),
      all: async <T = Record<string, unknown>>() =>
        (await getDatabase()).prepare(sql).bind(...parameters).all<T>(),
      run: async () => (await getDatabase()).prepare(sql).bind(...parameters).run(),
    });
    return make();
  },
};

export class RangeNotSatisfiableError extends Error {
  readonly status = 416;
  readonly size: number;
  constructor(size: number) { super('Requested range is not satisfiable'); this.size = size; }
}

function mediaPath(key: string) {
  if (!/^[a-z0-9-]+\.(png|jpg|webp|gif|mp4|webm)$/.test(key)) throw new Error('素材文件名无效');
  return join(dataDirectory(), 'media', key);
}

function contentType(key: string) {
  const types: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
    mp4: 'video/mp4', webm: 'video/webm',
  };
  return types[key.split('.').at(-1)!];
}

type ObjectMetadata = {
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
  etag?: string;
};

function parseRange(value: string | null, size: number) {
  if (!value) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2]) || size === 0) throw new RangeNotSatisfiableError(size);
  let start: number, end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new RangeNotSatisfiableError(size);
    start = Math.max(0, size - suffix); end = size - 1;
  } else {
    start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) {
      throw new RangeNotSatisfiableError(size);
    }
    end = Math.min(end, size - 1);
  }
  return { offset: start, length: end - start + 1 };
}

export const mediaBucket = {
  async put(key: string, value: ArrayBuffer | Uint8Array | ReadableStream<Uint8Array>, metadata: ObjectMetadata = {}) {
    const path = mediaPath(key);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = path + '.' + randomUUID() + '.tmp';
    const metadataTemporary = temporary + '.metadata';
    let linked = false;
    const hash = createHash('sha256');
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        if (value instanceof ReadableStream) {
          const hashing = new Transform({ transform(chunk, _encoding, done) {
            hash.update(chunk); done(null, chunk);
          } });
          await pipeline(Readable.fromWeb(value as import('node:stream/web').ReadableStream<Uint8Array>), hashing, handle.createWriteStream());
        } else {
          const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
          hash.update(bytes);
          await handle.writeFile(bytes);
        }
      } finally { await handle.close().catch(() => {}); }
      const stored: ObjectMetadata = {
        httpMetadata: { contentType: metadata.httpMetadata?.contentType || contentType(key) },
        customMetadata: metadata.customMetadata || {}, etag: hash.digest('hex'),
      };
      await writeFile(metadataTemporary, JSON.stringify(stored), { flag: 'wx', mode: 0o600 });
      // A collision fails instead of replacing an already cached object.
      await link(temporary, path); linked = true;
      await rename(metadataTemporary, path + '.metadata.json');
    } catch (error) {
      if (linked) await unlink(path).catch(() => {});
      throw error;
    } finally {
      await unlink(temporary).catch(() => {});
      await unlink(metadataTemporary).catch(() => {});
    }
  },

  async get(key: string, options?: { range?: Headers }) {
    const path = mediaPath(key);
    let file;
    try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new Error('素材文件无效');
      const range = parseRange(options?.range?.get('range') || null, stat.size);
      let metadata: ObjectMetadata = {};
      try { metadata = JSON.parse(await readFile(path + '.metadata.json', 'utf8')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const stream = file.createReadStream(range
        ? { start: range.offset, end: range.offset + range.length - 1, autoClose: true }
        : { autoClose: true });
      return {
        body: Readable.toWeb(stream) as ReadableStream<Uint8Array>, size: stat.size, range,
        httpEtag: '"' + (metadata.etag || `${stat.mtimeMs.toString(16)}-${stat.size.toString(16)}`) + '"',
        customMetadata: metadata.customMetadata || {},
        writeHttpMetadata(headers: Headers) {
          headers.set('Content-Type', metadata.httpMetadata?.contentType || contentType(key));
        },
      };
    } catch (error) { await file.close(); throw error; }
  },
};
