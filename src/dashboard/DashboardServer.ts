import http from "http";
import path from "path";
import fs from "fs";
import { WebSocketServer, WebSocket } from "ws";
import { DemoWallet } from "../exchange/DemoWallet";
import { PerformanceTracker } from "../polymarket/PerformanceTracker";
import { MultiExchangeTickEngine } from "../exchange/MultiExchangeTickEngine";
import { HFTTickEngine } from "../polymarket/HFTTickEngine";
import { DashboardPayloadBuilder } from "./DashboardPayloadBuilder";
import { logger } from "../utils/logger";

export class DashboardServer {
  private httpServer: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private broadcastInterval: NodeJS.Timeout | null = null;
  private payloadBuilder: DashboardPayloadBuilder;
  private port: number;
  private startTime: number = 0;

  constructor(
    demoWallet: DemoWallet,
    perfTracker: PerformanceTracker,
    multiExchangeEngine: MultiExchangeTickEngine,
    hftEngine: HFTTickEngine,
    port = 3847
  ) {
    this.payloadBuilder = new DashboardPayloadBuilder(
      demoWallet,
      perfTracker,
      multiExchangeEngine,
      hftEngine
    );
    this.port = port;
  }

  async start(): Promise<void> {
    this.startTime = Date.now();

    // Create HTTP server for static file serving
    this.httpServer = http.createServer((req, res) => {
      if (req.url === "/" || req.url === "/index.html") {
        const htmlPath = path.join(__dirname, "dashboard.html");
        fs.readFile(htmlPath, (err, data) => {
          if (err) {
            res.writeHead(500);
            res.end("Error loading dashboard");
            return;
          }
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(data);
        });
      } else if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", uptime: Date.now() - this.startTime }));
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
    });

    // Create WebSocket server
    this.wss = new WebSocketServer({ server: this.httpServer });

    this.wss.on("connection", (ws) => {
      // Send initial payload immediately
      const payload = this.payloadBuilder.build();
      ws.send(JSON.stringify(payload));
    });

    // Broadcast to all connected clients every 500ms
    this.broadcastInterval = setInterval(() => {
      if (!this.wss || this.wss.clients.size === 0) return;

      const payload = this.payloadBuilder.build();
      const data = JSON.stringify(payload);

      for (const client of this.wss.clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(data);
        }
      }
    }, 500);

    return new Promise((resolve) => {
      this.httpServer!.listen(this.port, () => {
        logger.success(`Dashboard server running at http://localhost:${this.port}`);
        resolve();
      });
    });
  }

  stop(): void {
    if (this.broadcastInterval) {
      clearInterval(this.broadcastInterval);
      this.broadcastInterval = null;
    }

    if (this.wss) {
      for (const client of this.wss.clients) {
        client.close();
      }
      this.wss.close();
      this.wss = null;
    }

    if (this.httpServer) {
      this.httpServer.close();
      this.httpServer = null;
    }

    logger.info("Dashboard server stopped");
  }

  getClientCount(): number {
    return this.wss ? this.wss.clients.size : 0;
  }
}
