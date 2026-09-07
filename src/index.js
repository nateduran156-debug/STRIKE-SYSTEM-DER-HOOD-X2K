require('dotenv').config();

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
} = require('discord.js');
const { registerCommands } = require('./register-commands');
const {
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
  setConfig,
  setManagedRoles,
} = require('./store');

const OWNER_ID = process.env.ALERT_USER_ID || '1480120220269019146';
const APPEAL_RECIPIENT_IDS = (
  process.env.APPEAL_RECIPIENT_IDS ||
  '1480120220269019146,1456824205545967713'
)
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});
const suppressedRoleRemovalNotices = new Set();

const roleDefinitions = [
  { key: 'strike1', name: 'Strike 1', color: 0xffc107 },
  { key: 'strike2', name: 'Strike 2', color: 0xff7a00 },
  { key: 'strike3', name: 'Strike 3/3', color: 0xed4245 },
  { key: 'blacklistedPerms', name: 'Blacklisted from Perms 3/3', color: 0x992d22 },
  { key: 'blacklisted', name: 'Blacklisted', color: 0x2b2d31 },
];

function isServerManager(interaction) {
  return (
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ||
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
  );
}

function isOwner(userId) {
  return userId === OWNER_ID;
}

function canModerate(interaction) {
  // Server permissions alone are not enough: moderation commands are whitelist-only.
  return isOwner(interaction.user.id) || isWhitelisted(interaction.guildId, interaction.user.id);
}

async function requireGuild(interaction) {
  if (!interaction.inGuild()) {
    await interaction.reply({
      content: '❌ This command can only be used inside a server.',
      ephemeral: true,
    });
    return false;
  }
  return true;
}

async function requireModerator(interaction) {
  if (!canModerate(interaction)) {
    await interaction.reply({
      content: '❌ You are not allowed to use the strike system.',
      ephemeral: true,
    });
    return false;
  }
  return true;
}

async function requireServerManager(interaction) {
  if (!isOwner(interaction.user.id) && !isWhitelisted(interaction.guildId, interaction.user.id)) {
    await interaction.reply({
      content: '❌ Only the bot owner or a whitelisted moderator can do that.',
      ephemeral: true,
    });
    return false;
  }
  return true;
}

function isImageAttachment(attachment) {
  if (!attachment) return false;
  if (attachment.contentType) return attachment.contentType.startsWith('image/');
  return /\.(png|jpe?g|gif|webp|bmp|heic|heif)(\?.*)?$/i.test(attachment.url);
}

function formatStrikeMessage(userId, strikeNumber, reason) {
  return `❌ - <@${userId}> has been **STRIKED ${strikeNumber}/3** due to **${reason}** - ❌`;
}

