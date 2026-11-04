# Your own domain with Cloudflare Tunnel

Status: Foldwing 1.4.0. [Deutsche Fassung](cloudflare-tunnel.de.md)

By default, Foldwing's links run through the public relay `share.fynn.land` and work anywhere
without any setup. This guide is for the third mode, *Eigene Domain* (Own domain): links use
your own domain, such as `https://share.example.com/s/…`, and run through a Cloudflare Tunnel
in your own Cloudflare account. The relay isn't involved, nobody else can block your links, and
you don't depend on a service someone else runs for free. Foldwing starts the cloudflared
program that comes with it and keeps it running while something is shared. You don't open a
port on your router.

Foldwing's interface is German. This guide gives its labels as they appear on screen, with
the meaning in brackets. Cloudflare's labels are quoted from its English dashboard; Cloudflare
changes them now and then, so if a label differs, follow Cloudflare's own guide
[Create a tunnel (dashboard)](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/).

## What you need

- A Cloudflare account. The free plan is enough.
- Your own domain, added to your Cloudflare account: Cloudflare guides you through it, and
  you point the domain's nameservers to Cloudflare at your registrar. Domains usually cost a
  yearly fee.
- Foldwing installed on the PC that holds your shares.

## What changes for your files

Your files are still stored only on your PC. When someone opens a link, the download travels
from your PC through the tunnel to Cloudflare and from there to the recipient, encrypted on
both legs. The encryption ends at Cloudflare, though, so Cloudflare could technically see what
passes through. If that is not acceptable for a file, share it in *Nur im eigenen Netzwerk*
mode (Only in your own network).

## Setting it up

1. **Create the tunnel.** In the Cloudflare dashboard, go to *Networking → Tunnels* and select
   *Create a tunnel*. Name it, for example `foldwing`, and select *Create Tunnel*.
2. **Copy the token.** Cloudflare now shows an installation command for your operating system.
   Don't run it, because Foldwing runs cloudflared itself. Copy only the token from it: the
   long string that starts with `eyJ`. Keep it private; anyone who has it can run your tunnel.
3. **Connect Foldwing.** Open the *Einstellungen* (Settings) tab → card *Links* and choose
   *Über deine eigene Domain* (Over your own domain). Enter your address, for example
   `share.example.com`, under *Adresse* (Address), paste the token under *Tunnel-Token* and
   select *Speichern und verwenden* (Save and use). Foldwing
   starts the tunnel and keeps it up for a few minutes even if nothing is shared yet, so you
   can finish the next step.
4. **Route your domain to Foldwing.** Back in the dashboard, Cloudflare now sees the
   connection; select *Continue*, or open the tunnel later from *Networking → Tunnels*. On the
   *Routes* tab, select *Add route* → *Published application*. Enter a subdomain, for example
   `share`, choose your domain, and enter `http://localhost:8787` as *Service URL*. Select
   *Add route*.
5. **Test it.** In Foldwing, select *Verbindung testen* (Test connection). *Erreichbar*
   (Reachable) means your links work. From now on, copied links use your domain.

If you need the token again later: open the tunnel under *Networking → Tunnels* and select
*Add a replica*; the installation command shown there contains the same token.

## Good to know

- **Links work while Foldwing runs and your PC is awake and online.** Closing the window is
  fine; *Beenden* (Quit) in the tray menu takes the links offline.
- **The tunnel rests when nothing is shared.** One minute after the last share is gone,
  Foldwing stops the server and the tunnel, and the settings say *Ruht* (resting). Sharing
  something starts both again.
- **Port 8787.** Foldwing listens on this port. If another program already uses it, Foldwing
  falls back to a random free port, and the tunnel can't reach it. Close the other program
  and restart Foldwing.
- **The token is stored in plain text** in `%APPDATA%\foldwing\foldwing-config.json` (Linux:
  `~/.config/foldwing/foldwing-config.json`). Treat that file like a password. If the token
  leaks, open the tunnel in the Cloudflare dashboard and select *Refresh token* on its
  *Overview* tab (or delete the tunnel and create a new one), then paste the new token into
  Foldwing.
- **Switching modes changes your links.** A link contains the mode's address, so links you
  sent in *Internet* mode stop working after you switch to your own domain, and the other way
  round.
- **Already have a tunnel with `config.yml`?** Foldwing only runs tunnels by token. Create a
  separate tunnel for Foldwing in the dashboard as described above.

## Troubleshooting

| Problem | What to do |
|---|---|
| **Status *Für die eigene Domain fehlen noch Adresse oder Tunnel-Token.*** (Address or tunnel token missing) | Enter both and select *Speichern*. A saved token isn't shown again; the field then says *Token ist gespeichert*. |
| **Status *Verbindung zu Cloudflare unterbrochen*** (Connection to Cloudflare lost) right after saving | Usually the token is wrong. Paste the whole token again, without spaces, and save. |
| ***cloudflared fehlt*** (cloudflared missing) | Release builds include cloudflared. Reinstall Foldwing; in a build of your own, run `node scripts/fetch-cloudflared.mjs`. |
| ***Keine Antwort*** (No answer) **or *Nicht erreichbar*** (Not reachable) | The domain doesn't lead to the tunnel yet. Check the route (*Service URL* `http://localhost:8787`) and, under *DNS* in the dashboard, that a proxied CNAME record for your subdomain points to `<tunnel ID>.cfargotunnel.com`. New DNS records can take a few minutes. |
| ***Unter der Adresse antwortet etwas anderes*** (Something else answers at this address) | Cloudflare or another server answers instead of Foldwing. Check that the route points to `http://localhost:8787`, not to another port. |
| **The test works, recipients sometimes get an error page** | Foldwing wasn't running, the PC was asleep, or the share had expired. |
