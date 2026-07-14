# BrowseFreely 🌐

A fast, modern, and lightweight web proxy/browser built with **Bun**, **Hono**, and **JSX**. Browse the web seamlessly with built-in ad-blocking, advanced anti-fingerprinting, and robust Single Page Application (SPA) support.

## ✨ Features

- 🚀 **Blazing Fast**: Built on [Bun](https://bun.sh/) and [Hono](https://hono.dev/) for incredibly fast server-side rendering and edge-ready execution.
- 🛡️ **Built-in Adblocker**: Integrates `@ghostery/adblocker` to automatically drop trackers, ads, and telemetry scripts natively, saving bandwidth and protecting your privacy.
- 👻 **Advanced Anti-Fingerprinting**:
  - **User-Agent Spoofing:** Select your desired device identity directly from the homepage.
  - **Canvas Spoofing:** Injects client-side scripts to invisibly alter Canvas API readouts, preventing trackers from fingerprinting your specific hardware.
  - **WebRTC Protection:** Blocks WebRTC IP leak loopholes on the client-side.
- 🍪 **Encrypted Session Jar**: Log into websites *through* the proxy. Site cookies are AES-256-GCM encrypted in memory, keyed by your `bf_session` cookie **and** source IP, and never written to your browser.
- 📖 **Reader Mode (NoScript)**: Instantly strip all JavaScript from a proxied page for maximum speed, security, and easy reading.
- ⚡ **Asset Caching**: Includes a built-in LRU cache (partitioned per session) to serve repeated static assets directly from memory.
- 🧩 **SPA Compatibility**: Includes custom fetch interceptors and catch-all routing to support React, Next.js, and other modern Single Page Applications that typically break inside standard proxies.
- 🚫 **Anti-adblock bypass**: Cosmetic filters + detection stubs help pages render even when sites try to block adblock users.
- 📝 **Broken-site reports**: Hit **Site broken?** in the proxy bar to log a URL locally and (when `GITHUB_TOKEN` is set) open a GitHub issue so Cursor can investigate from the repo.
- 🔒 **Security First**: SSRF protection with redirect re-checks, optional LAN targeting, TLS verification on by default, plus rate limiting.
- 💅 **Modern UI**: Clean, minimalistic, dark-mode native interface using server-rendered JSX.

## 🛠️ Tech Stack

- **Runtime**: [Bun](https://bun.sh/)
- **Framework**: [Hono](https://hono.dev/)
- **Templating**: JSX (Server-side rendered)
- **Adblocker**: `@ghostery/adblocker`
- **Language**: TypeScript

## 🐳 Docker Deployment (Recommended)

Images are built by GitHub Actions and published to **GitHub Container Registry**:

```text
ghcr.io/avbuse/browsefreely:latest
```

Other tags: `sha-<commit>` on every `main` push, and `vX.Y.Z` when you push a version tag.

### Option 1: Using Docker Compose
Download the `docker-compose.yml` from this repository, set a real `SESSION_SECRET`, then run:
```bash
# Only needed if the GHCR package is private:
# echo $GITHUB_TOKEN | docker login ghcr.io -u YOUR_GITHUB_USERNAME --password-stdin

docker compose up -d
```

### Option 2: Using Docker Run
```bash
docker run -d -p 3000:3000 \
  -e RATE_LIMIT=100 \
  -e SESSION_SECRET=change-me-to-a-long-random-string \
  --name browsefreely \
  --restart unless-stopped \
  ghcr.io/avbuse/browsefreely:latest
```

### Build locally
```bash
docker build -t browsefreely:local .
docker run -d -p 3000:3000 -e SESSION_SECRET=dev ghcr.io/avbuse/browsefreely:latest
```

Navigate to `http://localhost:3000` and start browsing!

> **Note:** After the first successful Actions run on `main`, open the package under the repo’s **Packages** tab and set visibility to **Public** if you want pull-without-login.

## 📦 Native Installation & Setup

### Prerequisites
You need to have [Bun](https://bun.sh/) installed on your machine.

```bash
# Install Bun
curl -fsSL https://bun.sh/install | bash
```

### Local Development

1. Clone the repository:
   ```bash
   git clone https://github.com/vinitkumargoel/BrowseFreely.git
   cd BrowseFreely
   ```

2. Copy the environment file and adjust if necessary:
   ```bash
   cp .env.example .env
   ```

3. Install dependencies:
   ```bash
   bun install
   ```

4. Start the development server:
   ```bash
   bun run dev
   ```

5. Open your browser and navigate to `http://localhost:3000`.

## ⚙️ Configuration (Environment Variables)

You can configure BrowseFreely by creating a `.env` file or passing environment variables in Docker/PM2:

* `PORT` - The port the proxy server listens on (Default: `3000`)
* `NODE_ENV` - Set to `production` for optimized performance
* `RATE_LIMIT` - Max requests per minute per IP address (Default: `100`)
* `SESSION_SECRET` - Long random string used to encrypt the in-memory cookie jar (required for stable sessions across restarts)
* `SECURE_COOKIES` - `true`/`false` to force the Secure cookie flag (default: Secure only when serving HTTPS)
* `TRUST_PROXY` - `true` to trust `X-Forwarded-For` / `CF-Connecting-IP` (default: `false`; use only behind a trusted proxy)
* `ALLOW_PRIVATE_TARGETS` - `true` to allow proxying LAN/private IPs (default: `false`)
* `REPORTS_PATH` - Path for broken-site JSONL log (Default: `./data/broken-sites.jsonl`)
* `GITHUB_TOKEN` - PAT with Issues write access; enables GitHub issues from **Site broken?**
* `GITHUB_REPO` - `owner/name` for issues (Default: `avbuse/BrowseFreely`)
* `GITHUB_ISSUE_LABELS` - Comma-separated labels (Default: `broken-site,anti-adblock`)
* `INSECURE_TLS` - `true` to skip upstream TLS verification (default: `false`)

## 🚀 Production Native Deployment

BrowseFreely includes configuration for deploying with [PM2](https://pm2.keymetrics.io/).

1. Install PM2 globally:
   ```bash
   npm install -g pm2
   ```

2. Start the application in production mode:
   ```bash
   bun run pm2:start
   ```

3. Manage your deployment:
   ```bash
   bun run pm2:logs   # View live logs
   bun run pm2:stop   # Stop the server
   ```

## 🤝 Contributing

We welcome contributions! Please see our [Contributing Guidelines](CONTRIBUTING.md) for more details on how to get started. Have ideas? Check out our [ISSUES.md](ISSUES.md) roadmap!

Please also adhere to our [Code of Conduct](CODE_OF_CONDUCT.md).

## ⚠️ Disclaimer

This project is created for educational and privacy-enhancing purposes. The maintainers of BrowseFreely are not responsible for any misuse of this software. Please do not use this tool to bypass legal restrictions, access illicit content, or violate the Terms of Service of target websites.

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
