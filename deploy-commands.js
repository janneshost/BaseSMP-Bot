require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('ticket-panel')
    .setDescription('Postet das Ticket-Panel mit Dropdown-Menü (nur für Team)')
    .setDefaultMemberPermissions(0),

  new SlashCommandBuilder()
    .setName('umfrage')
    .setDescription('Erstellt eine Umfrage mit Reaktionen')
    .addStringOption(opt =>
      opt.setName('frage').setDescription('Die Frage der Umfrage').setRequired(true))
    .addStringOption(opt =>
      opt.setName('optionen')
        .setDescription('Antwortoptionen, mit Komma getrennt (max. 5), z.B.: Ja,Nein,Vielleicht')
        .setRequired(true)),

  new SlashCommandBuilder()
    .setName('giveaway-start')
    .setDescription('Startet ein Giveaway (nur für Team)')
    .setDefaultMemberPermissions(0)
    .addStringOption(opt =>
      opt.setName('preis').setDescription('Was wird verlost?').setRequired(true))
    .addIntegerOption(opt =>
      opt.setName('dauer').setDescription('Dauer in Minuten').setRequired(true))
    .addIntegerOption(opt =>
      opt.setName('gewinner').setDescription('Anzahl der Gewinner').setRequired(true)),

  new SlashCommandBuilder()
    .setName('giveaway-end')
    .setDescription('Beendet ein Giveaway sofort und zieht Gewinner (nur für Team)')
    .setDefaultMemberPermissions(0)
    .addStringOption(opt =>
      opt.setName('message_id').setDescription('Message-ID des Giveaways').setRequired(true)),
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log('Registriere Slash-Commands...');
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands }
    );
    console.log('Slash-Commands erfolgreich registriert!');
  } catch (err) {
    console.error(err);
  }
})();
