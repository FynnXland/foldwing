# Foldwing documentation

Most documents are in English; the Cloudflare Tunnel guide also exists in German, and the
relay worker's setup guide is German only. The source code is the final authority; each
document states the version it describes.

| Document | Language | What it covers |
|---|---|---|
| [relay.md](relay.md) | English | How internet links work: the public relay `share.fynn.land`, the data flow, what is stored and for how long, security measures, reports, running your own relay. **Start here if you want to know what happens to your links.** |
| [cloudflare-tunnel.md](cloudflare-tunnel.md) | English | The *Eigene Domain* mode: links on your own domain through your own Cloudflare Tunnel, step by step |
| [cloudflare-tunnel.de.md](cloudflare-tunnel.de.md) | German | The same guide in German |
| [architecture.md](architecture.md) | English | Processes, upload path, path families, HTTP server and security headers, previews, sharing on demand, relay client, tunnel, updates, screenshots, platform seams. **Start here if you want to contribute code.** |
| [releasing.md](releasing.md) | English | For the maintainer: version, changelog, tag, the GitHub Actions release draft, publishing, relay deploys |
| [../worker/relay/README.md](../worker/relay/README.md) | German | Setting up and deploying the relay worker: D1, variables, rate limits, moderation |

## Elsewhere in the repository

- [../README.md](../README.md) ([Deutsch](../README.de.md)): what Foldwing does, download, modes, everyday use, privacy, troubleshooting
- [../CONTRIBUTING.md](../CONTRIBUTING.md): how to set up, test and submit changes
- [../SECURITY.md](../SECURITY.md): how to report a vulnerability or abuse, and what is in scope
- [../CHANGELOG.md](../CHANGELOG.md): what changed in each version (German)
- [../THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md): licenses of the bundled components
- [media/](media/): the images used in the README, rendered from the real interface with
  invented data by `media/make_media.mjs`