function formatStrikeRecord(strike) {
  const date = new Date(strike.createdAt).toLocaleString('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const expires = strike.expiresAt
    ? ` · expires ${new Date(strike.expiresAt).toLocaleDateString('en-US')}`
    : '';
  return `**${strike.number}/3** — ${strike.reason} · ${strike.status}${expires} · ${date}`;
}

async function fetchTextChannel(guild, channelId) {
  if (!channelId) return null;
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  return channel?.isTextBased() ? channel : null;
}

async function sendAudit(guild, title, description, color = 0x5865f2, imageUrl) {
  const channel = await fetchTextChannel(guild, getConfig(guild.id).auditChannelId);
  if (!channel) return false;

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(description)
    .setTimestamp();
  if (imageUrl) embed.setImage(imageUrl);

  await channel
    .send({ embeds: [embed], allowedMentions: { parse: [] } })
    .catch((error) => console.error('Could not send audit entry:', error.message));
  return true;
}

async function notifyOwner(content, attachmentPath) {
  try {
    const owner = await client.users.fetch(OWNER_ID);
    await owner.send({
      content,
      files: attachmentPath ? [{ attachment: attachmentPath, name: path.basename(attachmentPath) }] : [],
      allowedMentions: { parse: [] },
    });
    return true;
  } catch (error) {
    console.error(`Could not notify owner ${OWNER_ID}:`, error.message);
    return false;
  }
}

async function ensureManagedRoles(guild) {
  const existing = getManagedRoles(guild.id);
  const resolved = {};

  for (const definition of roleDefinitions) {
    let role = existing[definition.key]
      ? guild.roles.cache.get(existing[definition.key])
      : null;
    if (!role) {
      role = guild.roles.cache.find((candidate) => candidate.name === definition.name);
    }
    if (!role) {
      role = await guild.roles
        .create({
          name: definition.name,
          color: definition.color,
          reason: 'Strike system managed role setup',
        })
        .catch((error) => {
          console.error(`Could not create role ${definition.name}:`, error.message);
          return null;
        });
    }
    if (role) resolved[definition.key] = role.id;
  }

  if (Object.keys(resolved).length) setManagedRoles(guild.id, resolved);
  return resolved;
}

function suppressRoleNotice(guildId, userId, roleId) {
  const key = `${guildId}:${userId}:${roleId}`;
  suppressedRoleRemovalNotices.add(key);
  setTimeout(() => suppressedRoleRemovalNotices.delete(key), 10000);
}

async function syncStrikeRoles(guild, userId) {
  const roles = await ensureManagedRoles(guild);
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member || !Object.keys(roles).length) return;

  const strikes = getStrikes(guild.id, userId);
  const desired = new Set();
  if (strikes.length === 1 && roles.strike1) desired.add(roles.strike1);
  if (strikes.length === 2 && roles.strike2) desired.add(roles.strike2);
  if (strikes.length >= 3) {
    if (roles.strike3) desired.add(roles.strike3);
    if (roles.blacklistedPerms) desired.add(roles.blacklistedPerms);
    if (roles.blacklisted) desired.add(roles.blacklisted);
  }

  for (const roleId of Object.values(roles)) {
    const hasRole = member.roles.cache.has(roleId);
    if (desired.has(roleId) && !hasRole) {
      await member.roles.add(roleId, 'Strike system status sync').catch((error) =>
        console.error('Could not add strike role:', error.message)
      );
    } else if (!desired.has(roleId) && hasRole) {
      suppressRoleNotice(guild.id, userId, roleId);
      await member.roles.remove(roleId, 'Strike system status sync').catch((error) =>
        console.error('Could not remove strike role:', error.message)
      );
    }
  }
}

async function storeProof(guild, targetUser, proof, moderator) {
  const config = getConfig(guild.id);
  const channel = await fetchTextChannel(guild, config.proofChannelId || config.auditChannelId);
  if (!channel) return { proofUrl: proof.url, proofName: proof.name };

  try {
    const message = await channel.send({
      content: `Evidence for ${targetUser} · submitted by ${moderator}`,
      files: [{ attachment: proof.url, name: proof.name || 'strike-proof' }],
      allowedMentions: { parse: [] },
    });
    const storedAttachment = message.attachments.first();
    return {
      proofUrl: storedAttachment?.url || proof.url,
      proofName: storedAttachment?.name || proof.name,
      proofMessageId: message.id,
      proofChannelId: channel.id,
    };
  } catch (error) {
    console.error('Could not copy proof into evidence storage:', error.message);
    return { proofUrl: proof.url, proofName: proof.name };
  }
}

