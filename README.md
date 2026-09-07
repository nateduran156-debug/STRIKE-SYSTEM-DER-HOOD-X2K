# Discord Strike System

A Railway-ready Discord.js slash-command bot with a maximum of three active strikes per user. Moderation commands are whitelist-only. Every strike and appeal requires an image attachment.

## Commands

### Strike and review commands

- `/strike add user reason proof` — adds the next strike and posts the `1/3`, `2/3`, or `3/3` announcement.
- `/strike3 user consequence reason proof` — records the final strike after `2/3`, announces the consequence, and applies the blacklist roles.
- `/strike revoke user` — revokes the latest active strike.
- `/strike status user` — shows active strikes.
- `/strike history user` — shows active, revoked, expired, and boost-forgiven strikes.
- `/proof user` — displays the latest stored strike proof.
- `/revokeall` — revokes every active strike in the server.

Strikes expire after **60 days**. If a member starts boosting, their active strikes are temporarily forgiven. If they stop boosting, the previous strikes return unless their original 60-day expiration has passed.

### Whitelist and configuration

- `/wl add user`
- `/wl remove user`
- `/wl list`
- `/config audit channel`
- `/config appeals channel`
- `/config notes channel`
- `/config proof channel`
- `/config view`

Only the configured owner or a whitelisted user can use moderation, configuration, whitelist, backup, and notes commands. Server Administrator/Manage Server permissions alone do not bypass the whitelist.

### Appeals and staff notes

- `/appeal message proof` — available to regular members and requires an image. The appeal is sent by DM to:
  - `1480120220269019146`
  - `1456824205545967713`
  It is also posted in the configured appeals channel when one is set.
- `/note add user text` — stores a private staff note and posts it in the configured notes channel.
- `/note list user` — shows stored notes to whitelisted staff.

### Backup

- `/backup` — sends a JSON backup containing all persistent strike data, history, notes, whitelist entries, channel configuration, and managed role IDs to the configured owner.
- `/restore backup` — owner-only restore from a JSON file produced by `/backup`.

## Automatic roles

When the bot joins a server, it creates or finds these roles:

- `Strike 1`
- `Strike 2`
- `Strike 3/3`
- `Blacklisted from Perms 3/3`
- `Blacklisted`

At `3/3`, the bot applies all three final-state roles. If a blacklist role is manually removed outside the bot’s own strike synchronization, the bot alerts `1480120220269019146` by DM and records an audit event.

## Local setup

1. Install Node.js 18.17 or newer.
2. Create a Discord application and bot in the [Discord Developer Portal](https://discord.com/developers/applications).
3. Enable the **Server Members Intent**, because boost detection and role-removal alerts use member updates.
4. Invite the bot with the `bot` and `applications.commands` scopes. It needs **View Channel**, **Send Messages**, **Embed Links**, **Attach Files**, **Manage Roles**, and **Read Message History**.
5. Copy `.env.example` to `.env` and fill in:

   ```env
   DISCORD_TOKEN=your_bot_token
   CLIENT_ID=your_application_id
   GUILD_ID=your_test_server_id
   ```

   `GUILD_ID` is optional, but recommended while testing because guild slash commands appear immediately. Without it, global commands can take up to an hour to update.

6. Run:

   ```bash
   npm install
   npm start
   ```

The bot creates `data/strikes.json` automatically.

## Railway deployment

This repository includes `.nvmrc` and `railway.json`. Railway can deploy it as a worker service with:

```bash
npm install
npm start
```

Set these Railway variables:

```env
DISCORD_TOKEN=your_bot_token
CLIENT_ID=your_application_id
GUILD_ID=your_test_server_id
ALERT_USER_ID=1480120220269019146
APPEAL_RECIPIENT_IDS=1480120220269019146,1456824205545967713
DATA_DIR=/app/data
```

Attach a Railway Volume and mount it at the same path used by `DATA_DIR` so strikes and backups survive redeploys. Without a volume, Railway’s local filesystem can be reset and the JSON database can be lost.

## Proof storage

After `/config proof channel` is set, the bot copies every strike proof into that channel and stores the copied attachment URL, message ID, and channel ID. This is more reliable than only storing the original command attachment URL. Keep the proof channel private to moderators.