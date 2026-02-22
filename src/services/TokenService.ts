import { Token, IToken } from "../models/Token";

export class TokenService {
  static async getTokenByAddress(address: string): Promise<IToken | null> {
    return Token.findOne({ address }).exec();
  }

  static async getAllTokens(filter = {}, limit = 100): Promise<IToken[]> {
    return Token.find(filter).sort({ createdAt: -1 }).limit(limit).exec();
  }

  static async upsertToken(tokenData: Partial<IToken>): Promise<IToken> {
    return Token.findOneAndUpdate(
      { address: tokenData.address },
      { ...tokenData, timestamp: new Date() },
      { upsert: true, new: true }
    ).exec();
  }
}
