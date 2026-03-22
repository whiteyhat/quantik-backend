import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { Connection } from "@solana/web3.js";

let _connection: Connection | null = null;
let _client: DynamicBondingCurveClient | null = null;

// Returns singleton Solana Connection (reused by tokenService, swapService)
export function getSolanaConnection(): Connection {
  if (!_connection) {
    const rpcUrl = process.env.SOLANA_RPC_URL;
    if (!rpcUrl) throw new Error("SOLANA_RPC_URL not set in environment");
    _connection = new Connection(rpcUrl, "confirmed");
  }
  return _connection;
}

// Returns singleton DynamicBondingCurveClient initialized against SOLANA_RPC_URL
export function getDbcClient(): DynamicBondingCurveClient {
  if (!_client) {
    _client = new DynamicBondingCurveClient(getSolanaConnection(), "confirmed");
  }
  return _client;
}
