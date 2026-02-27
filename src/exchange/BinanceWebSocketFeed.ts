import WebSocket from "ws";
import { logger } from "../utils/logger";

const BINANCE_WS_URL = "wss://stream.binance.com:9443/ws";

const SYMBOL_TO_ASSET: Record<string, string> = {
  BTCUSDT: "BTC",
  ETHUSDT: "ETH",
  SOLUSDT: "SOL",
  XRPUSDT: "XRP",
  DOGEUSDT: "DOGE",
  AVAXUSDT: "AVAX",
  LINKUSDT: "LINK",
  SUIUSDT: "SUI",
  NEARUSDT: "NEAR",
  APTUSDT: "APT",
  ARBUSDT: "ARB",
  OPUSDT: "OP",
  SEIUSDT: "SEI",
  TIAUSDT: "TIA",
  FETUSDT: "FET",
  PEPEUSDT: "PEPE",
  WIFUSDT: "WIF",
  JUPUSDT: "JUP",
  INJUSDT: "INJ",
  RENDERUSDT: "RENDER",
};

const ASSETS = [
  "btcusdt", "ethusdt", "solusdt", "xrpusdt", "dogeusdt",
  "avaxusdt", "linkusdt", "suiusdt", "nearusdt", "aptusdt",
  "arbusdt", "opusdt", "seiusdt", "tiausdt", "fetusdt",
  "pepeusdt", "wifusdt", "jupusdt", "injusdt", "renderusdt",
];

const MAX_PRICE_HISTORY = 200;

type PriceCallback = (
  asset: string,
  price: number,
  change10s: number,
  change30s: number
) => void;

export class BinanceWebSocketFeed {
  private ws: WebSocket | null = null;
  private prices: Map<string, { price: number; timestamp: number }[]> =
    new Map();
  private latestPrices: Map<string, number> = new Map();
  private priceCallbacks: PriceCallback[] = [];
  private connected = false;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor() {
    for (const symbol of ASSETS) {
      const asset = SYMBOL_TO_ASSET[symbol.toUpperCase()];
      if (asset) {
        this.prices.set(asset, []);
      }
    }
  }

  connect(): void {
    logger.info(`[BinanceWS] Connecting to ${BINANCE_WS_URL}`);

    this.ws = new WebSocket(BINANCE_WS_URL);

    this.ws.on("open", () => {
      this.connected = true;
      logger.success("[BinanceWS] Connected to Binance WebSocket");

      const subscribeMsg = JSON.stringify({
        method: "SUBSCRIBE",
        params: ASSETS.map((a) => `${a}@miniTicker`),
        id: 1,
      });

      this.ws?.send(subscribeMsg);
      logger.info(
        `[BinanceWS] Subscribed to miniTicker for ${ASSETS.join(", ")}`
      );
    });

    this.ws.on("message", (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());

        // Skip subscription confirmation responses
        if (msg.result !== undefined) {
          return;
        }

        const symbol: string | undefined = msg.s;
        const closePrice: string | undefined = msg.c;

        if (!symbol || !closePrice) {
          return;
        }

        const asset = SYMBOL_TO_ASSET[symbol];
        if (!asset) {
          return;
        }

        const price = parseFloat(closePrice);
        if (isNaN(price) || price <= 0) {
          return;
        }

        const now = Date.now();

        // Update ring buffer
        let history = this.prices.get(asset);
        if (!history) {
          history = [];
          this.prices.set(asset, history);
        }

        history.push({ price, timestamp: now });

        // Trim to max size
        if (history.length > MAX_PRICE_HISTORY) {
          history.splice(0, history.length - MAX_PRICE_HISTORY);
        }

        // Update latest price
        this.latestPrices.set(asset, price);

        // Compute changes
        const change10s = this.computeChange(asset, 10_000);
        const change30s = this.computeChange(asset, 30_000);

        // Fire callbacks
        for (const cb of this.priceCallbacks) {
          try {
            cb(asset, price, change10s, change30s);
          } catch (err) {
            logger.error("[BinanceWS] Error in price callback", err);
          }
        }
      } catch (err) {
        logger.error("[BinanceWS] Failed to parse message", err);
      }
    });

    this.ws.on("close", (code: number, reason: Buffer) => {
      this.connected = false;
      logger.warning(
        `[BinanceWS] Connection closed (code=${code}, reason=${reason.toString()})`
      );
      this.reconnect();
    });

    this.ws.on("error", (err: Error) => {
      this.connected = false;
      logger.error("[BinanceWS] WebSocket error", err);
      this.reconnect();
    });
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.removeAllListeners();
      if (
        this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING
      ) {
        this.ws.close();
      }
      this.ws = null;
    }

    this.connected = false;
    logger.info("[BinanceWS] Disconnected");
  }

  onPrice(
    callback: (
      asset: string,
      price: number,
      change10s: number,
      change30s: number
    ) => void
  ): void {
    this.priceCallbacks.push(callback);
  }

  getLatestPrice(asset: string): number {
    return this.latestPrices.get(asset) ?? 0;
  }

  getPriceHistory(asset: string): { price: number; timestamp: number }[] {
    return this.prices.get(asset) ?? [];
  }

  getPriceChange(asset: string, windowMs: number): number {
    return this.computeChange(asset, windowMs);
  }

  isPump(asset: string, threshold = 0.005): boolean {
    return Math.abs(this.getPriceChange(asset, 10_000)) > threshold;
  }

  isConnected(): boolean {
    return this.connected;
  }

  private reconnect(): void {
    if (this.reconnectTimer) {
      return;
    }

    logger.info("[BinanceWS] Scheduling reconnect in 3 seconds...");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 3_000);
  }

  private computeChange(asset: string, windowMs: number): number {
    const history = this.prices.get(asset);
    if (!history || history.length < 2) {
      return 0;
    }

    const current = history[history.length - 1];
    const cutoff = current.timestamp - windowMs;

    // Scan backwards to find the oldest entry within the window
    let oldestInWindow = current;
    for (let i = history.length - 2; i >= 0; i--) {
      if (history[i].timestamp < cutoff) {
        break;
      }
      oldestInWindow = history[i];
    }

    if (oldestInWindow === current || oldestInWindow.price === 0) {
      return 0;
    }

    return (current.price - oldestInWindow.price) / oldestInWindow.price;
  }
}