async function handleStrikeAdd(interaction) {
  const user = interaction.options.getUser('user');
  const reason = interaction.options.getString('reason');
  const proof = interaction.options.getAttachment('proof');
  const currentStrikes = getStrikes(interaction.guildId, user.id);

  if (currentStrikes.length >= 3) {
    await interaction.reply({
      content: `❌ <@${user.id}> is already at the maximum of **3/3 strikes**. Use \`/strike revoke\` before adding another.`,
      ephemeral: true,
    });
    return;
  }
  if (!isImageAttachment(proof)) {
    await interaction.reply({
      content: '❌ Proof is required and must be an image screenshot.',
      ephemeral: true,
    });
    return;
  }

  const number = currentStrikes.length + 1;
  const storedProof = await storeProof(
    interaction.guild,
    `<@${user.id}>`,
    proof,
    interaction.user.tag
  );
  addStrike(interaction.guildId, user.id, {
    number,
    reason,
    ...storedProof,
    originalProofUrl: proof.url,
    moderatorId: interaction.user.id,
    createdAt: new Date().toISOString(),
  });
  await syncStrikeRoles(interaction.guild, user.id);
  await sendAudit(
    interaction.guild,
    `Strike ${number}/3 issued`,
    `<@${user.id}> was struck by <@${interaction.user.id}>.\n**Reason:** ${reason}\n**Expiration:** ${STRIKE_EXPIRATION_DAYS} days`,
    number === 3 ? 0x992d22 : 0xed4245,
    storedProof.proofUrl
  );

  await interaction.reply({
    content: formatStrikeMessage(user.id, number, reason),
    embeds: [
      new EmbedBuilder()
        .setColor(number === 3 ? 0x992d22 : 0xed4245)
        .setTitle(`Strike ${number}/3`)
        .setDescription(`Proof stored for <@${user.id}>.`)
        .setImage(storedProof.proofUrl)
        .setFooter({ text: `Issued by ${interaction.user.tag}` }),
    ],
    allowedMentions: { users: [user.id] },
  });
}

async function handleStrike3(interaction) {
  const user = interaction.options.getUser('user');
  const consequence = interaction.options.getString('consequence');
  const reason = interaction.options.getString('reason');
  const proof = interaction.options.getAttachment('proof');
  const currentStrikes = getStrikes(interaction.guildId, user.id);

  if (currentStrikes.length !== 2) {
    await interaction.reply({
      content:
        currentStrikes.length >= 3
          ? `❌ <@${user.id}> is already at **STRIKED 3/3**.`
          : `❌ <@${user.id}> has **${currentStrikes.length}/3** active strikes. Use \`/strike add\` until they are at **2/3**, then use \`/strike3\`.`,
      ephemeral: true,
    });
    return;
  }
  if (!isImageAttachment(proof)) {
    await interaction.reply({
      content: '❌ Proof is required and must be an image screenshot.',
      ephemeral: true,
    });
    return;
  }

  const storedProof = await storeProof(
    interaction.guild,
    `<@${user.id}>`,
    proof,
    interaction.user.tag
  );
  addStrike(interaction.guildId, user.id, {
    number: 3,
    reason,
    consequence,
    ...storedProof,
    originalProofUrl: proof.url,
    moderatorId: interaction.user.id,
    createdAt: new Date().toISOString(),
    finalStrike: true,
  });
  await syncStrikeRoles(interaction.guild, user.id);
  await sendAudit(
    interaction.guild,
    'Final strike 3/3 issued',
    `<@${user.id}> was blacklisted by <@${interaction.user.id}>.\n**Consequence:** ${consequence}\n**Reason:** ${reason}`,
    0x992d22,
    storedProof.proofUrl
  );

  await interaction.reply({
    content: `❌ - <@${user.id}> has been **${consequence}** due to **STRIKED 3/3** - ❌`,
    embeds: [
      new EmbedBuilder()
        .setColor(0x992d22)
        .setTitle('Final strike — 3/3')
        .addFields(
          { name: 'User', value: `<@${user.id}>`, inline: true },
          { name: 'Reason', value: reason, inline: true },
          { name: 'Consequence', value: consequence }
        )
        .setImage(storedProof.proofUrl)
        .setFooter({ text: `Issued by ${interaction.user.tag}` }),
    ],
    allowedMentions: { users: [user.id] },
  });
}

async function handleProof(interaction) {
  const user = interaction.options.getUser('user');
  const history = getStrikeHistory(interaction.guildId, user.id);
  const latest = history[0];

  if (!latest?.proofUrl) {
    await interaction.reply({
      content: `❌ No strike proof was found for <@${user.id}>.`,
      ephemeral: true,
    });
    return;
  }
  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(`Latest strike proof — ${latest.number}/3`)
        .setDescription(
          `Proof for <@${user.id}>\n**Status:** ${latest.status}\n**Reason:** ${latest.reason}\n**Issued:** <t:${Math.floor(
            new Date(latest.createdAt).getTime() / 1000
          )}:F>`
        )
        .setImage(latest.proofUrl)
        .setFooter({ text: `Stored filename: ${latest.proofName || 'attachment'}` }),
    ],
    allowedMentions: { users: [user.id] },
  });
}

