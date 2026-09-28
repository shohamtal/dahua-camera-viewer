# NVR admin CLI (`scripts/nvr.mjs`)

A small terminal tool for managing a Dahua NVR over its HTTP CGI API: list and
create users, reset passwords, read the device log, and check whether the NVR is
exposed to the internet. It reuses the extension's digest client (`lib/dahua.js`),
needs only Node 18+, and has no dependencies.

Typical use: give each apartment / family member / guard their **own limited
account** instead of sharing the admin password.

> ## ⚠️ Don't share sensitive data
>
> Command output contains **real secrets and identifying data**. Never paste it
> into issues, PRs, gists, chats or screenshots, and never commit it:
>
> - admin / user **passwords** (including generated ones printed by `adduser`,
>   `bulkadd`, `passwd`)
> - the `*-accounts.csv` files written by `bulkadd` (gitignored — hand out, then delete)
> - device **serial number** (it is also the P2P cloud ID), MAC address, P2P keys
> - public / LAN IP addresses, usernames, account notes (memos), camera names
> - `nvr log` output (IPs, usernames, timestamps)
>
> Keep the password in the `NVR_PASS` env var, not on the command line. When
> reporting a problem, redact first: `192.168.1.108`, `admin`, `********`.

## Setup

```bash
cd dahua-cam-extension
export NVR_HOST=192.168.1.108      # add :port if not 80
export NVR_USER=admin              # optional, default admin
read -rs NVR_PASS && export NVR_PASS   # type the password, not echoed / not in history
alias nvr='node scripts/nvr.mjs'
nvr help
```

## Commands

### Device

```bash
nvr info                 # model, firmware, camera (channel) names
nvr exposure             # UPnP port forwards, P2P cloud, ports, who's logged in
nvr upnp off             # stop the NVR opening ports on your router
nvr p2p off              # disable the Dahua P2P cloud (DMSS app stops working remotely)
```

### Users

```bash
nvr users                # all accounts: group, memo, which cameras
nvr users -v             # same, with raw permission names
nvr active               # who is logged in right now, from which IP

nvr adduser apt1                          # all cameras, live + playback, random password
nvr adduser apt1 --channels 1,3,8         # only these cameras
nvr adduser apt1 --no-playback            # live view only
nvr adduser apt1 --password 'Abc12345x'   # choose the password

nvr bulkadd apt 1 26                      # apt1…apt26 → apt-accounts.csv (chmod 600)
nvr bulkadd apt 1 26 --channels 1,2,8 --no-playback

nvr deluser someuser otheruser            # asks before each; --yes to skip
nvr passwd apt5                           # new random password for another user
nvr passwd admin 'NewStrongPass9'         # change the admin (your own) password
nvr perms apt5 --channels 5,6             # change which cameras a user sees
```

New accounts go in the built-in **`user` group** and get only `Monitor_NN`
(live) and optionally `Replay_NN` (playback) for the chosen channels — no
settings, no PTZ, no user management, no delete/backup.

### Log

```bash
nvr log                                   # last 50 entries
nvr log --last 500
nvr log --from 2026-01-01 --to 2026-01-31
nvr log --grep 192.168                    # filter by IP / user / event text
nvr log --last 2000 | grep -v <your-pc-ip>   # hide your own sessions
```

## Notes & gotchas

- **Passwords**: Dahua requires 8–32 chars mixing at least two of
  letters/digits/symbols. Generated ones are 10 chars, letters + digits, no
  look-alike characters.
- **`passwd` for another user** deletes and recreates the account with the same
  group/permissions/memo — the CGI API can't set another user's password without
  knowing the old one. For your own account it uses `modifyPassword`.
- **`deluser`** refuses to delete reserved accounts (`admin`) or the account the
  CLI is logged in with.
- **The log is a ring buffer** (≈1024 entries on NVR4108-class devices). Every
  CLI call logs a login/logout, so running many commands pushes old history out.
  Save it before investigating: `nvr log --last 2000 > log-backup.txt` (don't commit it).
- Logins from `127.0.0.1` are normally the P2P cloud relay (the DMSS app).
- Permission names (`Monitor_01`, `Replay_01`, …) are what DHI-NVR4108 firmware
  3.215 uses. If `adduser` fails on another model, run `nvr users -v` and check
  the names the existing accounts use.

## Security checklist — signs your NVR was compromised

Old Dahua firmware has known authentication-bypass bugs that bots exploit to
**silently add their own admin accounts**. Run `nvr users` and `nvr exposure`:

| Red flag | What to do |
|---|---|
| Accounts in the `admin` group you don't recognise (random names like `lkdflms`, `rsrvdusr`, `admdah`, memo `CISA`, …) | `nvr deluser …`, then change the admin password |
| `UPnP: ENABLED` with a forward on **37777** / 80 / 554 | `nvr upnp off`, **and** remove the forward in the router's UPnP / port-forward page |
| Firmware years old | Update from Dahua's download center for your exact model — without this, deleted accounts come back |
| Weak admin password, or a password written in an account memo | `nvr passwd admin` with a long random one |

Order that works: `upnp off` → remove router forwards → delete unknown accounts →
`passwd admin` → update firmware → re-check `nvr users` a few days later → then
create the limited accounts. For remote viewing, prefer a VPN (WireGuard /
Tailscale) over port forwarding — see the README's *Remote access* section.
