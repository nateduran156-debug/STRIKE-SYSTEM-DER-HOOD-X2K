const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const dataDirectory = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));
const filePath = path.join(dataDirectory, 'strikes.json');
const STRIKE_EXPIRATION_DAYS = 60;
const STRIKE_EXPIRATION_MS = STRIKE_EXPIRATION_DAYS * 24 * 60 * 60 * 1000;

function emptyDatabase() {
  return { version: 2, guilds: {} };
}

function ensureDatabase() {
  fs.mkdirSync(dataDirectory, { recursive: true });
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(emptyDatabase(), null, 2));
  }
}

function readDatabase() {
  ensureDatabase();
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && parsed.guilds ? parsed : emptyDatabase();
  } catch {
    return emptyDatabase();
  }
}

function writeDatabase(database) {
  ensureDatabase();
  const temporaryPath = `${filePath}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(database, null, 2));
  fs.renameSync(temporaryPath, filePath);
}

function normalizeRecord(record, userId, index) {
  const createdAt = record.createdAt || new Date().toISOString();
  const createdTime = Date.parse(createdAt);
  return {
    ...record,
    id: record.id || `legacy-${userId}-${index}-${createdTime}`,
    number: Number(record.number) || index + 1,
    status: record.status || 'active',
    expiresAt:
      record.expiresAt ||
      new Date((Number.isNaN(createdTime) ? Date.now() : createdTime) + STRIKE_EXPIRATION_MS).toISOString(),
    createdAt,
  };
}

function ensureGuild(database, guildId) {
  if (!database.guilds[guildId]) {
    database.guilds[guildId] = {};
  }

  const guild = database.guilds[guildId];
  guild.strikes ||= {};
  guild.history ||= {};
  guild.whitelist ||= [];
  guild.config ||= {};
  guild.roles ||= {};
  guild.boostSnapshots ||= {};
  guild.notes ||= {};

  // Migrate the original active-only format into the history format.
  for (const [userId, records] of Object.entries(guild.strikes)) {
    guild.strikes[userId] = records.map((record, index) =>
      normalizeRecord(record, userId, index)
    );
    guild.history[userId] ||= [];
    for (const record of guild.strikes[userId]) {
      if (!guild.history[userId].some((oldRecord) => oldRecord.id === record.id)) {
        guild.history[userId].push({ ...record });
      }
    }
  }

  return guild;
}

function updateHistoryRecord(guild, userId, record) {
  guild.history[userId] ||= [];
  const index = guild.history[userId].findIndex((item) => item.id === record.id);
  if (index === -1) {
    guild.history[userId].push({ ...record });
  } else {
    guild.history[userId][index] = { ...record };
  }
}

function expireUser(guild, userId, now = Date.now()) {
  const records = guild.strikes[userId] || [];
  const active = [];
  let changed = false;

  for (const record of records) {
    const expiresAt = Date.parse(record.expiresAt);
    if (record.status === 'active' && !Number.isNaN(expiresAt) && expiresAt <= now) {
      record.status = 'expired';
      record.expiredAt = new Date(now).toISOString();
      updateHistoryRecord(guild, userId, record);
      changed = true;
    } else {
      active.push(record);
    }
  }

  if (changed) {
    if (active.length) guild.strikes[userId] = active;
    else delete guild.strikes[userId];
  }
  return changed;
}

function expireAll(guild) {
  let changed = false;
  for (const userId of Object.keys(guild.strikes)) {
    changed = expireUser(guild, userId) || changed;
  }
  return changed;
}

function getStrikes(guildId, userId) {
  const database = readDatabase();
  const guild = ensureGuild(database, guildId);
  const changed = expireUser(guild, userId);
  if (changed) writeDatabase(database);
  return (guild.strikes[userId] || []).map((record) => ({ ...record }));
}

function getStrikeHistory(guildId, userId) {
  const database = readDatabase();
  const guild = ensureGuild(database, guildId);
  const changed = expireUser(guild, userId);
  if (changed) writeDatabase(database);
  return (guild.history[userId] || [])
    .slice()
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .map((record) => ({ ...record }));
}

function expireGuildStrikes(guildId) {
  const database = readDatabase();
  const guild = ensureGuild(database, guildId);
  const expiredUserIds = [];
  for (const userId of Object.keys(guild.strikes)) {
    if (expireUser(guild, userId)) expiredUserIds.push(userId);
  }
  if (expiredUserIds.length) writeDatabase(database);
  return expiredUserIds;
}

function addStrike(guildId, userId, strike) {
  const database = readDatabase();
  const guild = ensureGuild(database, guildId);
  expireUser(guild, userId);
  const record = {
    ...strike,
    id: strike.id || randomUUID(),
    status: 'active',
    expiresAt:
      strike.expiresAt ||
      new Date(Date.now() + STRIKE_EXPIRATION_MS).toISOString(),
  };
  guild.strikes[userId] ||= [];
  guild.strikes[userId].push(record);
  guild.history[userId] ||= [];
  guild.history[userId].push({ ...record });
  writeDatabase(database);
  return guild.strikes[userId].map((item) => ({ ...item }));
}

function setStrikeAnnouncement(guildId, userId, strikeId, announcement) {
  const database = readDatabase();
  const guild = ensureGuild(database, guildId);
  const active = (guild.strikes[userId] || []).find((record) => record.id === strikeId);
  const history = (guild.history[userId] || []).find((record) => record.id === strikeId);
  if (!active && !history) return false;

  const values = {
    announcementChannelId: announcement.channelId,
    announcementMessageId: announcement.messageId,
  };
  if (active) Object.assign(active, values);
  if (history) Object.assign(history, values);
  writeDatabase(database);
  return true;
}

function revokeLatestStrike(guildId, userId) {
  const database = readDatabase();
  const guild = ensureGuild(database, guildId);
  expireUser(guild, userId);
  const strikes = guild.strikes[userId] || [];
  const revoked = strikes.pop() || null;

  if (revoked) {
    revoked.status = 'revoked';
    revoked.revokedAt = new Date().toISOString();
    updateHistoryRecord(guild, userId, revoked);
  }
  if (strikes.length === 0) delete guild.strikes[userId];
  writeDatabase(database);
  return revoked ? { ...revoked } : null;
}

function revokeAll(guildId) {
  const database = readDatabase();
  const guild = ensureGuild(database, guildId);
  expireAll(guild);
  const userIds = Object.keys(guild.strikes);
  const revokedRecords = [];
  let count = 0;

  for (const userId of userIds) {
    for (const record of guild.strikes[userId]) {
      record.status = 'revoked';
      record.revokedAt = new Date().toISOString();
      updateHistoryRecord(guild, userId, record);
      revokedRecords.push({ userId, ...record });
      count += 1;
    }
  }
  guild.strikes = {};
  writeDatabase(database);
  return { count, userIds, revokedRecords };
}

function beginBoostForgiveness(guildId, userId) {
  const database = readDatabase();
  const guild = ensureGuild(database, guildId);
  expireUser(guild, userId);
  if (guild.boostSnapshots[userId]) return { changed: false, count: 0 };

  const active = guild.strikes[userId] || [];
  if (active.length === 0) return { changed: false, count: 0 };

  guild.boostSnapshots[userId] = {
    strikeIds: active.map((record) => record.id),
    startedAt: new Date().toISOString(),
  };
  for (const record of active) {
    record.status = 'boosted';
    record.boostedAt = new Date().toISOString();
    updateHistoryRecord(guild, userId, record);
  }
  delete guild.strikes[userId];
  writeDatabase(database);
  return { changed: true, count: active.length };
}

function endBoostForgiveness(guildId, userId) {
  const database = readDatabase();
  const guild = ensureGuild(database, guildId);
  const snapshot = guild.boostSnapshots[userId];
  if (!snapshot) return { changed: false, count: 0 };

  const history = guild.history[userId] || [];
  guild.strikes[userId] ||= [];
  let restored = 0;
  for (const strikeId of snapshot.strikeIds) {
    const record = history.find((item) => item.id === strikeId);
    if (!record) continue;

    const expiration = Date.parse(record.expiresAt);
    if (Number.isNaN(expiration) || expiration <= Date.now()) {
      record.status = 'expired';
      record.expiredAt ||= new Date().toISOString();
      updateHistoryRecord(guild, userId, record);
      continue;
    }

    record.status = 'active';
    delete record.boostedAt;
    if (!guild.strikes[userId].some((active) => active.id === record.id)) {
      guild.strikes[userId].push({ ...record });
      restored += 1;
    }
    updateHistoryRecord(guild, userId, record);
  }

  if (guild.strikes[userId].length === 0) delete guild.strikes[userId];
  delete guild.boostSnapshots[userId];
  writeDatabase(database);
  return { changed: true, count: restored };
}

function isWhitelisted(guildId, userId) {
  const database = readDatabase();
  return ensureGuild(database, guildId).whitelist.includes(userId);
}

function addToWhitelist(guildId, userId) {
  const database = readDatabase();
  const guild = ensureGuild(database, guildId);
  if (guild.whitelist.includes(userId)) return false;
  guild.whitelist.push(userId);
  writeDatabase(database);
  return true;
}

function removeFromWhitelist(guildId, userId) {
  const database = readDatabase();
  const guild = ensureGuild(database, guildId);
  const originalLength = guild.whitelist.length;
  guild.whitelist = guild.whitelist.filter((id) => id !== userId);
  if (guild.whitelist.length === originalLength) return false;
  writeDatabase(database);
  return true;
}

function getWhitelist(guildId) {
  const database = readDatabase();
  return [...ensureGuild(database, guildId).whitelist];
}

function getConfig(guildId) {
  const database = readDatabase();
  return { ...ensureGuild(database, guildId).config };
}

function setConfig(guildId, key, value) {
  const database = readDatabase();
  const guild = ensureGuild(database, guildId);
  guild.config[key] = value;
  writeDatabase(database);
  return { ...guild.config };
}

function getManagedRoles(guildId) {
  const database = readDatabase();
  return { ...ensureGuild(database, guildId).roles };
}

function setManagedRoles(guildId, roles) {
  const database = readDatabase();
  const guild = ensureGuild(database, guildId);
  guild.roles = { ...guild.roles, ...roles };
  writeDatabase(database);
  return { ...guild.roles };
}

function addNote(guildId, userId, note) {
  const database = readDatabase();
  const guild = ensureGuild(database, guildId);
  guild.notes[userId] ||= [];
  guild.notes[userId].push({
    id: randomUUID(),
    ...note,
    createdAt: note.createdAt || new Date().toISOString(),
  });
  writeDatabase(database);
  return guild.notes[userId].at(-1);
}

function getNotes(guildId, userId) {
  const database = readDatabase();
  return [...(ensureGuild(database, guildId).notes[userId] || [])].reverse();
}

function getBackup() {
  const database = readDatabase();
  return {
    backupVersion: 1,
    backedUpAt: new Date().toISOString(),
    strikeExpirationDays: STRIKE_EXPIRATION_DAYS,
    database,
  };
}

function restoreBackup(backup) {
  if (!backup || typeof backup !== 'object' || !backup.database?.guilds) {
    throw new Error('Invalid strike bot backup file.');
  }
  const database = {
    version: 2,
    guilds: backup.database.guilds,
  };
  writeDatabase(database);
}

module.exports = {
  STRIKE_EXPIRATION_DAYS,
  addNote,
  addStrike,
  addToWhitelist,
  beginBoostForgiveness,
  endBoostForgiveness,
  expireGuildStrikes,
  getBackup,
  getConfig,
  getManagedRoles,
  getNotes,
  getStrikeHistory,
  getStrikes,
  getWhitelist,
  isWhitelisted,
  removeFromWhitelist,
  restoreBackup,
  revokeAll,
  revokeLatestStrike,
  setStrikeAnnouncement,
  setConfig,
  setManagedRoles,
};