async function handleStrikeRevoke(interaction) {
  const user = interaction.options.getUser('user');
  const revoked = revokeLatestStrike(interaction.guildId, user.id);
  if (!revoked) {
    await interaction.reply({
      content: `❌ <@${user.id}> has no active strikes to revoke.`,
      ephemeral: true,
    });
    return;
  }

  await syncStrikeRoles(interaction.guild, user.id);
  const remaining = getStrikes(interaction.guildId, user.id).length;
  await sendAudit(
    interaction.guild,
    'Strike revoked',
    `<@${revoked.moderatorId || user.id}>'s strike record for <@${user.id}> was revoked by <@${interaction.user.id}>. Remaining: ${remaining}/3.`,
    0x57f287
  );
  await interaction.reply({
    content: `✅ Revoked <@${user.id}>'s **${revoked.number}/3** strike. They now have **${remaining}/3** active strikes.`,
    allowedMentions: { users: [user.id] },
  });
}

async function handleStatus(interaction) {
  const user = interaction.options.getUser('user');
  const strikes = getStrikes(interaction.guildId, user.id);
  if (strikes.length === 0) {
    await interaction.reply({ content: `✅ <@${user.id}> has **0/3** active strikes.` });
    return;
  }

  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(strikes.length === 3 ? 0x992d22 : 0xed4245)
        .setTitle(`Strike status — ${strikes.length}/3`)
        .setDescription([`<@${user.id}>`, '', ...strikes.map(formatStrikeRecord)].join('\n')),
    ],
    allowedMentions: { users: [user.id] },
  });
}

async function handleHistory(interaction) {
  const user = interaction.options.getUser('user');
  const history = getStrikeHistory(interaction.guildId, user.id);
  if (!history.length) {
    await interaction.reply({ content: `✅ No strike history was found for <@${user.id}>.` });
    return;
  }

  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(`Strike history — ${user.tag}`)
        .setDescription(history.slice(0, 15).map(formatStrikeRecord).join('\n')),
    ],
    allowedMentions: { users: [user.id] },
  });
}

async function handleRevokeAll(interaction) {
  const result = revokeAll(interaction.guildId);
  await Promise.all(result.userIds.map((userId) => syncStrikeRoles(interaction.guild, userId)));
  await sendAudit(
    interaction.guild,
    'All strikes revoked',
    `<@${interaction.user.id}> revoked ${result.count} active strikes for every user.`,
    0x57f287
  );
  await interaction.reply({
    content: `✅ Revoked **${result.count}** active strike${result.count === 1 ? '' : 's'} for every user.`,
  });
}

async function handleWhitelist(interaction) {
  const subcommand = interaction.options.getSubcommand();
  if (!(await requireModerator(interaction))) return;

  if (subcommand === 'list') {
    const ids = getWhitelist(interaction.guildId);
    await interaction.reply({
      content:
        ids.length > 0
          ? `🛡️ Whitelisted moderators:\n${ids.map((id) => `• <@${id}>`).join('\n')}`
          : '🛡️ The strike whitelist is empty. Server managers can still use the commands.',
      ephemeral: true,
      allowedMentions: { users: ids },
    });
    return;
  }

  if (!(await requireServerManager(interaction))) return;
  const user = interaction.options.getUser('user');
  if (subcommand === 'add') {
    const added = addToWhitelist(interaction.guildId, user.id);
    await interaction.reply({
      content: added
        ? `✅ Added <@${user.id}> to the strike whitelist.`
        : `ℹ️ <@${user.id}> is already on the strike whitelist.`,
      ephemeral: true,
      allowedMentions: { users: [user.id] },
    });
    return;
  }

  const removed = removeFromWhitelist(interaction.guildId, user.id);
  await interaction.reply({
    content: removed
      ? `✅ Removed <@${user.id}> from the strike whitelist.`
      : `ℹ️ <@${user.id}> was not on the strike whitelist.`,
    ephemeral: true,
    allowedMentions: { users: [user.id] },
  });
}

