import fs from "fs";
import path from "path";

const configPath = path.join(__dirname, "..", "..", "data", "fee_config.json");

interface FeeConfig {
  winnings_fee: number;
}

export function getFeeConfig(): FeeConfig {
  try {
    const data = fs.readFileSync(configPath, "utf-8");
    return JSON.parse(data) as FeeConfig;
  } catch (err) {
    return { winnings_fee: 0.02 };
  }
}
