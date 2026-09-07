const { ChannelType, SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('strike')
    .setDescription('Manage user strikes')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('add')
        .setDescription('Give a user their next strike')
        .addUserOption((option) =>
          option
            .setName('user')
            .setDescription('The user receiving the strike')
            .setRequired(true)
        )
        .addStringOption((option) =>
          option
            .setName('reason')
            .setDescription('Reason for the strike')
            .setMaxLength(900)
            .setRequired(true)
        )
        .addAttachmentOption((option) =>
          option
            .setName('proof')
            .setDescription('Required screenshot or image proving the strike')
            .setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('revoke')
        .setDescription("Revoke a user's latest active strike")
        .addUserOption((option) =>
          option
            .setName('user')
            .setDescription('The user whose latest strike will be revoked')
            .setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('status')
        .setDescription('Show a user’s active strikes')
        .addUserOption((option) =>
          option
            .setName('user')
            .setDescription('The user to check')
            .setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('history')
        .setDescription('Show active, expired, revoked, and boost-forgiven strikes')
        .addUserOption((option) =>
          option
            .setName('user')
            .setDescription('The user whose strike history you want to see')
            .setRequired(true)
        )
    ),

  new SlashCommandBuilder()
    .setName('strike3')
    .setDescription('Give the final strike and announce its consequence')
    .addUserOption((option) =>
      option
        .setName('user')
        .setDescription('The user receiving the final strike')
        .setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName('consequence')
        .setDescription('Consequence text, for example: DEMOTED 1 RANK')
        .setMaxLength(500)
        .setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName('reason')
        .setDescription('Reason for the final strike')
        .setMaxLength(900)
        .setRequired(true)
    )
    .addAttachmentOption((option) =>
      option
        .setName('proof')
        .setDescription('Required screenshot or image proving the final strike')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('proof')
    .setDescription('Pull up the latest proof used to strike a user')
    .addUserOption((option) =>
      option
        .setName('user')
        .setDescription('The user whose latest proof you want to view')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('revokeall')
    .setDescription('Revoke all active strikes for every user'),

  new SlashCommandBuilder()
    .setName('config')
    .setDescription('Configure strike-system channels')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('audit')
        .setDescription('Set the private audit-log channel')
        .addChannelOption((option) =>
          option
            .setName('channel')
            .setDescription('Channel where strike actions are logged')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('appeals')
        .setDescription('Set the channel where appeals are posted')
        .addChannelOption((option) =>
          option
            .setName('channel')
            .setDescription('Channel where members can submit appeals')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('notes')
        .setDescription('Set the private staff-notes channel')
        .addChannelOption((option) =>
          option
            .setName('channel')
            .setDescription('Channel where internal notes are posted')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('proof')
        .setDescription('Set the private evidence-storage channel')
        .addChannelOption((option) =>
          option
            .setName('channel')
            .setDescription('Channel where proof images are copied')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('view').setDescription('View the current channel configuration')
    ),

  new SlashCommandBuilder()
    .setName('appeal')
    .setDescription('Submit an appeal to the configured appeals channel')
    .addStringOption((option) =>
      option
        .setName('message')
        .setDescription('Explain why the strike should be reviewed')
        .setMaxLength(1800)
        .setRequired(true)
    )
    .addAttachmentOption((option) =>
      option
        .setName('proof')
        .setDescription('Required image supporting the appeal')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('note')
    .setDescription('Manage private staff notes about strikes')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('add')
        .setDescription('Add an internal note about a user')
        .addUserOption((option) =>
          option
            .setName('user')
            .setDescription('User the note is about')
            .setRequired(true)
        )
        .addStringOption((option) =>
          option
            .setName('text')
            .setDescription('Internal note')
            .setMaxLength(1800)
            .setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('list')
        .setDescription('List internal notes about a user')
        .addUserOption((option) =>
          option
            .setName('user')
            .setDescription('User whose notes you want to see')
            .setRequired(true)
        )
    ),

  new SlashCommandBuilder()
    .setName('backup')
    .setDescription('Back up all strike data and configuration to the owner'),

  new SlashCommandBuilder()
    .setName('restore')
    .setDescription('Restore strike data and configuration from a backup')
    .addAttachmentOption((option) =>
      option
        .setName('backup')
        .setDescription('JSON backup file created by /backup')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('wl')
    .setDescription('Manage the strike-system moderator whitelist')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('add')
        .setDescription('Allow a user to use strike commands')
        .addUserOption((option) =>
          option
            .setName('user')
            .setDescription('User to whitelist')
            .setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('remove')
        .setDescription('Remove a user from the strike whitelist')
        .addUserOption((option) =>
          option
            .setName('user')
            .setDescription('User to remove from the whitelist')
            .setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('list')
        .setDescription('Show the strike-system whitelist')
    ),
].map((command) => command.toJSON());

module.exports = { commands };