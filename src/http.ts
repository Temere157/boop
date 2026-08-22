import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { log } from "./log.js";
import type {
  HttpRequest,
  HttpRoutes,
  HttpResponse,
  RouteHandler,
  UpgradeHandler,
} from "./plugin.js";

const http = log("http");

interface Route {
  readonly method: string;
  readonly path: string;
  readonly handler: RouteHandler;
}

interface Upgrade {
  readonly path: string;
  readonly handler: UpgradeHandler;
}

/**
 * The core HTTP server. This is shared infrastructure, not a plugin: many
 * plugins need to register webhook endpoints, so the server lives in core
 * and plugins register routes on it via {@link HttpRoutes}.
 *
 * The server buffers each request fully, hands a plain {@link HttpRequest}
 * to the matched route handler, and writes the returned {@link HttpResponse}
 * back out. Routing is exact method + pathname match (query strings are
 * ignored) — enough for webhook-style endpoints; richer routing can come
 * later without changing the plugin contract.
 */
export class HttpServer implements HttpRoutes {
  private routes: Route[] = [];
  private upgrades: Upgrade[] = [];
  private server: Server | null = null;

  route(method: string, path: string, handler: RouteHandler): void {
    this.routes.push({ method, path, handler });
  }

  upgrade(path: string, handler: UpgradeHandler): void {
    // Replace any existing handler at the same path; there is no reload
    // path today, but keeping the last registration wins avoids silent
    // duplicates.
    this.upgrades = this.upgrades.filter((u) => u.path !== path);
    this.upgrades.push({ path, handler });
  }

  /** Start listening. Resolves once the server is accepting connections. */
  listen(port: number, host: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        void this.handle(req, res);
      });
      this.server.on("upgrade", (req, socket, head) => {
        void this.handleUpgrade(req, socket, head);
      });
      const onError = (error: Error): void => reject(error);
      this.server.on("error", onError);
      this.server.listen(port, host, () => {
        this.server?.off("error", onError);
        resolve();
      });
    });
  }

  /** Stop accepting new connections. Resolves once existing ones drain. */
  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server === null) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
    });
  }

  /**
   * Dispatch an `upgrade` request to the matching path's handler, or
   * destroy the socket if none matches. Errors thrown by a handler are
   * logged and the socket is destroyed rather than left dangling.
   *
   * Node types the upgrade event's socket as `Duplex`; at runtime it is a
   * real `net.Socket` (an HTTP server only upgrades TCP sockets), so it is
   * safe to hand to {@link UpgradeHandler}s as a `Socket`.
   */
  private async handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const pathname = this.toPathname(req.url);
    const entry = this.upgrades.find((u) => u.path === pathname);
    if (entry === undefined) {
      socket.destroy();
      return;
    }
    try {
      entry.handler(req, socket as unknown as Socket, head);
    } catch (error) {
      http.error("upgrade handler error", error);
      socket.destroy();
    }
  }

  private async handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const pathname = this.toPathname(req.url);
    const route = this.routes.find(
      (r) => r.method === req.method && r.path === pathname,
    );
    if (route === undefined) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    const body = await this.readBody(req);
    const request: HttpRequest = {
      method: req.method ?? "",
      url: req.url ?? "/",
      headers: req.headers as Record<string, string | string[] | undefined>,
      body,
    };
    let response: HttpResponse;
    try {
      response = await route.handler(request);
    } catch (error) {
      http.error("route handler error", error);
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("internal error");
      return;
    }
    this.write(res, response);
  }

  private toPathname(url: string | undefined): string {
    try {
      return new URL(url ?? "/", "http://localhost").pathname;
    } catch {
      return url ?? "/";
    }
  }

  private readBody(req: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  private write(res: ServerResponse, response: HttpResponse): void {
    const headers: Record<string, string> = {
      "content-type": "text/plain",
      ...response.headers,
    };
    res.writeHead(response.status, headers);
    res.end(response.body ?? "");
  }
}
