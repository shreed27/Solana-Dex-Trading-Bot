import WebSocket from "ws";
import { IUnifiedOrderbook } from "../types/exchange.types";
import { logger } from "../utils/logger";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const POLYMARKET_WS_URL =
  "wss://ws-subscriptions-clob.polymarket.com/ws/market";

const HEARTBEAT_INTERVAL_MS = 10_000;
const BASE_RECONNECT_MS = 3_000;
const MAX_RECONNECT_MS = 30_000;

// ---------------------------------------------------------------------------
// PolymarketWebSocketFeed
// ---------------------------------------------------------------------------

export class PolymarketWebSocketFeed {
  private ws: WebSocket | null = null;
  private books: Map<string, IUnifiedOrderbook> = new Map();
  private bookCallbacks: ((
    tokenId: string,
    book: IUnifiedOrderbook
  ) => void)[] = [];
  private tradeCallbacks: ((
    tokenId: string,
    price: number,
    size: number,
    side: string
  ) => void)[] = [];
  private subscribedTokens: string[] = [];
  private connected: boolean = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private tokenLabels: Map<string, string> = new Map();
  private reconnectAttempts: number = 0;

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Open a WebSocket connection and subscribe to the given token IDs.
   * An optional `labels` map provides human-readable names for logging.
   */
  connect(tokenIds: string[], labels?: Map<string, string>): void {
    this.subscribedTokens = [...tokenIds];

    if (labels) {
      this.tokenLabels = new Map(labels);
    }

    this.openConnection();
  }

