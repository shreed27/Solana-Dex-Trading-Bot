# Solana DEX Bot

A Solana-based trading bot that automatically monitors and trade trending tokens of Dexscreener using Jupiter's API.

## Features

- **Automated Trading**: Monitors trending tokens of Dexscreener and executes buy/sell orders
- **Position Management**: Tracks open positions with PnL monitoring
- **Risk Management**: Automatic stop-loss (-25%) and take-profit (30%) triggers
- **Real-time Data**: Scrapes DexScreener for trending tokens
- **Smart Filtering**: Filters tokens by liquidity, market cap, and age

## Setup

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Environment variables**
   Create a `.env` file:

   ```
   SOLANA_PRIVATE_KEY=your_wallet_private_key
   SOLANA_RPC_URL=your_rpc_endpoint
   MONGODB_URI=your_mongodb_connection_string
   ```

3. **Build and run**
   ```bash
   npm run build
   npm start
   ```

## Usage

The bot runs automatically with two main cron jobs:

- **Buy Strategy**: Runs every minute, finds eligible tokens and opens positions
- **PnL Monitoring**: Runs every 2 minutes, checks positions and triggers sells

## Configuration

- Max positions: 3
- Investment per token: $30
- Stop loss: -25%
- Take profit: +30%

## Tech Stack

- TypeScript
- Solana Web3.js
- Jupiter Ultra API
- MongoDB with Mongoose
- Puppeteer for web scraping
