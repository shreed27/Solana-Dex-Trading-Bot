import { logger } from "../utils/logger";
import { connect } from "puppeteer-real-browser";
import { Token } from "../models/Token";
import { SwapService } from "./SwapService";
import { TokenService } from "./TokenService";

interface Token {
  symbol: string;
  address: string;
  price: number;
  volume24h: number;
  age: string;
  priceChange1h: string;
}

export class DexScreenerClient {
  private readonly url: string;
  private isRunning: boolean = false;
  private pollInterval: number = 30000; // 30 seconds
  private browser: any | null = null;
  private gotoPage: any | null = null;

  constructor() {
    this.url =
      "https://dexscreener.com/solana/5m?rankBy=trendingScoreH6&order=desc&maxAge=1";
  }

  public async connect(): Promise<void> {
    try {
      // this.browser = await puppeteer.launch({
      //   headless: false,
      //   defaultViewport: { width: 1920, height: 1080 },
      //   executablePath:
      //     process.platform === "darwin"
      //       ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" // macOS path
      //       : process.platform === "win32"
      //       ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" // Windows path
      //       : "/usr/bin/google-chrome", // Linux path
      //   args: [
      //     "--no-sandbox",
      //     "--disable-setuid-sandbox",
      //     "--start-maximized",
      //     "--new-window",
      //   ],
      // });
      const { browser, page } = await connect({
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--start-maximized",
          "--new-window",
        ],
        disableXvfb: false,
      });
      this.browser = browser;
      this.gotoPage = page;
      this.isRunning = true;
      await this.startPolling();
    } catch (error) {
      logger.error("Failed to launch browser:", error);
      throw error;
    }
  }

  private async startPolling(): Promise<void> {
    while (this.isRunning) {
      try {
        const tokens = await this.scrapeTokens();

        // Fetch richer token info from SwapService
        const addresses = tokens.map((t) => t.address).filter(Boolean);
        const swapService = new SwapService();
        const tokenInfoApi = await swapService.getTokenInfo(addresses);
        // console.log("tokenInfoApi", tokenInfoApi);
        const pools = tokenInfoApi?.pools || [];
        // Filter tokens by createdAt (within last 24 hours)
        const now = Date.now();
        const oneWeekMs = 7 * 24 * 60 * 60 * 1000;
        const tokensWithInfo = pools?.filter((t: any) => {
          const createdAt = t?.createdAt;
          if (!createdAt) return false;
          const createdAtTime = new Date(createdAt).getTime();
          return now - createdAtTime <= oneWeekMs;
        });

        // console.log("tokensWithInfo", JSON.stringify(tokensWithInfo, null, 2));

        if (tokensWithInfo.length === 0) {
          logger.info("No tokens to save");
          await new Promise((resolve) =>
            setTimeout(resolve, this.pollInterval)
          );
          continue;
        }

        // Save to database (upsert by address)
        for (const t of tokensWithInfo) {
          const baseAsset = t?.baseAsset || {};
          await TokenService.upsertToken({
            address: baseAsset.id,
            name: baseAsset.name,
            symbol: baseAsset.symbol,
            decimals: baseAsset.decimals,
            logoURI: baseAsset.icon,
            mcap: baseAsset.mcap,
            liquidity: t?.liquidity,
            volume24h: t?.volume24h,
            createdAt: baseAsset.createdAt,
            price: baseAsset.usdPrice,
            age: t.age,
            priceChange1h: t.priceChange1h,
          });
        }
        logger.success(`Saved ${tokensWithInfo.length} tokens to DB`);
        // Wait before next poll
        await new Promise((resolve) => setTimeout(resolve, this.pollInterval));
      } catch (error) {
        logger.error("Error during polling:", error);
        // Wait a bit before retrying after error
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }

  private async scrapeTokens(): Promise<Token[]> {
    if (!this.browser || !this.gotoPage) {
      throw new Error("Browser not initialized");
    }

    const page = this.gotoPage;

    try {
      logger.info("Setting viewport and user agent...");
      await page.setViewport({ width: 1920, height: 1080 });
      await page.setUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36"
      );

      logger.info("Navigating to URL...");
      await page.goto(this.url, {
        waitUntil: "networkidle0",
        timeout: 60000,
      });

      logger.info("Waiting for content to load...");
      await page.waitForFunction(
        () =>
          document.querySelectorAll("a[class*='ds-dex-table-row']").length > 0,
        { timeout: 30000 }
      );

      logger.info("Starting evaluation...");
      const tokens = await page.evaluate(() => {
        // Add helper function inside evaluate
        const parseVolume = (volumeText: string): number => {
          const value = volumeText.replace("$", "").trim();
          const multiplier = value.endsWith("K")
            ? 1000
            : value.endsWith("M")
            ? 1000000
            : value.endsWith("B")
            ? 1000000000
            : 1;
          return parseFloat(value.replace(/[KMB]/g, "")) * multiplier;
        };

        const rows = Array.from(
          document.querySelectorAll("a[class*='ds-dex-table-row']")
        ).slice(0, 10);

        console.log("Found rows:", rows.length);

        return rows.map((row) => {
          // Get token address from icon image URL
          const tokenImg = row.querySelector(
            ".ds-dex-table-row-token-icon-img"
          );
          let address = null;
          if (tokenImg) {
            const imgSrc = tokenImg.getAttribute("src") || "";
            const matches = imgSrc.match(/\/solana\/(.+?)\.png/);
            address = matches ? matches[1] : null;
          }

          // Get symbol
          const symbol =
            row
              .querySelector(".ds-dex-table-row-base-token-symbol")
              ?.textContent?.trim() || "";
          // Get price
          const priceText =
            row
              .querySelector(".ds-dex-table-row-col-price")
              ?.textContent?.trim() || "0";
          const price = parseFloat(priceText.replace("$", ""));

          // Get volume with units
          const volumeText =
            row
              .querySelector(".ds-dex-table-row-col-volume")
              ?.textContent?.trim() || "0";
          const volume24h = parseVolume(volumeText);

          // Get age
          const age =
            row
              .querySelector(".ds-dex-table-row-col-pair-age")
              ?.textContent?.trim() || "";

          // Get 1h price change
          const priceChange1h =
            row
              .querySelector(".ds-dex-table-row-col-price-change-h1")
              ?.textContent?.trim() || "0%";

          return {
            symbol,
            address,
            price,
            volume24h,
            age,
            priceChange1h,
          };
        });
      });

      logger.success(`Scraped ${tokens.length} tokens`);
      return tokens;
    } catch (error) {
      logger.error("Error scraping tokens:", error);
      throw error;
    }
  }

  public async disconnect(): Promise<void> {
    this.isRunning = false;
    if (this.gotoPage) {
      await this.gotoPage.close();
    }
    if (this.browser) {
      await this.browser.close();
    }
    logger.info("Disconnected from DexScreener");
  }
}
