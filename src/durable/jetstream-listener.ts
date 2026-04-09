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

const PUBLICATION_COLLECTION = "site.standard.publication";
const DOCUMENT_COLLECTION = "site.standard.document";
const JETSTREAM_URL = "wss://jetstream1.us-east.bsky.network/subscribe";
const RECONNECT_DELAY_MS = 5_000;

export class JetstreamListener extends DurableObject<Env> {
  private ws: WebSocket | null = null;
  private publishersFound = 0;
  private documentsIndexed = 0;
  private connected = false;
  private lastEventAt: string | null = null;

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
        this.handleMessage(event.data);
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
      if (!did || !collection || operation !== "create") return;

      this.lastEventAt = new Date().toISOString();

      if (collection === PUBLICATION_COLLECTION) {
        await this.registerPublisher(did);
      } else if (collection === DOCUMENT_COLLECTION) {
        await this.indexDocumentIfKnown(did, msg);
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

  private async indexDocumentIfKnown(
    did: string,
    msg: { commit?: { rkey?: string; record?: unknown } },
  ): Promise<void> {
    const rkey = msg.commit?.rkey;
    const rawRecord = msg.commit?.record;
    if (!rkey) return;

    const record = validateStandardDocument(rawRecord);
    if (!record) {
      console.warn(`Jetstream: invalid document record from ${did}/${rkey}`);
      return;
    }

    // Only insert documents from known publishers
    const known = await this.env.DB
      .prepare(`SELECT 1 FROM publishers WHERE did = ?`)
      .bind(did)
      .first();
    if (!known) return;

    const uri = `at://${did}/${DOCUMENT_COLLECTION}/${rkey}`;
    try {
      await upsertDocumentStmt(this.env.DB, uri, did, record).run();
      this.documentsIndexed++;
    } catch {
      // D1 write failed — non-fatal
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