async function handleConfig(interaction) {
  if (!(await requireServerManager(interaction))) return;
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === 'view') {
    const config = getConfig(interaction.guildId);
    await interaction.reply({
      content: [
        `**Audit:** ${config.auditChannelId ? `<#${config.auditChannelId}>` : 'not configured'}`,
        `**Appeals:** ${config.appealsChannelId ? `<#${config.appealsChannelId}>` : 'not configured'}`,
        `**Notes:** ${config.notesChannelId ? `<#${config.notesChannelId}>` : 'not configured'}`,
        `**Proof storage:** ${config.proofChannelId ? `<#${config.proofChannelId}>` : 'audit channel or original attachment'}`,
      ].join('\n'),
      ephemeral: true,
    });
    return;
  }

  const keyBySubcommand = {
    audit: 'auditChannelId',
    appeals: 'appealsChannelId',
    notes: 'notesChannelId',
    proof: 'proofChannelId',
  };
  const channel = interaction.options.getChannel('channel');
  setConfig(interaction.guildId, keyBySubcommand[subcommand], channel.id);
  await interaction.reply({
    content: `✅ ${subcommand} channel set to <#${channel.id}>.`,
    ephemeral: true,
  });
  await sendAudit(
    interaction.guild,
    'Strike system configuration changed',
    `<@${interaction.user.id}> set the ${subcommand} channel to <#${channel.id}>.`,
    0x5865f2
  );
}

async function handleAppeal(interaction) {
  const message = interaction.options.getString('message');
  const proof = interaction.options.getAttachment('proof');
  if (!isImageAttachment(proof)) {
    await interaction.reply({
      content: '❌ Appeals must include an image attachment.',
      ephemeral: true,
    });
    return;
  }

  const appealEmbed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle('New strike appeal')
    .addFields(
      { name: 'Server', value: interaction.guild.name, inline: true },
      { name: 'Member', value: `<@${interaction.user.id}>`, inline: true },
      { name: 'Submitted', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true },
      { name: 'Appeal', value: message }
    )
    .setImage('attachment://appeal-proof.png');
  const appealFile = { attachment: proof.url, name: 'appeal-proof.png' };
  const deliveries = await Promise.all(
    APPEAL_RECIPIENT_IDS.map(async (recipientId) => {
      try {
        const recipient = await client.users.fetch(recipientId);
        await recipient.send({
          embeds: [appealEmbed],
          files: [appealFile],
          allowedMentions: { parse: [] },
        });
        return true;
      } catch (error) {
        console.error(`Could not send appeal to ${recipientId}:`, error.message);
        return false;
      }
    })
  );

  const appealsChannel = await fetchTextChannel(
    interaction.guild,
    getConfig(interaction.guildId).appealsChannelId
  );
  if (appealsChannel) {
    await appealsChannel
      .send({
        embeds: [appealEmbed],
        files: [appealFile],
        allowedMentions: { parse: [] },
      })
      .catch((error) => console.error('Could not post appeal in channel:', error.message));
  }

  if (!deliveries.some(Boolean)) {
    await interaction.reply({
      content: '❌ I could not deliver the appeal to either configured appeal reviewer.',
      ephemeral: true,
    });
    return;
  }
  await interaction.reply({
    content: '✅ Your image appeal was sent to the appeal reviewers.',
    ephemeral: true,
  });
}

