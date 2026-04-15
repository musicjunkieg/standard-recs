/**
 * JetstreamListener — Durable Object for persistent publisher discovery.
 *
 * Holds a long-lived WebSocket to Jetstream filtered to two collections:
 *   - site.standard.publication — registers the DID as a publisher
 *   - site.standard.document    — if from a known publisher, inserts into D1
 *
 * Uses alarms to reconnect if the WebSocket drops.
 * Activate by fetching: env.JETSTREAM_LISTENER.get(id).fetch("/start")
 */

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.js";
import { upsertDocumentStmt, type StandardDocument } from "../sync/documents.js";
import { vectorIds } from "../recommend/vector-id.js";

const PUBLICATION_COLLECTION = "site.standard.publication";
const DOCUMENT_COLLECTION = "site.standard.document";
const JETSTREAM_URL = "wss://jetstream1.us-east.bsky.network/subscribe";
const RECONNECT_DELAY_MS = 5_000;

export class JetstreamListener extends DurableObject<Env> {
  private ws: WebSocket | null = null;
  private publishersFound = 0;
  private documentsIndexed = 0;
  private documentsUpdated = 0;
  private documentsDeleted = 0;
  private documentsRejected = 0;
  private connected = false;
  private lastEventAt: string | null = null;
  /**
   * Serializes handleMessage calls so commit order is preserved.
   * WebSocket message events fire synchronously as they arrive,
   * but handleMessage is async — without explicit chaining, two
   * messages touching the same document (e.g., create → update,
   * or create → delete) could interleave their awaits and race
   * at D1, leaving the table in whichever order the writes
   * happened to land rather than the order the publisher
   * committed them. Chaining each new handler onto this promise
   * guarantees each message fully completes before the next
   * starts. Errors are logged and swallowed so a single bad
   * payload doesn't break the chain for subsequent messages.
   */
  private messageQueue: Promise<void> = Promise.resolve();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    switch (url.pathname) {
      case "/start":
        await this.ensureConnected();
        return Response.json({
          status: "running",
          connected: this.connected,
          publishersFound: this.publishersFound,
          documentsIndexed: this.documentsIndexed,
          documentsUpdated: this.documentsUpdated,
          documentsDeleted: this.documentsDeleted,
          documentsRejected: this.documentsRejected,
          lastEventAt: this.lastEventAt,
        });

      case "/stop":
        this.disconnectFromJetstream();
        return Response.json({ status: "stopped" });

      case "/status":
        return Response.json({
          connected: this.connected,
          publishersFound: this.publishersFound,
          documentsIndexed: this.documentsIndexed,
          documentsUpdated: this.documentsUpdated,
          documentsDeleted: this.documentsDeleted,
          documentsRejected: this.documentsRejected,
          lastEventAt: this.lastEventAt,
        });

      default:
        return Response.json({ error: "Unknown path" }, { status: 404 });
    }
  }

  /**
   * Alarm handler — reconnect if the WebSocket dropped.
   */
  async alarm(): Promise<void> {
    if (!this.connected) {
      console.log("JetstreamListener: alarm fired, reconnecting...");
      await this.connectToJetstream();
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.connected && this.ws) return;
    await this.connectToJetstream();
  }

  private async connectToJetstream(): Promise<void> {
    this.disconnectFromJetstream();

    const url = new URL(JETSTREAM_URL);
    url.searchParams.append("wantedCollections", PUBLICATION_COLLECTION);
    url.searchParams.append("wantedCollections", DOCUMENT_COLLECTION);

    try {
      const ws = new WebSocket(url.toString());
      this.ws = ws;

      ws.addEventListener("open", () => {
        this.connected = true;
        console.log("JetstreamListener: connected to Jetstream");
      });

      ws.addEventListener("message", (event) => {
        // See messageQueue's JSDoc above for why this chains
        // through a promise rather than invoking handleMessage
        // directly.
        this.messageQueue = this.messageQueue
          .then(() => this.handleMessage(event.data))
          .catch((err) => {
            console.error("JetstreamListener: handleMessage threw:", err);
          });
      });

      ws.addEventListener("close", () => {
        this.connected = false;
        this.ws = null;
        console.log("JetstreamListener: disconnected, scheduling reconnect");
        // Schedule alarm to reconnect
        this.ctx.storage.setAlarm(Date.now() + RECONNECT_DELAY_MS);
      });

      ws.addEventListener("error", () => {
        this.connected = false;
        try { ws.close(); } catch { /* */ }
        this.ws = null;
        this.ctx.storage.setAlarm(Date.now() + RECONNECT_DELAY_MS);
      });
    } catch (err) {
      console.error("JetstreamListener: connection failed", err);
      this.ctx.storage.setAlarm(Date.now() + RECONNECT_DELAY_MS);
    }
  }

  private disconnectFromJetstream(): void {
    if (this.ws) {
      try { this.ws.close(); } catch { /* */ }
      this.ws = null;
    }
    this.connected = false;
  }

  private async handleMessage(data: string | ArrayBuffer): Promise<void> {
    try {
      const msg = JSON.parse(
        typeof data === "string"
          ? data
          : new TextDecoder().decode(data),
      );

      if (msg.kind !== "commit") return;
      const did = msg.did as string;
      const collection = msg.commit?.collection as string | undefined;
      const operation = msg.commit?.operation as string | undefined;
      if (!did || !collection || !operation) return;

      this.lastEventAt = new Date().toISOString();

      if (collection === PUBLICATION_COLLECTION) {
        // Only handle publication creates. Updates and deletes on
        // publication records are intentional no-ops: publication URL
        // changes are picked up by the next cron's listRecords walk
        // (INSERT OR REPLACE), and a publication delete is an
        // ambiguous signal we don't want to act on automatically.
        // See docs/superpowers/specs/2026-04-14-doc-sync-rev-check-design.md
        // for the full rationale.
        if (operation === "create") {
          await this.registerPublisher(did);
        }
        return;
      }

      if (collection === DOCUMENT_COLLECTION) {
        const rkey = msg.commit?.rkey as string | undefined;
        if (!rkey) return;
        const record = msg.commit?.record as unknown;
        await this.handleDocumentOp(did, operation, rkey, record);
      }
    } catch {
      // Skip malformed messages
    }
  }

  private async registerPublisher(did: string): Promise<void> {
    try {
      const result = await this.env.DB.prepare(
        `INSERT OR IGNORE INTO publishers (did, label) VALUES (?, ?)`,
      )
        .bind(did, "auto:jetstream-do")
        .run();
      // Only count actual new rows — INSERT OR IGNORE on duplicates returns 0 changes
      if ((result.meta.changes ?? 0) > 0) {
        this.publishersFound++;
      }
    } catch {
      // D1 write failed — non-fatal
    }
  }

  /**
   * Route a site.standard.document commit op to the appropriate
   * handler. `create` and `update` share the indexer path because
   * upsertDocumentStmt is already INSERT OR REPLACE. `delete`
   * runs a new path that removes from D1 + Vectorize.
   */
  private async handleDocumentOp(
    did: string,
    operation: string,
    rkey: string,
    record: unknown,
  ): Promise<void> {
    // Both branches bump their own counter at the dispatch site so
    // `indexDocumentIfKnown` itself stays counter-free. Previously the
    // indexer bumped `documentsIndexed` internally, which double-counted
    // update events (they'd bump documentsIndexed AND documentsUpdated).
    // Keeping the counter logic here makes create/update semantics
    // symmetric and easy to reason about.
    if (operation === "create") {
      const wrote = await this.indexDocumentIfKnown(did, rkey, record);
      if (wrote) this.documentsIndexed++;
      return;
    }
    if (operation === "update") {
      const wrote = await this.indexDocumentIfKnown(did, rkey, record);
      if (wrote) this.documentsUpdated++;
      return;
    }
    if (operation === "delete") {
      await this.deleteDocument(did, rkey);
      return;
    }
    // Unknown operation — silently ignore. Jetstream event schema
    // is stable (create/update/delete), but being defensive here
    // means future ops don't crash the handler.
  }

  /**
   * Delete a document from both Vectorize and D1 on a Jetstream
   * delete event. Vector delete first, then D1 — orphan vectors
   * are cheaper to recover from than orphan D1 rows (see the spec
   * for the ordering rationale).
   *
   * Does NOT check the known-publisher filter. A publisher that
   * was known at some point in the past may have been removed
   * from the publishers table (e.g., marked bridged) but still
   * have documents in D1 that we want to respect deletes for.
   * DELETEs against nothing are cheap no-ops.
   */
  private async deleteDocument(did: string, rkey: string): Promise<void> {
    const uri = `at://${did}/${DOCUMENT_COLLECTION}/${rkey}`;

    // Vector first: if this fails, we get an orphan vector, which
    // is recoverable by a future diff-against-documents cleanup.
    try {
      const [vectorIdHash] = await vectorIds([uri]);
      await this.env.VECTORS.deleteByIds([vectorIdHash]);
    } catch (err) {
      console.warn(`Jetstream: vector delete failed for ${uri}:`, err);
    }

    // D1 second: batch two statements so recommendations are
    // cleaned up before the documents row (preventing a window
    // where a rec row points at a just-deleted doc row). Inspect
    // the per-statement changes count so `documentsDeleted` only
    // increments when a documents row was actually removed — a
    // delete event for a doc we never indexed is a no-op batch
    // that succeeds with zero rows affected, and counting it
    // would inflate the metric and mislead operators.
    try {
      const results = await this.env.DB.batch([
        this.env.DB
          .prepare(`DELETE FROM recommendations WHERE document_uri = ?`)
          .bind(uri),
        this.env.DB
          .prepare(`DELETE FROM documents WHERE uri = ?`)
          .bind(uri),
      ]);
      if ((results[1]?.meta?.changes ?? 0) > 0) {
        this.documentsDeleted++;
      }
    } catch (err) {
      console.warn(`Jetstream: D1 delete failed for ${uri}:`, err);
    }
  }

  private async indexDocumentIfKnown(
    did: string,
    rkey: string,
    record: unknown,
  ): Promise<boolean> {
    const validated = validateStandardDocument(record);
    if (!validated) {
      console.warn(`Jetstream: invalid document record from ${did}/${rkey}`);
      this.documentsRejected++;
      return false;
    }

    // Only insert documents from known, non-bridged publishers
    const known = await this.env.DB
      .prepare(
        `SELECT 1 FROM publishers WHERE did = ? AND COALESCE(label, '') != 'bridged'`,
      )
      .bind(did)
      .first();
    if (!known) return false;

    const uri = `at://${did}/${DOCUMENT_COLLECTION}/${rkey}`;
    try {
      await upsertDocumentStmt(this.env.DB, uri, did, validated).run();
      return true;
    } catch {
      // D1 write failed — non-fatal
      return false;
    }
  }
}

/**
 * Validate a Jetstream record payload as a StandardDocument.
 * Returns the typed record on success, null on failure.
 *
 * Required fields per the site.standard.document lexicon: site, title,
 * publishedAt. Other fields are optional and handled by upsertDocumentStmt.
 */
function validateStandardDocument(record: unknown): StandardDocument | null {
  if (!record || typeof record !== "object") return null;
  const r = record as Record<string, unknown>;
  if (typeof r.site !== "string" || !r.site) return null;
  if (typeof r.title !== "string" || !r.title) return null;
  if (typeof r.publishedAt !== "string" || !r.publishedAt) return null;
  return r as unknown as StandardDocument;
}
