FROM node:20-slim

# Install curl + ca-certs for the Polymarket CLI install script
RUN apt-get update && apt-get install -y curl ca-certificates && rm -rf /var/lib/apt/lists/*

# Install Polymarket CLI (pre-built Linux binary)
RUN curl -sSL https://raw.githubusercontent.com/Polymarket/polymarket-cli/main/install.sh | sh

# Make sure the binary is on PATH
ENV PATH="/root/.local/bin:${PATH}"
ENV POLYMARKET_CLI="/root/.local/bin/polymarket"

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .
RUN npm run build

EXPOSE 3001

CMD ["npm", "start"]
