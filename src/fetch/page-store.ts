/**
 * page-store — the lossless side of fetch extraction.
 *
 * Holds, per project, the COMPLETE converted document for every page ever
 * fetched, plus every block of it with its `content` / `template` label. The
 * FTS index receives only `content` blocks; this store is what makes that
 * safe, because nothing has been thrown away — the whole document and every
 * template block remain here, verbatim and retrievable.
 *
 * It is also the comparison set. Classification asks one question — "was this
 * exact block already seen on a DIFFERENT page of this host?" — and that
 * question is answered by `page_blocks` joined to `pages`.
 *
 * Nothing in this file truncates. Full documents are stored whole; there is no
 * size cap, no prefix, no summary. (The fetch path upstream already refuses
 * responses above 50 MB before conversion.)
 *
 * No regular expressions (repo-wide ban).
 */

import type { Database as DatabaseInstance } from "better-sqlite3";
import { loadDatabase, applyWALPragmas, cleanOrphanedWALFiles, withRetry } from "../db-base.js";
import type { BlockKind, ClassifiedBlock } from "./blocks.js";

export interface StoredPage {
  pageKey: string;
  host: string;
  url: string;
  sourceLabel: string;
  route: string;
  provisional: boolean;
  fullText: string;
}

export interface StoredBlock {
  ordinal: number;
  hash: string;
  kind: BlockKind;
  raw: string;
  text: string;
}

/**
 * Canonical identity of a fetched page. The URL minus its fragment: two
 * fetches of the same page must be the same row, or a page compared against
 * an older copy of itself marks its own article as template.
 */
export function pageKeyFor(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.toString();
  } catch {
    return url;
  }
}

/** Host of a URL, lower-cased. Empty string when the URL will not parse. */
export function hostFor(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}

export class PageStore {
  #db: DatabaseInstance;

  constructor(dbPath: string) {
    const Database = loadDatabase();
    cleanOrphanedWALFiles(dbPath);
    this.#db = new Database(dbPath, { timeout: 30000 });
    applyWALPragmas(this.#db);
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS pages (
        page_key TEXT PRIMARY KEY,
        host TEXT NOT NULL,
        url TEXT NOT NULL,
        source_label TEXT NOT NULL,
        route TEXT NOT NULL,
        provisional INTEGER NOT NULL DEFAULT 0,
        fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
        full_text TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS page_blocks (
        page_key TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        hash TEXT NOT NULL,
        kind TEXT NOT NULL,
        raw TEXT NOT NULL,
        text TEXT NOT NULL,
        PRIMARY KEY (page_key, ordinal)
      );

      CREATE INDEX IF NOT EXISTS idx_pages_host ON pages(host);
      CREATE INDEX IF NOT EXISTS idx_page_blocks_hash ON page_blocks(hash);
    `);
  }

  /** Distinct pages already recorded for a host, excluding `exceptPageKey`. */
  hostPageCount(host: string, exceptPageKey: string): number {
    const row = this.#db
      .prepare("SELECT COUNT(*) AS n FROM pages WHERE host = ? AND page_key <> ?")
      .get(host, exceptPageKey) as { n: number } | undefined;
    return row ? row.n : 0;
  }

  /**
   * How many DISTINCT other pages of this host carry this exact block. The
   * `page_key <> ?` clause is what keeps a page from classifying itself.
   */
  otherPageCounts(host: string, exceptPageKey: string, hashes: string[]): Map<string, number> {
    const counts = new Map<string, number>();
    if (hashes.length === 0) return counts;
    const unique = Array.from(new Set(hashes));
    const stmt = this.#db.prepare(
      `SELECT COUNT(DISTINCT b.page_key) AS n
         FROM page_blocks b
         JOIN pages p ON p.page_key = b.page_key
        WHERE b.hash = ? AND p.host = ? AND b.page_key <> ?`,
    );
    for (const h of unique) {
      const row = stmt.get(h, host, exceptPageKey) as { n: number } | undefined;
      counts.set(h, row ? row.n : 0);
    }
    return counts;
  }

  /** Store one page whole: the complete document plus every labelled block. */
  recordPage(page: StoredPage, blocks: ClassifiedBlock[]): void {
    const insertPage = this.#db.prepare(
      `INSERT INTO pages (page_key, host, url, source_label, route, provisional, fetched_at, full_text)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?)
       ON CONFLICT(page_key) DO UPDATE SET
         host = excluded.host, url = excluded.url, source_label = excluded.source_label,
         route = excluded.route, provisional = excluded.provisional,
         fetched_at = excluded.fetched_at, full_text = excluded.full_text`,
    );
    const delBlocks = this.#db.prepare("DELETE FROM page_blocks WHERE page_key = ?");
    const insBlock = this.#db.prepare(
      "INSERT INTO page_blocks (page_key, ordinal, hash, kind, raw, text) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const tx = this.#db.transaction(() => {
      insertPage.run(
        page.pageKey, page.host, page.url, page.sourceLabel, page.route,
        page.provisional ? 1 : 0, page.fullText,
      );
      delBlocks.run(page.pageKey);
      for (const b of blocks) {
        insBlock.run(page.pageKey, b.ordinal, b.hash, b.kind, b.raw, b.text);
      }
    });
    withRetry(() => tx());
  }

  /** Update the stored labels after a re-run, and clear the provisional flag. */
  relabelPage(pageKey: string, blocks: ClassifiedBlock[], provisional: boolean): void {
    const upd = this.#db.prepare(
      "UPDATE page_blocks SET kind = ? WHERE page_key = ? AND ordinal = ?",
    );
    const updPage = this.#db.prepare("UPDATE pages SET provisional = ? WHERE page_key = ?");
    const tx = this.#db.transaction(() => {
      for (const b of blocks) upd.run(b.kind, pageKey, b.ordinal);
      updPage.run(provisional ? 1 : 0, pageKey);
    });
    withRetry(() => tx());
  }

  /** Every page of a host still carrying a cold-start (provisional) labelling. */
  provisionalPages(host: string, exceptPageKey: string): StoredPage[] {
    const rows = this.#db
      .prepare(
        `SELECT page_key, host, url, source_label, route, provisional, full_text
           FROM pages WHERE host = ? AND provisional = 1 AND page_key <> ?`,
      )
      .all(host, exceptPageKey) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      pageKey: String(r.page_key),
      host: String(r.host),
      url: String(r.url),
      sourceLabel: String(r.source_label),
      route: String(r.route),
      provisional: Number(r.provisional) === 1,
      fullText: String(r.full_text),
    }));
  }

  /** Every stored block of a page, in document order — content and template alike. */
  blocksOf(pageKey: string): StoredBlock[] {
    const rows = this.#db
      .prepare("SELECT ordinal, hash, kind, raw, text FROM page_blocks WHERE page_key = ? ORDER BY ordinal")
      .all(pageKey) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      ordinal: Number(r.ordinal),
      hash: String(r.hash),
      kind: String(r.kind) === "template" ? "template" : "content",
      raw: String(r.raw),
      text: String(r.text),
    }));
  }

  /** The complete converted document as it was stored, or null. */
  fullTextOf(pageKey: string): string | null {
    const row = this.#db.prepare("SELECT full_text FROM pages WHERE page_key = ?").get(pageKey) as
      | { full_text: string }
      | undefined;
    return row ? row.full_text : null;
  }

  close(): void {
    try { this.#db.close(); } catch { /* already closed */ }
  }
}