async function handleNote(interaction) {
  if (!(await requireModerator(interaction))) return;
  const subcommand = interaction.options.getSubcommand();
  const user = interaction.options.getUser('user');

  if (subcommand === 'list') {
    const notes = getNotes(interaction.guildId, user.id);
    await interaction.reply({
      content: notes.length
        ? notes
            .slice(0, 15)
            .map(
              (note) =>
                `• ${note.text} — <@${note.moderatorId}> · <t:${Math.floor(
                  new Date(note.createdAt).getTime() / 1000
                )}:R>`
            )
            .join('\n')
        : `No internal notes found for <@${user.id}>.`,
      ephemeral: true,
      allowedMentions: { users: [user.id] },
    });
    return;
  }

  const text = interaction.options.getString('text');
  addNote(interaction.guildId, user.id, {
    text,
    moderatorId: interaction.user.id,
  });
  const channel = await fetchTextChannel(
    interaction.guild,
    getConfig(interaction.guildId).notesChannelId
  );
  if (channel) {
    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle('Internal strike note')
          .addFields(
            { name: 'Member', value: `<@${user.id}>`, inline: true },
            { name: 'Moderator', value: `<@${interaction.user.id}>`, inline: true },
            { name: 'Note', value: text }
          ),
      ],
      allowedMentions: { parse: [] },
    });
  }
  await interaction.reply({
    content: `✅ Added an internal note for <@${user.id}>.`,
    ephemeral: true,
    allowedMentions: { users: [user.id] },
  });
}

