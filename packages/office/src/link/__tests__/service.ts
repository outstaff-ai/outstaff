import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import {
  decodeLinkMessage,
  LINK_VERSION,
  encodeLinkMessage,
  type LinkMessage,
  type LinkRequest,
  type LinkResponse,
} from "@outstaff/protocol";
import { WebSocketServer, type WebSocket } from "ws";

/** A service stand-in: accepts links with the right token and records what each one sends. */
export class FakeService {
  readonly links: { ws: WebSocket; headers: IncomingMessage["headers"]; inbox: LinkMessage[] }[] =
    [];
  readonly raw: string[] = [];
  refuse = false;
  private wss: WebSocketServer;

  constructor(readonly token: string) {
    this.wss = new WebSocketServer({
      port: 0,
      host: "127.0.0.1",
      verifyClient: (info, done) =>
        this.refuse || info.req.headers.authorization !== `Bearer ${this.token}`
          ? done(false, 401, "Unauthorized")
          : done(true),
    });

    this.wss.on("connection", (ws, req) => {
      const link = { ws, headers: req.headers, inbox: [] as LinkMessage[] };
      this.links.push(link);
      ws.on("message", (data: Buffer) => {
        this.raw.push(data.toString());
        const m = decodeLinkMessage(data.toString());
        if (m.ok) {
          link.inbox.push(m.message);
        }
      });
    });
  }

  async ready() {
    await new Promise<void>((resolve) =>
      this.wss.address() ? resolve() : this.wss.once("listening", () => resolve()),
    );
  }

  get url() {
    return `ws://127.0.0.1:${(this.wss.address() as AddressInfo).port}/link`;
  }

  get last() {
    return this.links.at(-1)!;
  }

  send(m: LinkMessage, link = this.last) {
    link.ws.send(encodeLinkMessage(m));
  }

  welcome(version = LINK_VERSION, link = this.last) {
    this.send({ type: "welcome", payload: { version, office: { id: "acme" } } }, link);
  }

  private n = 0;

  /** Sends a request and waits for its response. */
  async request(r: Omit<LinkRequest, "id">, link = this.last): Promise<LinkResponse> {
    const id = `r${++this.n}`;
    this.send({ type: "request", payload: { ...r, id } as LinkRequest }, link);
    await until(() => this.of("response", link).some((m) => m.payload.id === id));
    return this.of("response", link).find((m) => m.payload.id === id)!.payload;
  }

  of<T extends LinkMessage["type"]>(type: T, link = this.last) {
    return link.inbox.filter((m): m is Extract<LinkMessage, { type: T }> => m.type === type);
  }

  async close() {
    for (const c of this.wss.clients) {
      c.terminate();
    }

    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}

/** Waits for a condition that depends on the network. */
export async function until(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) {
      throw new Error("timed out");
    }

    await new Promise((r) => setTimeout(r, 5));
  }
}
