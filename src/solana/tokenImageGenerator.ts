import sharp from "sharp";

interface MetadataUploadParams {
  name: string;
  symbol: string;
  description: string;
  imageBuffer: Buffer;
}

// Generates 256x256 PNG: Quantik gradient circle (#7B61FF → #00D1FF) with centered emoji
export async function generateTokenImage(emoji: string, _agentName: string): Promise<Buffer> {
  const svg = `<svg width="256" height="256" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" style="stop-color:#7B61FF"/>
        <stop offset="100%" style="stop-color:#00D1FF"/>
      </linearGradient>
    </defs>
    <circle cx="128" cy="128" r="128" fill="url(#bg)"/>
    <text x="128" y="155" font-size="100" text-anchor="middle" dominant-baseline="middle">${emoji}</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

// Uploads metadata JSON + image to Pinata IPFS (free tier, 100 files).
// Requires: PINATA_API_KEY and PINATA_SECRET_API_KEY env vars.
// Returns: "https://gateway.pinata.cloud/ipfs/{CID}" URI string.
export async function uploadTokenMetadata(params: MetadataUploadParams): Promise<string> {
  const { name, symbol, description, imageBuffer } = params;
  const apiKey = process.env.PINATA_API_KEY;
  const secretKey = process.env.PINATA_SECRET_API_KEY;
  if (!apiKey || !secretKey) {
    throw new Error("PINATA_API_KEY and PINATA_SECRET_API_KEY must be set in environment");
  }

  // Step 1: Upload image to Pinata
  const FormData = (await import("form-data")).default;
  const formData = new FormData();
  formData.append("file", imageBuffer, { filename: `${symbol.toLowerCase()}.png`, contentType: "image/png" });
  formData.append("pinataMetadata", JSON.stringify({ name: `${symbol}-image` }));

  const imageUploadRes = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
    method: "POST",
    headers: { pinata_api_key: apiKey, pinata_secret_api_key: secretKey, ...formData.getHeaders() },
    body: formData as unknown as Parameters<typeof fetch>[1] extends { body?: infer B } ? B : never,
  });
  if (!imageUploadRes.ok) throw new Error(`Pinata image upload failed: ${imageUploadRes.status}`);
  const imageData = await imageUploadRes.json() as { IpfsHash: string };
  const imageCid = imageData.IpfsHash;
  const imageUri = `https://gateway.pinata.cloud/ipfs/${imageCid}`;

  // Step 2: Upload metadata JSON
  const metadata = { name, symbol, description, image: imageUri };
  const metadataRes = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      pinata_api_key: apiKey,
      pinata_secret_api_key: secretKey,
    },
    body: JSON.stringify({ pinataContent: metadata, pinataMetadata: { name: `${symbol}-metadata` } }),
  });
  if (!metadataRes.ok) throw new Error(`Pinata metadata upload failed: ${metadataRes.status}`);
  const metaData = await metadataRes.json() as { IpfsHash: string };
  return `https://gateway.pinata.cloud/ipfs/${metaData.IpfsHash}`;
}
