FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Install core system dependencies
RUN apt-get update && apt-get install -y \
    curl \
    ca-certificates \
    build-essential \
    python3 \
    xz-utils \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js v22 (Required by @tetherto/wdk — bare-node-runtime + sodium-native)
RUN curl -fsSL https://nodejs.org/dist/v22.14.0/node-v22.14.0-linux-x64.tar.xz | tar -xJ --strip-components=1 -C /usr/local

# Install Polymarket CLI (Requires GLIBC 2.38+)
RUN curl -sSL https://raw.githubusercontent.com/Polymarket/polymarket-cli/main/install.sh | sh

# Make the CLI binary findable without relying on PATH in the Node process
ENV PATH="/root/.local/bin:${PATH}"
ENV POLYMARKET_CLI=/root/.local/bin/polymarket

WORKDIR /app

# Confirm environment
RUN node -v && npm -v && polymarket --version && ldd --version

COPY package*.json ./
RUN npm install

COPY . .
RUN npx tsc

EXPOSE 3001
CMD ["npm", "start"]
