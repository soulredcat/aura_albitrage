import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import type { PaperState } from '../paper/paper.types.js';
import type { PaperEvent } from '../paper/paper.validation.js';

export class PaperRepository {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, hash TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS journal (revision INTEGER PRIMARY KEY, event_id TEXT UNIQUE NOT NULL, body TEXT NOT NULL);`);
  }
  load(): PaperState | null {
    const row = this.db.prepare('SELECT body FROM state WHERE id=1').get() as { body: string } | undefined;
    return row ? JSON.parse(row.body) as PaperState : null;
  }
  initialize(state: PaperState) {
    this.db.prepare('INSERT OR IGNORE INTO state(id, revision, body) VALUES(1, ?, ?)')
      .run(state.revision, JSON.stringify(state));
  }
  eventHash(id: string): string | null {
    const row = this.db.prepare('SELECT hash FROM events WHERE id=?').get(id) as { hash: string } | undefined;
    return row?.hash ?? null;
  }
  loadEventHashes(): Map<string, string> {
    const rows = this.db.prepare('SELECT id, hash FROM events').all() as { id: string; hash: string }[];
    return new Map(rows.map(row => [row.id, row.hash]));
  }
  static hash(event: PaperEvent) { return createHash('sha256').update(JSON.stringify(event)).digest('hex'); }
  commit(previousRevision: number, state: PaperState, event: PaperEvent) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const updated = this.db.prepare('UPDATE state SET revision=?, body=? WHERE id=1 AND revision=?')
        .run(state.revision, JSON.stringify(state), previousRevision);
      if (updated.changes !== 1) throw new Error('Concurrent paper writer detected; reload before continuing');
      this.db.prepare('INSERT INTO events(id, hash, body) VALUES(?, ?, ?)')
        .run(event.id, PaperRepository.hash(event), JSON.stringify(event));
      this.db.prepare('INSERT INTO journal(revision, event_id, body) VALUES(?, ?, ?)')
        .run(state.revision, event.id, JSON.stringify(state));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
}
