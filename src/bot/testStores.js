// For tests: the stores to run against. SQLite always, and Postgres too when
// TEST_DATABASE_URL names a database, each test file in its own schema so
// files can run side by side.

import { openDb, closeDb } from './db.js';

export function storesFor(schema) {
  process.env.DATABASE_SCHEMA = schema;
  const stores = [['sqlite', ':memory:']];
  if (process.env.TEST_DATABASE_URL) {
    stores.push(['postgres', process.env.TEST_DATABASE_URL]);
  }
  return stores;
}

/** Close whatever is open and start from an empty store of this kind. */
export async function freshStore(kind, target) {
  await closeDb();
  if (kind === 'postgres') {
    const { default: pg } = await import('pg');
    const client = new pg.Client({ connectionString: target });
    await client.connect();
    await client.query(`drop schema if exists "${process.env.DATABASE_SCHEMA}" cascade`);
    await client.end();
  }
  await openDb(target);
}