async function handleBackup(interaction) {
  if (!(await requireServerManager(interaction))) return;
  const filePath = path.join(
    os.tmpdir(),
    `strike-bot-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  );
  fs.writeFileSync(filePath, JSON.stringify(getBackup(), null, 2));
  const sent = await notifyOwner(
    `📦 Strike bot backup requested by ${interaction.user.tag} from ${interaction.guild.name}. This includes all persistent strike data, history, notes, channel configuration, whitelist entries, and managed role IDs.`,
    filePath
  );
  fs.unlinkSync(filePath);

  await interaction.reply({
    content: sent
      ? `✅ Full data backup sent by DM to <@${OWNER_ID}>.`
      : '❌ I could not DM the backup to the configured owner. Check that their DMs are open.',
    ephemeral: true,
    allowedMentions: { users: [OWNER_ID] },
  });
}

async function handleRestore(interaction) {
  if (!isOwner(interaction.user.id)) {
    await interaction.reply({
      content: '❌ Only the configured bot owner can restore a full backup.',
      ephemeral: true,
    });
    return;
  }

  const attachment = interaction.options.getAttachment('backup');
  if (!attachment.name?.toLowerCase().endsWith('.json') || attachment.size > 10_000_000) {
    await interaction.reply({
      content: '❌ Attach a JSON backup file smaller than 10 MB.',
      ephemeral: true,
    });
    return;
  }

  try {
    const response = await fetch(attachment.url);
    if (!response.ok) throw new Error(`Download returned HTTP ${response.status}`);
    restoreBackup(JSON.parse(await response.text()));
    for (const guild of client.guilds.cache.values()) {
      await ensureManagedRoles(guild);
    }
    await sendAudit(
      interaction.guild,
      'Strike bot backup restored',
      `<@${interaction.user.id}> restored the full strike-system backup.`,
      0xf1c40f
    );
    await interaction.reply({
      content: '✅ Backup restored successfully. Strike data, history, notes, channels, and roles were restored.',
      ephemeral: true,
    });
  } catch (error) {
    console.error('Restore failed:', error);
    await interaction.reply({
      content: '❌ That backup could not be restored. Make sure it was created by `/backup` and was not edited.',
      ephemeral: true,
    });
  }
}

async function handleBoostChange(member, started) {
  const result = started
    ? beginBoostForgiveness(member.guild.id, member.id)
    : endBoostForgiveness(member.guild.id, member.id);
  if (!result.changed) return;

  await syncStrikeRoles(member.guild, member.id);
  await sendAudit(
    member.guild,
    started ? 'Boost forgiveness activated' : 'Boost forgiveness ended',
    started
      ? `<@${member.id}> boosted the server. ${result.count} active strike(s) were temporarily forgiven.`
      : `<@${member.id}> stopped boosting. ${result.count} previous strike(s) were restored if they had not reached their 60-day expiration.`,
    started ? 0xf47fff : 0xed4245
  );
}

async function checkExpiredStrikes() {
  for (const guild of client.guilds.cache.values()) {
    const expiredUserIds = expireGuildStrikes(guild.id);
    for (const userId of expiredUserIds) {
      await syncStrikeRoles(guild, userId);
      await sendAudit(
        guild,
        'Strike expired',
        `A strike for <@${userId}> reached its ${STRIKE_EXPIRATION_DAYS}-day expiration and was removed from active strikes.`,
        0x57f287
      );
    }
  }
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  for (const guild of readyClient.guilds.cache.values()) {
    await ensureManagedRoles(guild);
  }
  await checkExpiredStrikes();
  setInterval(() => checkExpiredStrikes().catch(console.error), 60 * 60 * 1000);
});

client.on(Events.GuildCreate, async (guild) => {
  await ensureManagedRoles(guild);
  await notifyOwner(`✅ Strike bot joined **${guild.name}** and created/verified its managed strike roles.`);
});

client.on(Events.GuildMemberAdd, async (member) => {
  await syncStrikeRoles(member.guild, member.id);
});

client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  const wasBoosting = oldMember.premiumSinceTimestamp !== null;
  const isBoosting = newMember.premiumSinceTimestamp !== null;
  if (!wasBoosting && isBoosting) await handleBoostChange(newMember, true);
  if (wasBoosting && !isBoosting) await handleBoostChange(newMember, false);

  const roles = getManagedRoles(newMember.guild.id);
  for (const key of ['blacklistedPerms', 'blacklisted']) {
    const roleId = roles[key];
    const noticeKey = `${newMember.guild.id}:${newMember.id}:${roleId}`;
    if (
      roleId &&
      oldMember.roles.cache.has(roleId) &&
      !newMember.roles.cache.has(roleId) &&
      !suppressedRoleRemovalNotices.delete(noticeKey)
    ) {
      await notifyOwner(
        `⚠️ **Blacklist role removed** in ${newMember.guild.name}\nMember: ${newMember.user.tag} (${newMember.id})\nRole: ${key}\nThe role was removed outside the bot's strike sync.`
      );
      await sendAudit(
        newMember.guild,
        'Blacklist role removed',
        `The ${key} role was manually removed from <@${newMember.id}>. The bot owner was notified.`,
        0xed4245
      );
    }
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (!(await requireGuild(interaction))) return;

  try {
    if (interaction.commandName === 'appeal') {
      await handleAppeal(interaction);
      return;
    }
    if (interaction.commandName === 'proof') {
      if (await requireModerator(interaction)) await handleProof(interaction);
      return;
    }
    if (interaction.commandName === 'wl') {
      await handleWhitelist(interaction);
      return;
    }
    if (interaction.commandName === 'config') {
      await handleConfig(interaction);
      return;
    }
    if (interaction.commandName === 'backup') {
      await handleBackup(interaction);
      return;
    }
    if (interaction.commandName === 'restore') {
      await handleRestore(interaction);
      return;
    }
    if (interaction.commandName === 'note') {
      await handleNote(interaction);
      return;
    }
    if (!(await requireModerator(interaction))) return;

    if (interaction.commandName === 'strike') {
      const subcommand = interaction.options.getSubcommand();
      if (subcommand === 'add') await handleStrikeAdd(interaction);
      if (subcommand === 'revoke') await handleStrikeRevoke(interaction);
      if (subcommand === 'status') await handleStatus(interaction);
      if (subcommand === 'history') await handleHistory(interaction);
      return;
    }
    if (interaction.commandName === 'strike3') {
      await handleStrike3(interaction);
      return;
    }
    if (interaction.commandName === 'revokeall') {
      await handleRevokeAll(interaction);
    }
  } catch (error) {
    console.error('Command error:', error);
    const response = {
      content: '❌ Something went wrong while processing that command.',
      ephemeral: true,
    };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(response).catch(() => {});
    } else {
      await interaction.reply(response).catch(() => {});
    }
  }
});

async function start() {
  if (!process.env.DISCORD_TOKEN || !process.env.CLIENT_ID) {
    throw new Error('DISCORD_TOKEN and CLIENT_ID must be set in your .env file.');
  }
  await registerCommands();
  await client.login(process.env.DISCORD_TOKEN);
}

start().catch((error) => {
  console.error('Could not start the strike bot:', error);
  process.exitCode = 1;
});