/**
 * JetstreamListener — Durable Object for persistent publisher discovery.
 *
 * Holds a long-lived WebSocket to Jetstream filtered to
 * site.standard.document creates. When a document event arrives,
 * the authoring DID is registered as a publisher in D1.
 *
 * Uses alarms to reconnect if the WebSocket drops.
 * Activate by fetching: env.JETSTREAM_LISTENER.get(id).fetch("/start")
 */

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.js";

const COLLECTION = "site.standard.document";
const JETSTREAM_URL = "wss://jetstream1.us-east.bsky.network/subscribe";
const RECONNECT_DELAY_MS = 5_000;

export class JetstreamListener extends DurableObject<Env> {
  private ws: WebSocket | null = null;
  private publishersFound = 0;
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
          lastEventAt: this.lastEventAt,
        });

      case "/stop":
        this.disconnectFromJetstream();
        return Response.json({ status: "stopped" });

      case "/status":
        return Response.json({
          connected: this.connected,
          publishersFound: this.publishersFound,
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
    url.searchParams.set("wantedCollections", COLLECTION);

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

      if (msg.kind === "commit" && msg.commit?.collection === COLLECTION) {
        const did = msg.did as string;
        if (!did) return;

        this.lastEventAt = new Date().toISOString();

        // Register publisher in D1 (idempotent)
        try {
          await this.env.DB.prepare(
            `INSERT OR IGNORE INTO publishers (did, label) VALUES (?, ?)`,
          )
            .bind(did, "auto:jetstream-do")
            .run();

          this.publishersFound++;
        } catch {
          // D1 write failed — non-fatal, we'll catch it next time
        }
      }
    } catch {
      // Skip malformed messages
    }
  }
}