  /**
   * Gracefully shut down: close the socket, clear all timers.
   */
  disconnect(): void {
    this.clearHeartbeat();
    this.clearReconnect();

    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore close errors
      }
      this.ws = null;
    }

    this.connected = false;
    logger.info("[PolymarketWS] Disconnected");
  }

  /**
   * Subscribe to additional markets on an already-open connection.
   * If the socket is not yet open the tokens are queued for the next connect.
   */
  addMarkets(tokenIds: string[], labels?: Map<string, string>): void {
    const newIds: string[] = [];
    for (const id of tokenIds) {
      if (!this.subscribedTokens.includes(id)) {
        this.subscribedTokens.push(id);
        newIds.push(id);
      }
    }

    // Update labels for new AND existing tokens
    if (labels) {
      for (const [id, label] of labels) {
        this.tokenLabels.set(id, label);
      }
    }

    // Only subscribe new tokens (already subscribed ones get data)
    if (newIds.length > 0 && this.connected && this.ws && this.ws.readyState === WebSocket.OPEN) {
      const subscribeMsg = JSON.stringify({
        assets_ids: newIds,
        type: "market",
        custom_feature_enabled: true,
      });
      this.ws.send(subscribeMsg);
      logger.info(
        `[PolymarketWS] Subscribed to ${newIds.length} NEW market(s) (${this.subscribedTokens.length} total)`
      );
    }
  }

  /**
   * Register a callback that fires whenever a book snapshot or update occurs.
   */
  onBookUpdate(
    callback: (tokenId: string, book: IUnifiedOrderbook) => void
  ): void {
    this.bookCallbacks.push(callback);
  }

  /**
   * Register a callback that fires when a last-trade-price event arrives.
   */
  onTrade(
    callback: (
      tokenId: string,
      price: number,
      size: number,
      side: string
    ) => void
  ): void {
    this.tradeCallbacks.push(callback);
  }

  /**
   * Return the latest local orderbook for a given token ID, or null.
   */
  getOrderbook(tokenId: string): IUnifiedOrderbook | null {
    return this.books.get(tokenId) ?? null;
  }

  /**
   * Return the entire books map (all token IDs).
   */
  getAllOrderbooks(): Map<string, IUnifiedOrderbook> {
    return this.books;
  }

  /**
   * Whether the WebSocket is currently open.
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Number of orderbooks currently maintained.
   */
  getBookCount(): number {
    return this.books.size;
  }

  // -----------------------------------------------------------------------
  // Private — connection lifecycle
  // -----------------------------------------------------------------------

  private openConnection(): void {
    this.clearReconnect();

    try {
      this.ws = new WebSocket(POLYMARKET_WS_URL);
    } catch (err) {
      logger.error("[PolymarketWS] Failed to create WebSocket", err);
      this.scheduleReconnect();
      return;
    }

    this.ws.on("open", () => {
      this.connected = true;
      this.reconnectAttempts = 0;
      logger.success(
        `[PolymarketWS] Connected — subscribing to ${this.subscribedTokens.length} token(s)`
      );

      // Subscribe
      const subscribeMsg = JSON.stringify({
        assets_ids: this.subscribedTokens,
        type: "market",
        custom_feature_enabled: true,
      });
      this.ws!.send(subscribeMsg);

      // Start heartbeat
      this.startHeartbeat();
    });

    this.ws.on("message", (raw: WebSocket.Data) => {
      this.handleMessage(raw);
    });

    this.ws.on("close", (code: number, reason: Buffer) => {
      this.connected = false;
      this.clearHeartbeat();
      logger.warning(
        `[PolymarketWS] Connection closed (code=${code}, reason=${reason.toString()})`
      );
      this.scheduleReconnect();
    });

    this.ws.on("error", (err: Error) => {
      this.connected = false;
      this.clearHeartbeat();
      logger.error("[PolymarketWS] WebSocket error", err);
      // The "close" event normally follows; reconnect is handled there.
      // If the socket is already destroyed, schedule reconnect here.
      if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
        this.scheduleReconnect();
      }
    });
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send("PING");
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * Exponential back-off: 3 s, 6 s, 12 s, 24 s, 30 s (capped).
   */
  private scheduleReconnect(): void {
    this.clearReconnect();
    const delayMs = Math.min(
      BASE_RECONNECT_MS * Math.pow(2, this.reconnectAttempts),
      MAX_RECONNECT_MS
    );
    this.reconnectAttempts++;

    logger.info(
      `[PolymarketWS] Reconnecting in ${(delayMs / 1000).toFixed(1)}s (attempt #${this.reconnectAttempts})`
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnect();
    }, delayMs);
  }

  private reconnect(): void {
    // Ensure the old socket is fully closed before re-opening
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }

    this.openConnection();
  }

  // -----------------------------------------------------------------------
  // Private — message handling
  // -----------------------------------------------------------------------

  private handleMessage(raw: WebSocket.Data): void {
    const text = typeof raw === "string" ? raw : raw.toString();

    // Heartbeat response
    if (text === "PONG") {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      logger.warning(`[PolymarketWS] Unparseable message: ${text.slice(0, 120)}`);
      return;
    }

    // The server may send a single event object or an array of events.
    const events: unknown[] = Array.isArray(parsed) ? parsed : [parsed];

    for (const event of events) {
      if (typeof event !== "object" || event === null) {
        continue;
      }
      this.handleEvent(event as Record<string, unknown>);
    }
  }

  private handleEvent(event: Record<string, unknown>): void {
    const eventType = event["event_type"] as string | undefined;

    switch (eventType) {
      case "book":
        this.handleBookSnapshot(event);
        break;
      case "price_change":
        this.handlePriceChange(event);
        break;
      case "last_trade_price":
        this.handleLastTradePrice(event);
        break;
      default:
        // Unknown event types are silently ignored.
        break;
    }
  }

  // ---- book (full snapshot) ---------------------------------------------

  private handleBookSnapshot(event: Record<string, unknown>): void {
    const assetId = event["asset_id"] as string | undefined;
    if (!assetId) return;

    const rawBids = (event["bids"] as unknown[]) ?? [];
    const rawAsks = (event["asks"] as unknown[]) ?? [];

    const book = this.buildUnifiedBook(assetId, rawBids, rawAsks);
    this.books.set(assetId, book);

    const label = this.tokenLabels.get(assetId) ?? assetId.slice(0, 12);
    logger.info(
      `[PolymarketWS] Book snapshot for ${label} — ` +
        `${book.bids.length} bids, ${book.asks.length} asks, mid=${book.midPrice.toFixed(4)}`
    );

    this.fireBookCallbacks(assetId, book);
  }

  // ---- price_change (incremental) ---------------------------------------

  private handlePriceChange(event: Record<string, unknown>): void {
    const changes = (event["price_changes"] as unknown[]) ?? [];

    // Group changes by asset to fire one callback per asset.
    const touchedAssets = new Set<string>();

    for (const raw of changes) {
      if (typeof raw !== "object" || raw === null) continue;
      const change = raw as Record<string, unknown>;

      const assetId = change["asset_id"] as string | undefined;
      if (!assetId) continue;

      const price = parseFloat(change["price"] as string);
      const size = parseFloat(change["size"] as string);
      const side = (change["side"] as string)?.toLowerCase();

      if (isNaN(price) || isNaN(size)) continue;

      let book = this.books.get(assetId);
      if (!book) {
        // We haven't received a snapshot yet — create a minimal book.
        book = this.buildUnifiedBook(assetId, [], []);
        this.books.set(assetId, book);
      }

      const bookSide: "bids" | "asks" =
        side === "sell" || side === "ask" ? "asks" : "bids";
      this.updateBookLevel(book, bookSide, price, size);

      touchedAssets.add(assetId);
    }

    for (const assetId of touchedAssets) {
      const book = this.books.get(assetId);
      if (book) {
        this.recalculateMidAndSpread(book);
        this.fireBookCallbacks(assetId, book);
      }
    }
  }

  // ---- last_trade_price -------------------------------------------------

  private handleLastTradePrice(event: Record<string, unknown>): void {
    const assetId = event["asset_id"] as string | undefined;
    if (!assetId) return;

    const price = parseFloat(event["price"] as string);
    const size = parseFloat((event["size"] as string) ?? "0");
    const side = ((event["side"] as string) ?? "unknown").toLowerCase();

    if (isNaN(price)) return;

    for (const cb of this.tradeCallbacks) {
      try {
        cb(assetId, price, isNaN(size) ? 0 : size, side);
      } catch (err) {
        logger.error("[PolymarketWS] Trade callback error", err);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Private — orderbook helpers
  // -----------------------------------------------------------------------

  /**
   * Build an `IUnifiedOrderbook` from raw bid/ask arrays whose entries
   * have `price` and `size` as strings (Polymarket convention).
   */
  private buildUnifiedBook(
    assetId: string,
    rawBids: unknown[],
    rawAsks: unknown[]
  ): IUnifiedOrderbook {
    const parseLevels = (
      levels: unknown[]
    ): { price: number; size: number }[] => {
      const result: { price: number; size: number }[] = [];
      for (const lvl of levels) {
        if (typeof lvl !== "object" || lvl === null) continue;
        const obj = lvl as Record<string, unknown>;
        const price = parseFloat(obj["price"] as string);
        const size = parseFloat(obj["size"] as string);
        if (!isNaN(price) && !isNaN(size) && size > 0) {
          result.push({ price, size });
        }
      }
      return result;
    };

    const bids = parseLevels(rawBids).sort((a, b) => b.price - a.price);
    const asks = parseLevels(rawAsks).sort((a, b) => a.price - b.price);

    const bestBid = bids.length > 0 ? bids[0].price : 0;
    const bestAsk = asks.length > 0 ? asks[0].price : 0;
    const midPrice =
      bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : bestBid || bestAsk;
    const spread = bestBid > 0 && bestAsk > 0 ? bestAsk - bestBid : 0;

    const label = this.tokenLabels.get(assetId) ?? assetId;

    return {
      exchange: "polymarket",
      symbol: label,
      bids,
      asks,
      midPrice,
      spread,
      timestamp: Date.now(),
    };
  }

  /**
   * Update (upsert or remove) a single price level in the local book.
   * If `size` is 0 the level is removed; otherwise it is inserted or updated.
   * The affected side is re-sorted after mutation.
   */
  private updateBookLevel(
    book: IUnifiedOrderbook,
    side: "bids" | "asks",
    price: number,
    size: number
  ): void {
    const levels = book[side];
    const idx = levels.findIndex(
      (l) => Math.abs(l.price - price) < 1e-12
    );

    if (size === 0) {
      // Remove level
      if (idx !== -1) {
        levels.splice(idx, 1);
      }
    } else if (idx !== -1) {
      // Update existing level
      levels[idx].size = size;
    } else {
      // Insert new level
      levels.push({ price, size });
    }

    // Re-sort: bids descending, asks ascending
    if (side === "bids") {
      levels.sort((a, b) => b.price - a.price);
    } else {
      levels.sort((a, b) => a.price - b.price);
    }

    book.timestamp = Date.now();
  }

  /**
   * Recalculate midPrice and spread from the current best bid/ask.
   */
  private recalculateMidAndSpread(book: IUnifiedOrderbook): void {
    const bestBid = book.bids.length > 0 ? book.bids[0].price : 0;
    const bestAsk = book.asks.length > 0 ? book.asks[0].price : 0;

    book.midPrice =
      bestBid > 0 && bestAsk > 0
        ? (bestBid + bestAsk) / 2
        : bestBid || bestAsk;
    book.spread = bestBid > 0 && bestAsk > 0 ? bestAsk - bestBid : 0;
  }

  // -----------------------------------------------------------------------
  // Private — callback dispatch
  // -----------------------------------------------------------------------

  private fireBookCallbacks(tokenId: string, book: IUnifiedOrderbook): void {
    for (const cb of this.bookCallbacks) {
      try {
        cb(tokenId, book);
      } catch (err) {
        logger.error("[PolymarketWS] Book callback error", err);
      }
    }
  }
}
