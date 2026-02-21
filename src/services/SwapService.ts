import axios from "axios";
import { UltraSwapRequest, UltraSwapResponse } from "../types/types";

export class SwapService {
  private readonly headers = {
    accept: "application/json",
    "sec-ch-ua":
      '"Google Chrome";v="137", "Chromium";v="137", "Not/A)Brand";v="24"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
    Referer: "https://jup.ag/",
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
  };
  static async getUltraSwap(
    params: UltraSwapRequest
  ): Promise<UltraSwapResponse | null> {
    const url = `https://ultra-api.jup.ag/order`;
    try {
      const response = await axios.get(url, {
        params,
        headers: {
          "sec-ch-ua-platform": '"macOS"',
          Referer: "https://jup.ag/",
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
          "sec-ch-ua":
            '"Not)A;Brand";v="8", "Chromium";v="138", "Google Chrome";v="138"',
          "sec-ch-ua-mobile": "?0",
        },
      });
      return response.data;
    } catch (error) {
      // console.error("Failed to fetch ultra swap", error);
      return null;
    }
  }

  public async getTokenPrice(tokenAddresss: string[]) {
    const url = `https://fe-api.jup.ag/api/v1/prices?list_address=${tokenAddresss.join(
      ","
    )}`;
    try {
      const response = await axios.get(url);
      return response.data;
    } catch (error) {
      console.error("Failed to fetch token price", error);
      return null;
    }
  }
  public async getTokenInfo(addresses: string[]) {
    const url = `https://datapi.jup.ag/v1/pools?assetIds=${addresses.join(
      ","
    )}`;
    try {
      const response = await axios.get(url, {
        headers: this.headers,
      });
      return response.data;
    } catch (error) {
      console.error("Failed to fetch token info", error);
      return null;
    }
  }
}
