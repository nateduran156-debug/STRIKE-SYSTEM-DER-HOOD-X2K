require('dotenv').config();

const { REST, Routes } = require('discord.js');
const { commands } = require('./commands');

async function registerCommands() {
  if (!process.env.DISCORD_TOKEN || !process.env.CLIENT_ID) {
    throw new Error('DISCORD_TOKEN and CLIENT_ID must be set in your .env file.');
  }

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  const route = process.env.GUILD_ID
    ? Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID)
    : Routes.applicationCommands(process.env.CLIENT_ID);

  await rest.put(route, { body: commands });
  console.log(
    `Registered ${commands.length} slash commands ${
      process.env.GUILD_ID ? `in guild ${process.env.GUILD_ID}` : 'globally'
    }.`
  );
}

if (require.main === module) {
  registerCommands().catch((error) => {
    console.error('Could not register slash commands:', error);
    process.exitCode = 1;
  });
}

module.exports = { registerCommands };