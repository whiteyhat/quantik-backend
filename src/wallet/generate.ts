import WDK from "@tetherto/wdk";
import WalletManagerEvm from "@tetherto/wdk-wallet-evm";

export interface GeneratedWallet {
  address: string;
  privateKey: string;
  seedPhrase: string;
}

export async function generateWalletCredentials(): Promise<GeneratedWallet> {
  const seedPhrase = WDK.getRandomSeedPhrase();
  const wdk = new WDK(seedPhrase);
  wdk.registerWallet("ethereum", WalletManagerEvm, {});

  const account = await wdk.getAccount("ethereum", 0);
  try {
    const address = await account.getAddress();
    const privateKeyBytes = account.keyPair.privateKey;
    if (!privateKeyBytes) {
      throw new Error("Failed to derive private key");
    }

    return {
      address,
      privateKey: "0x" + Buffer.from(privateKeyBytes).toString("hex"),
      seedPhrase,
    };
  } finally {
    account.dispose();
  }
}
