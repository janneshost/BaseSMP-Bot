require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
  ChannelType,
  REST,
  Routes,
  SlashCommandBuilder,
} = require('discord.js');

// DATA_DIR kann auf ein Railway-Volume zeigen, damit die Daten Neustarts überleben.
// Wenn nicht gesetzt, wird das lokale Projektverzeichnis genutzt (überlebt Neustarts NICHT dauerhaft).
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'data.json');

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    const initial = { giveaways: {}, ticketCount: 0 };
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}
function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ---------- WINDSMP WIRTSCHAFT ----------
const START_GUTHABEN = 1_000_000;
const MIN_EINSATZ = 100_000;
const DAILY_BETRAG = 100_000;
const DAILY_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function getGuthaben(userId) {
  const data = loadData();
  if (!data.economy) data.economy = {};
  if (!(userId in data.economy)) {
    data.economy[userId] = START_GUTHABEN;
    saveData(data);
  }
  return data.economy[userId];
}

function setGuthaben(userId, betrag) {
  const data = loadData();
  if (!data.economy) data.economy = {};
  data.economy[userId] = betrag;
  saveData(data);
}

function formatGuthaben(betrag) {
  return betrag.toLocaleString('de-DE');
}

// Erlaubt Eingaben wie "500000", "500.000", "100k", "1m", "2,5m"
function parseBetrag(input) {
  if (!input) return NaN;
  const match = input.trim().toLowerCase().match(/^([\d.,]+)\s*(k|m)?$/);
  if (!match) return NaN;

  let zahlStr = match[1];
  const einheit = match[2];

  if (einheit) {
    zahlStr = zahlStr.replace(',', '.').replace(/\.(?=.*\.)/g, ''); // nur letzten Punkt als Dezimaltrennzeichen behalten
    const zahl = parseFloat(zahlStr);
    if (isNaN(zahl)) return NaN;
    return Math.round(zahl * (einheit === 'k' ? 1_000 : 1_000_000));
  }

  zahlStr = zahlStr.replace(/[.,]/g, ''); // ohne Einheit: Punkte/Kommas sind Tausendertrennzeichen
  const zahl = parseInt(zahlStr, 10);
  return isNaN(zahl) ? NaN : zahl;
}

// Alle Spiele: jedes hat exakt 50/50 Gewinnchance (gesetzlich vorgeschrieben)
const GAMES = {
  game_coinflip: {
    label: 'Coinflip', emoji: '🪙', titel: 'Coinflip', type: 'choice',
    description: 'Kopf oder Zahl wählen – 50/50',
    choices: [
      { key: 'kopf', label: 'Kopf', emoji: '🙂' },
      { key: 'zahl', label: 'Zahl', emoji: '🔢' },
    ],
    frames: ['🪙 Die Münze wird geworfen...', '🪙 ...sie dreht sich in der Luft...', '🪙 ...und fällt...'],
    resolve: () => {
      const outcomeKey = Math.random() < 0.5 ? 'kopf' : 'zahl';
      return { outcomeKey, displayText: outcomeKey === 'kopf' ? 'Kopf' : 'Zahl' };
    },
  },
  game_wuerfel: {
    label: 'Zahlenwürfeln', emoji: '🎲', titel: 'Zahlenwürfeln', type: 'number',
    description: 'Tippe eine Zahl 1-6 – je näher am Wurf, desto mehr gewinnst du',
    frames: ['🎲 Der Würfel rollt...', '🎲 ...er wackelt...', '🎲 ...kommt zur Ruhe...'],
  },
  game_karte: {
    label: 'Kartenziehen', emoji: '🃏', titel: 'Kartenziehen', type: 'choice',
    description: 'Rot oder Schwarz wählen – 50/50',
    choices: [
      { key: 'rot', label: 'Rot', emoji: '🔴' },
      { key: 'schwarz', label: 'Schwarz', emoji: '⚫' },
    ],
    frames: ['🃏 Die Karten werden gemischt...', '🃏 ...eine Karte wird gezogen...', '🃏 ...sie wird umgedreht...'],
    resolve: () => {
      const outcomeKey = Math.random() < 0.5 ? 'rot' : 'schwarz';
      return { outcomeKey, displayText: outcomeKey === 'rot' ? 'Rot' : 'Schwarz' };
    },
  },
  game_tresor: {
    label: 'Tresor knacken', emoji: '🔓', titel: 'Tresor knacken', type: 'tresor',
    description: 'Wähle 1 von 4 Schlössern – 2 gewinnen, 2 verlieren (50/50)',
    frames: ['🔒 Du knackst das Schloss...', '🔒 ...die Zahlenkombination dreht sich...', '🔒 ...fast geschafft...'],
  },
  game_climb: {
    label: 'Traue dich weiter', emoji: '🪜', titel: 'Traue dich weiter', type: 'climb',
    description: 'Jede Stufe bringt mehr Gewinn – aber du kannst auch alles verlieren!',
  },
  game_lava: {
    label: 'Boden oder Lava', emoji: '🌋', titel: 'Boden oder Lava', type: 'lava',
    description: 'Wähle Links oder Rechts – gleiche Chancen wie bei der Leiter!',
  },
};

// Traue dich weiter / Boden oder Lava: pro Stufe 80% Überlebenschance
const CLIMB_UEBERLEBENS_CHANCE = 0.8;
const CLIMB_MULTIPLIKATOR_PRO_STUFE = 1.2; // niedriger als der "faire" Wert (2.0) -> kleinere Auszahlung pro Stufe
const CLIMB_MAX_STUFEN = 10;
const climbGames = new Map(); // token -> { userId, einsatz, stufe, multiplikator, interaction }
const lavaGames = new Map(); // token -> { userId, einsatz, stufe, multiplikator }

function generateToken() {
  return Math.random().toString(36).slice(2, 10);
}

// Zahlenwürfeln: Auszahlungsfaktor je nach Abstand zwischen getippter Zahl und Wurf (0 = exakt getroffen)
const ZAHL_NET_FACTOR = { 0: 5, 1: 1, 2: 0, 3: -0.5, 4: -1, 5: -1 };

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buildClimbEmbed(game, status, gewinn) {
  const moeglicheAuszahlung = Math.round(game.einsatz * game.multiplikator);

  if (status === 'verloren') {
    return new EmbedBuilder()
      .setTitle('🪜 Traue dich weiter')
      .setDescription(`💥 Du bist auf Stufe **${game.stufe + 1}** gescheitert und hast deinen kompletten Einsatz von **${formatGuthaben(game.einsatz)}** WindSMP-Coins verloren.`)
      .setColor(0xe74c3c);
  }
  if (status === 'gewonnen') {
    return new EmbedBuilder()
      .setTitle('🪜 Traue dich weiter')
      .setDescription(`✅ Du bist bei Stufe **${game.stufe}** mit **${game.multiplikator.toFixed(2)}x** ausgestiegen und hast **${formatGuthaben(gewinn)}** WindSMP-Coins erhalten!`)
      .addFields({ name: 'Neuer Kontostand', value: formatGuthaben(getGuthaben(game.userId)) })
      .setFooter({ text: 'Wähle unten direkt weiter, wenn du willst. Diese Nachricht löscht sich in 1 Minute.' })
      .setColor(0x2ecc71);
  }

  return new EmbedBuilder()
    .setTitle('🪜 Traue dich weiter')
    .setDescription(
      `Stufe **${game.stufe}/${CLIMB_MAX_STUFEN}**\n` +
      `Aktueller Multiplikator: **${game.multiplikator.toFixed(2)}x**\n` +
      `Einsatz: **${formatGuthaben(game.einsatz)}** Coins\n` +
      `Mögliche Auszahlung: **${formatGuthaben(moeglicheAuszahlung)}** Coins\n\n` +
      `Nächste Stufe: **${Math.round(CLIMB_UEBERLEBENS_CHANCE * 100)}%** Erfolgschance. Weiter wagen oder aussteigen?`
    )
    .setColor(0x9b59b6);
}

function buildClimbRow(token, game) {
  const komponenten = [];
  if (game.stufe < CLIMB_MAX_STUFEN) {
    komponenten.push(new ButtonBuilder().setCustomId(`climb_weiter::${token}`).setLabel('⬆️ Weiter wagen').setStyle(ButtonStyle.Primary));
  }
  if (game.stufe > 0) {
    komponenten.push(new ButtonBuilder().setCustomId(`climb_aussteigen::${token}`).setLabel('💰 Aussteigen').setStyle(ButtonStyle.Success));
  }
  return new ActionRowBuilder().addComponents(komponenten);
}

function buildLavaEmbed(game, status, gewinn) {
  const moeglicheAuszahlung = Math.round(game.einsatz * game.multiplikator);

  if (status === 'verloren') {
    return new EmbedBuilder()
      .setTitle('🌋 Boden oder Lava')
      .setDescription(`🔥 Auf Stufe **${game.stufe + 1}** war es Lava! Du hast deinen kompletten Einsatz von **${formatGuthaben(game.einsatz)}** WindSMP-Coins verloren.`)
      .setColor(0xe74c3c);
  }
  if (status === 'gewonnen') {
    return new EmbedBuilder()
      .setTitle('🌋 Boden oder Lava')
      .setDescription(`✅ Du bist bei Stufe **${game.stufe}** mit **${game.multiplikator.toFixed(2)}x** ausgestiegen und hast **${formatGuthaben(gewinn)}** WindSMP-Coins erhalten!`)
      .addFields({ name: 'Neuer Kontostand', value: formatGuthaben(getGuthaben(game.userId)) })
      .setFooter({ text: 'Wähle unten direkt weiter, wenn du willst. Diese Nachricht löscht sich in 1 Minute.' })
      .setColor(0x2ecc71);
  }

  return new EmbedBuilder()
    .setTitle('🌋 Boden oder Lava')
    .setDescription(
      `Stufe **${game.stufe}/${CLIMB_MAX_STUFEN}**\n` +
      `Aktueller Multiplikator: **${game.multiplikator.toFixed(2)}x**\n` +
      `Einsatz: **${formatGuthaben(game.einsatz)}** Coins\n` +
      `Mögliche Auszahlung: **${formatGuthaben(moeglicheAuszahlung)}** Coins\n\n` +
      `Wähle Links oder Rechts – unter einer Seite ist Boden, unter der anderen Lava (**${Math.round(CLIMB_UEBERLEBENS_CHANCE * 100)}%** Erfolgschance).`
    )
    .setColor(0x9b59b6);
}

function buildLavaRow(token, game) {
  const komponenten = [];
  if (game.stufe < CLIMB_MAX_STUFEN) {
    komponenten.push(
      new ButtonBuilder().setCustomId(`lava_choice::${token}::links`).setLabel('⬅️ Links').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`lava_choice::${token}::rechts`).setLabel('➡️ Rechts').setStyle(ButtonStyle.Primary)
    );
  }
  if (game.stufe > 0) {
    komponenten.push(new ButtonBuilder().setCustomId(`lava_aussteigen::${token}`).setLabel('💰 Aussteigen').setStyle(ButtonStyle.Success));
  }
  return new ActionRowBuilder().addComponents(komponenten);
}

function buildGameSelectRow() {
  const menu = new StringSelectMenuBuilder()
    .setCustomId('game_select')
    .setPlaceholder('Spiel auswählen...')
    .addOptions(
      Object.entries(GAMES).map(([value, g]) => ({
        label: g.label, value, emoji: g.emoji, description: g.description,
      }))
    );
  return new ActionRowBuilder().addComponents(menu);
}



const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Channel],
});

const TICKET_CATEGORIES = {
  ticket_general: 'Allgemein',
  ticket_bugs: 'Bugs',
  ticket_mod_discord: 'Modbewerbung Discord',
  ticket_mod_twitch: 'Modbewerbung Twitch',
  ticket_deposit: 'Einzahlung',
};

const CLAN_TICKET_CATEGORIES = {
  clan_ticket_1: 'Clanbewerbung Clan 1',
  clan_ticket_2: 'Clanbewerbung Clan 2',
};

const SUPPORT_TICKET_CATEGORIES = {
  support_fragen: 'Fragen',
  support_bugs: 'Bugs',
};

// ---------- SLASH-COMMANDS DEFINIEREN ----------
const slashCommands = [
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

  new SlashCommandBuilder()
    .setName('setwillkommenskanal')
    .setDescription('Legt fest, in welchem Kanal neue Mitglieder begrüßt werden (nur für Team)')
    .setDefaultMemberPermissions(0)
    .addChannelOption(opt =>
      opt.setName('kanal')
        .setDescription('Der Kanal für Willkommensnachrichten')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true)),

  new SlashCommandBuilder()
    .setName('clan-ticket')
    .setDescription('Postet das Clan-Bewerbungs-Ticket-Panel (nur für Team)')
    .setDefaultMemberPermissions(0),

  new SlashCommandBuilder()
    .setName('support-ticket')
    .setDescription('Postet das Support-Ticket-Panel mit Fragen/Bugs (nur für Team)')
    .setDefaultMemberPermissions(0),

  new SlashCommandBuilder()
    .setName('verify-panel')
    .setDescription('Postet das Verify-Panel (nur für Team)')
    .setDefaultMemberPermissions(0),

  new SlashCommandBuilder()
    .setName('ing')
    .setDescription('Zeigt den registrierten Ingame-Namen eines Mitglieds (nur für Team)')
    .setDefaultMemberPermissions(0)
    .addUserOption(opt =>
      opt.setName('mitglied').setDescription('Welches Mitglied?').setRequired(true)),

  new SlashCommandBuilder()
    .setName('twitch-setup')
    .setDescription('Richtet die Twitch-Live-Benachrichtigung ein (nur für Team)')
    .setDefaultMemberPermissions(0)
    .addStringOption(opt =>
      opt.setName('client_id').setDescription('Twitch Client-ID (von dev.twitch.tv/console/apps)').setRequired(true))
    .addStringOption(opt =>
      opt.setName('client_secret').setDescription('Twitch Client-Secret').setRequired(true))
    .addStringOption(opt =>
      opt.setName('username').setDescription("Dein Twitch-Benutzername (aus twitch.tv/NAME)").setRequired(true))
    .addChannelOption(opt =>
      opt.setName('kanal')
        .setDescription('Discord-Kanal für die Live-Benachrichtigung')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true))
    .addRoleOption(opt =>
      opt.setName('ping_rolle').setDescription('Optional: Rolle, die bei Live-Start gepingt wird').setRequired(false)),

  new SlashCommandBuilder()
    .setName('profil')
    .setDescription('Zeigt das WindSMP-Profil eines Mitglieds')
    .addUserOption(opt =>
      opt.setName('mitglied').setDescription('Wessen Profil? (leer lassen für dein eigenes)').setRequired(false)),

  new SlashCommandBuilder()
    .setName('spiele-panel')
    .setDescription('Postet das Panel zum Auswählen von Spielen (nur für Team)')
    .setDefaultMemberPermissions(0),

  new SlashCommandBuilder()
    .setName('guthaben-aufladen')
    .setDescription('Verändert das WindSMP-Guthaben eines Mitglieds (nur für Team)')
    .setDefaultMemberPermissions(0)
    .addUserOption(opt =>
      opt.setName('mitglied').setDescription('Welches Mitglied?').setRequired(true))
    .addIntegerOption(opt =>
      opt.setName('betrag').setDescription('Betrag (negativ für Abzug, z.B. -500000)').setRequired(true)),

  new SlashCommandBuilder()
    .setName('daily')
    .setDescription('Hole dir dein tägliches WindSMP-Guthaben (100.000 Coins, einmal pro Tag)'),

  new SlashCommandBuilder()
    .setName('livecrash-start')
    .setDescription('Startet das öffentliche Live-Crash-Event in diesem Kanal (nur für Team)')
    .setDefaultMemberPermissions(0),

  new SlashCommandBuilder()
    .setName('livecrash-stop')
    .setDescription('Stoppt das öffentliche Live-Crash-Event (nur für Team)')
    .setDefaultMemberPermissions(0),
].map(c => c.toJSON());

async function registerSlashCommands() {
  try {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    console.log('Registriere Slash-Commands...');
    if (process.env.GUILD_ID) {
      await rest.put(
        Routes.applicationGuildCommands(client.user.id, process.env.GUILD_ID),
        { body: slashCommands }
      );
      console.log('Slash-Commands für Server registriert (sofort verfügbar).');
    } else {
      await rest.put(
        Routes.applicationCommands(client.user.id),
        { body: slashCommands }
      );
      console.log('Globale Slash-Commands registriert (kann bis zu 1h dauern).');
    }
  } catch (err) {
    console.error('Fehler beim Registrieren der Slash-Commands:', err);
  }
}

// ---------- READY ----------
client.once('ready', async () => {
  console.log(`Eingeloggt als ${client.user.tag}`);
  await registerSlashCommands();
  setInterval(checkGiveaways, 15_000); // alle 15 Sekunden prüfen, ob ein Giveaway endet

  const data = loadData();
  const hatTwitchConfig = data.twitchConfig || (process.env.TWITCH_CLIENT_ID && process.env.TWITCH_CLIENT_SECRET && process.env.TWITCH_USERNAME);
  if (hatTwitchConfig && !twitchCheckStarted) {
    twitchCheckStarted = true;
    setInterval(checkTwitchLive, 60_000); // alle 60 Sekunden prüfen, ob der Twitch-Kanal live ist
    checkTwitchLive();
  }
});

// ---------- WILLKOMMENSNACHRICHT ----------
client.on('guildMemberAdd', async (member) => {
  const data = loadData();
  const channelId = data.welcomeChannelId || process.env.WELCOME_CHANNEL_ID;
  if (!channelId) return;
  try {
    const channel = await member.guild.channels.fetch(channelId);
    if (!channel) return;

    const embed = new EmbedBuilder()
      .setTitle('👋 Willkommen!')
      .setDescription(
        (process.env.WELCOME_MESSAGE || 'Willkommen auf dem Server, {user}! Schön, dass du da bist.')
          .replace('{user}', `${member}`)
          .replace('{username}', member.user.username)
          .replace('{server}', member.guild.name)
      )
      .setThumbnail(member.user.displayAvatarURL())
      .setColor(0x57f287)
      .setFooter({ text: `Mitglied #${member.guild.memberCount}` });

    await channel.send({ content: `${member}`, embeds: [embed] });
  } catch (e) {
    console.error('Fehler beim Senden der Willkommensnachricht:', e);
  }
});

// ---------- INTERACTIONS ----------
client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      await handleSlashCommand(interaction);
    } else if (interaction.isStringSelectMenu()) {
      if (interaction.customId === 'ticket_select') {
        await handleTicketSelect(interaction);
      } else if (interaction.customId === 'clan_ticket_select') {
        await handleClanTicketSelect(interaction);
      } else if (interaction.customId === 'support_ticket_select') {
        await handleSupportTicketSelect(interaction);
      } else if (interaction.customId === 'game_select') {
        await handleGameSelect(interaction);
      }
    } else if (interaction.isButton()) {
      if (interaction.customId === 'ticket_close') {
        await handleTicketClose(interaction);
      } else if (interaction.customId === 'verify_button') {
        await handleVerifyButton(interaction);
      } else if (interaction.customId.startsWith('giveaway_join_')) {
        await handleGiveawayJoinButton(interaction);
      } else if (interaction.customId.startsWith('game_choice::')) {
        await handleGameChoiceButton(interaction);
      } else if (interaction.customId.startsWith('tresor_pick::')) {
        await handleTresorPick(interaction);
      } else if (interaction.customId === 'livecrash_join') {
        await handleLiveCrashJoin(interaction);
      } else if (interaction.customId === 'livecrash_cashout') {
        await handleLiveCrashCashout(interaction);
      } else if (interaction.customId.startsWith('climb_weiter::')) {
        await handleClimbWeiter(interaction);
      } else if (interaction.customId.startsWith('climb_aussteigen::')) {
        await handleClimbAussteigen(interaction);
      } else if (interaction.customId.startsWith('lava_choice::')) {
        await handleLavaChoice(interaction);
      } else if (interaction.customId.startsWith('lava_aussteigen::')) {
        await handleLavaAussteigen(interaction);
      }
    } else if (interaction.isModalSubmit()) {
      if (interaction.customId.startsWith('giveaway_modal_')) {
        await handleGiveawayModalSubmit(interaction);
      } else if (interaction.customId.startsWith('clan_app_modal_')) {
        await handleClanApplicationModalSubmit(interaction);
      } else if (interaction.customId.startsWith('game_modal_')) {
        await handleGameModalSubmit(interaction);
      } else if (interaction.customId === 'livecrash_bet_modal') {
        await handleLiveCrashBetModalSubmit(interaction);
      } else if (interaction.customId === 'verify_modal') {
        await handleVerifyModalSubmit(interaction);
      }
    }
  } catch (err) {
    console.error(err);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'Es ist ein Fehler aufgetreten.', ephemeral: true }).catch(() => {});
    }
  }
});

// ---------- SLASH COMMANDS ----------
async function handleSlashCommand(interaction) {
  const { commandName } = interaction;

  if (commandName === 'ticket-panel') {
    const embed = new EmbedBuilder()
      .setTitle('🎫 Support-Ticket erstellen')
      .setDescription('Wähle unten eine Kategorie aus, um ein Ticket zu eröffnen.')
      .setColor(0x5865f2);

    const menu = new StringSelectMenuBuilder()
      .setCustomId('ticket_select')
      .setPlaceholder('Kategorie auswählen...')
      .addOptions(
        { label: 'Allgemein', value: 'ticket_general', emoji: '💬' },
        { label: 'Bugs', value: 'ticket_bugs', emoji: '🐞' },
        { label: 'Modbewerbung Discord', value: 'ticket_mod_discord', emoji: '🛡️' },
        { label: 'Modbewerbung Twitch', value: 'ticket_mod_twitch', emoji: '🎥' },
        { label: 'Einzahlung', value: 'ticket_deposit', emoji: '💰' },
      );

    const row = new ActionRowBuilder().addComponents(menu);
    await interaction.reply({ embeds: [embed], components: [row] });
  }

  if (commandName === 'clan-ticket') {
    const embed = new EmbedBuilder()
      .setTitle('⚔️ Clanbewerbung')
      .setDescription('Wähle unten aus, für welchen Clan du dich bewerben möchtest.')
      .setColor(0x5865f2);

    const menu = new StringSelectMenuBuilder()
      .setCustomId('clan_ticket_select')
      .setPlaceholder('Clan auswählen...')
      .addOptions(
        { label: 'Clan 1', value: 'clan_ticket_1', emoji: '⚔️' },
        { label: 'Clan 2', value: 'clan_ticket_2', emoji: '🛡️' },
      );

    const row = new ActionRowBuilder().addComponents(menu);
    await interaction.reply({ embeds: [embed], components: [row] });
  }

  if (commandName === 'support-ticket') {
    const embed = new EmbedBuilder()
      .setTitle('🎫 Support-Ticket')
      .setDescription('Wähle unten eine Kategorie aus, um ein Ticket zu eröffnen.')
      .setColor(0x5865f2);

    const menu = new StringSelectMenuBuilder()
      .setCustomId('support_ticket_select')
      .setPlaceholder('Kategorie auswählen...')
      .addOptions(
        { label: 'Fragen', value: 'support_fragen', emoji: '❓' },
        { label: 'Bugs', value: 'support_bugs', emoji: '🐞' },
      );

    const row = new ActionRowBuilder().addComponents(menu);
    await interaction.reply({ embeds: [embed], components: [row] });
  }

  if (commandName === 'verify-panel') {
    const embed = new EmbedBuilder()
      .setTitle('✅ Verifizierung')
      .setDescription('Klicke auf den Button und gib deinen Minecraft-Ingame-Namen ein, um dich zu verifizieren.')
      .setColor(0x5865f2);

    const button = new ButtonBuilder().setCustomId('verify_button').setLabel('✅ Verify').setStyle(ButtonStyle.Success);
    const row2 = new ActionRowBuilder().addComponents(button);

    await interaction.reply({ embeds: [embed], components: [row2] });
  }

  if (commandName === 'ing') {
    const ziel = interaction.options.getUser('mitglied');
    const data = loadData();
    const ingameName = data.verifiedNames && data.verifiedNames[ziel.id];

    if (!ingameName) {
      return interaction.reply({ content: `${ziel} hat sich noch nicht über /verify-panel verifiziert.`, ephemeral: true });
    }

    await interaction.reply({ content: `Ingame-Name von ${ziel}: **${ingameName}**`, ephemeral: true });
  }

  if (commandName === 'umfrage') {
    const frage = interaction.options.getString('frage');
    const optionenRaw = interaction.options.getString('optionen');
    const optionen = optionenRaw.split(',').map(o => o.trim()).filter(Boolean).slice(0, 5);

    if (optionen.length < 2) {
      return interaction.reply({ content: 'Bitte gib mindestens 2 Optionen an, mit Komma getrennt.', ephemeral: true });
    }

    const zahlenEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];
    const beschreibung = optionen.map((opt, i) => `${zahlenEmojis[i]} ${opt}`).join('\n');

    const embed = new EmbedBuilder()
      .setTitle(`📊 ${frage}`)
      .setDescription(beschreibung)
      .setFooter({ text: `Umfrage erstellt von ${interaction.user.tag}` })
      .setColor(0xf1c40f);

    await interaction.reply({ embeds: [embed] });
    const message = await interaction.fetchReply();
    for (let i = 0; i < optionen.length; i++) {
      await message.react(zahlenEmojis[i]);
    }
  }

  if (commandName === 'giveaway-start') {
    const preis = interaction.options.getString('preis');
    const dauer = interaction.options.getInteger('dauer');
    const gewinnerAnzahl = interaction.options.getInteger('gewinner');
    const endTime = Date.now() + dauer * 60_000;

    const embed = new EmbedBuilder()
      .setTitle('🎉 Giveaway 🎉')
      .setDescription(
        `**Preis:** ${preis}\n**Gewinner:** ${gewinnerAnzahl}\n**Endet:** <t:${Math.floor(endTime / 1000)}:R>\n\nKlicke auf den Button, um teilzunehmen! Du musst deinen Ingame-Namen angeben.`
      )
      .setColor(0x2ecc71)
      .setFooter({ text: '0 Teilnehmer' });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('giveaway_join_temp')
        .setLabel('🎉 Teilnehmen')
        .setStyle(ButtonStyle.Success)
    );

    await interaction.reply({ embeds: [embed], components: [row] });
    const message = await interaction.fetchReply();

    // customId enthält jetzt die echte message.id
    const finalRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`giveaway_join_${message.id}`)
        .setLabel('🎉 Teilnehmen')
        .setStyle(ButtonStyle.Success)
    );
    await message.edit({ components: [finalRow] });

    const data = loadData();
    data.giveaways[message.id] = {
      channelId: interaction.channelId,
      preis,
      gewinnerAnzahl,
      endTime,
      entries: {}, // userId -> ingameName
      beendet: false,
    };
    saveData(data);
  }

  if (commandName === 'giveaway-end') {
    const messageId = interaction.options.getString('message_id');
    const data = loadData();
    const giveaway = data.giveaways[messageId];
    if (!giveaway) {
      return interaction.reply({ content: 'Kein Giveaway mit dieser Message-ID gefunden.', ephemeral: true });
    }
    if (giveaway.beendet) {
      return interaction.reply({ content: 'Dieses Giveaway wurde bereits beendet.', ephemeral: true });
    }
    await interaction.reply({ content: 'Giveaway wird beendet...', ephemeral: true });
    await endGiveaway(messageId);
  }

  if (commandName === 'setwillkommenskanal') {
    const kanal = interaction.options.getChannel('kanal');
    const data = loadData();
    data.welcomeChannelId = kanal.id;
    saveData(data);
    await interaction.reply({ content: `Willkommensnachrichten werden ab jetzt in ${kanal} gepostet.`, ephemeral: true });
  }

  if (commandName === 'twitch-setup') {
    const clientId = interaction.options.getString('client_id');
    const clientSecret = interaction.options.getString('client_secret');
    const username = interaction.options.getString('username');
    const kanal = interaction.options.getChannel('kanal');
    const pingRolle = interaction.options.getRole('ping_rolle');

    const data = loadData();
    data.twitchConfig = {
      clientId,
      clientSecret,
      username: username.toLowerCase(),
      announceChannelId: kanal.id,
      pingRoleId: pingRolle ? pingRolle.id : null,
    };
    saveData(data);

    // Token-Cache zurücksetzen, damit die neuen Zugangsdaten sofort genutzt werden
    twitchAppToken = null;
    twitchTokenExpiry = 0;
    if (!twitchCheckStarted) {
      twitchCheckStarted = true;
      setInterval(checkTwitchLive, 60_000);
    }
    checkTwitchLive();

    await interaction.reply({ content: `Twitch-Benachrichtigung eingerichtet für **${username}** → wird in ${kanal} gepostet.`, ephemeral: true });
  }

  if (commandName === 'profil') {
    const ziel = interaction.options.getUser('mitglied') || interaction.user;
    const guthaben = getGuthaben(ziel.id);
    const imMinus = guthaben < 0;

    const embed = new EmbedBuilder()
      .setTitle(`💼 WindSMP-Profil von ${ziel.username}`)
      .setThumbnail(ziel.displayAvatarURL())
      .addFields(
        {
          name: imMinus ? 'Schulden' : 'Guthaben',
          value: `${formatGuthaben(Math.abs(guthaben))} WindSMP-Coins`,
        }
      )
      .setColor(imMinus ? 0xe74c3c : 0x2ecc71);

    if (imMinus) {
      embed.setDescription('⚠️ Du bist im Minus und kannst aktuell nicht spielen. Öffne ein Einzahlungs-Ticket, um deine Schulden zu begleichen.');
    }

    await interaction.reply({ embeds: [embed] });
  }

  if (commandName === 'spiele-panel') {
    const embed = new EmbedBuilder()
      .setTitle('🎮 WindSMP Spiele')
      .setDescription(`Wähle unten ein Spiel aus, um zu spielen.\nMindesteinsatz: **${formatGuthaben(MIN_EINSATZ)}** WindSMP-Coins.\nGewinnchance bei jedem Spiel: genau **50/50**.\n⚠️ Wenn du im Minus bist, musst du erst ein Einzahlungs-Ticket öffnen, bevor du wieder spielen kannst.`)
      .setColor(0x9b59b6);

    await interaction.reply({ embeds: [embed], components: [buildGameSelectRow()] });
  }

  if (commandName === 'guthaben-aufladen') {
    const ziel = interaction.options.getUser('mitglied');
    const betrag = interaction.options.getInteger('betrag');

    const aktuell = getGuthaben(ziel.id);
    const neu = aktuell + betrag;
    setGuthaben(ziel.id, neu);

    await interaction.reply({
      content: `${betrag >= 0 ? '➕' : '➖'} ${ziel} : ${formatGuthaben(Math.abs(betrag))} WindSMP-Coins ${betrag >= 0 ? 'gutgeschrieben' : 'abgezogen'}. Neuer Kontostand: **${formatGuthaben(neu)}**.`,
    });

    // Info-DM an das Mitglied (falls DMs offen)
    await ziel.send(
      `Dein WindSMP-Guthaben wurde ${betrag >= 0 ? 'um' : 'um'} ${formatGuthaben(Math.abs(betrag))} Coins ${betrag >= 0 ? 'aufgeladen' : 'reduziert'}. Neuer Kontostand: ${formatGuthaben(neu)}.`
    ).catch(() => {});
  }

  if (commandName === 'daily') {
    const data = loadData();
    if (!data.dailyClaims) data.dailyClaims = {};
    const letzterClaim = data.dailyClaims[interaction.user.id] || 0;
    const jetzt = Date.now();
    const rest = letzterClaim + DAILY_COOLDOWN_MS - jetzt;

    if (rest > 0) {
      const stunden = Math.floor(rest / 3_600_000);
      const minuten = Math.floor((rest % 3_600_000) / 60_000);
      return interaction.reply({
        content: `⏳ Du hast dein tägliches Guthaben schon abgeholt. Nächstes Mal in **${stunden}h ${minuten}min**.`,
        ephemeral: true,
      });
    }

    const guthaben = getGuthaben(interaction.user.id);
    const neu = guthaben + DAILY_BETRAG;
    setGuthaben(interaction.user.id, neu);

    data.dailyClaims[interaction.user.id] = jetzt;
    saveData(data);

    await interaction.reply({
      content: `✅ Du hast dein tägliches Guthaben abgeholt: **+${formatGuthaben(DAILY_BETRAG)}** WindSMP-Coins! Neuer Kontostand: **${formatGuthaben(neu)}**.`,
      ephemeral: true,
    });
  }

  if (commandName === 'livecrash-start') {
    const bestehend = liveCrashGames.get(interaction.guildId);
    if (bestehend && bestehend.running) {
      return interaction.reply({ content: '⚠️ Das Live-Crash-Event läuft auf diesem Server bereits.', ephemeral: true });
    }
    await interaction.reply({ content: '🚀 Live-Crash-Event wird gestartet...', ephemeral: true });
    startLiveCrash(interaction.guildId, interaction.channel);
  }

  if (commandName === 'livecrash-stop') {
    const bestehend = liveCrashGames.get(interaction.guildId);
    if (!bestehend || !bestehend.running) {
      return interaction.reply({ content: 'Das Live-Crash-Event läuft auf diesem Server gerade nicht.', ephemeral: true });
    }
    stopLiveCrash(interaction.guildId);
    await interaction.reply({ content: '🛑 Live-Crash-Event wurde gestoppt.', ephemeral: true });
  }
}

// ---------- TICKET SYSTEM ----------
async function handleTicketSelect(interaction) {
  const kategorieName = TICKET_CATEGORIES[interaction.values[0]];
  const guild = interaction.guild;
  const data = loadData();
  data.ticketCount += 1;
  saveData(data);

  const channelName = `ticket-${data.ticketCount}-${interaction.user.username}`.toLowerCase().slice(0, 90);

  const overwrites = [
    { id: guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: interaction.user.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
    },
  ];
  if (process.env.STAFF_ROLE_ID) {
    overwrites.push({
      id: process.env.STAFF_ROLE_ID,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
    });
  }

  const channel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: process.env.TICKET_CATEGORY_ID || undefined,
    permissionOverwrites: overwrites,
  });

  const istEinzahlung = interaction.values[0] === 'ticket_deposit';
  const embed = new EmbedBuilder()
    .setTitle(`🎫 Ticket: ${kategorieName}`)
    .setDescription(
      istEinzahlung
        ? `Hallo ${interaction.user}, bitte lade hier einen **Screenshot** deiner Einzahlung hoch. Ein Teammitglied prüft das und lädt danach dein WindSMP-Guthaben auf.`
        : `Hallo ${interaction.user}, ein Teammitglied kümmert sich gleich um dein Anliegen.\n\n**Kategorie:** ${kategorieName}`
    )
    .setColor(0x5865f2);

  const closeButton = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket_close').setLabel('Ticket schließen').setStyle(ButtonStyle.Danger).setEmoji('🔒')
  );

  await channel.send({ content: `${interaction.user} ${process.env.STAFF_ROLE_ID ? `<@&${process.env.STAFF_ROLE_ID}>` : ''}`, embeds: [embed], components: [closeButton] });
  await interaction.reply({ content: `Dein Ticket wurde erstellt: ${channel}`, ephemeral: true });
}

// ---------- SUPPORT-TICKET SYSTEM (Fragen / Bugs) ----------
async function handleSupportTicketSelect(interaction) {
  const kategorieName = SUPPORT_TICKET_CATEGORIES[interaction.values[0]];
  const guild = interaction.guild;
  const data = loadData();
  data.ticketCount += 1;
  saveData(data);

  const channelName = `support-${data.ticketCount}-${interaction.user.username}`.toLowerCase().slice(0, 90);

  const overwrites = [
    { id: guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: interaction.user.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
    },
  ];
  const staffRoleId = process.env.SUPPORT_STAFF_ROLE_ID || process.env.STAFF_ROLE_ID;
  if (staffRoleId) {
    overwrites.push({
      id: staffRoleId,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
    });
  }

  const channel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: process.env.SUPPORT_TICKET_CATEGORY_ID || process.env.TICKET_CATEGORY_ID || undefined,
    permissionOverwrites: overwrites,
  });

  const embed = new EmbedBuilder()
    .setTitle(`🎫 Support-Ticket: ${kategorieName}`)
    .setDescription(`Hallo ${interaction.user}, ein Teammitglied kümmert sich gleich um dein Anliegen.\n\n**Kategorie:** ${kategorieName}`)
    .setColor(0x5865f2);

  const closeButton = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket_close').setLabel('Ticket schließen').setStyle(ButtonStyle.Danger).setEmoji('🔒')
  );

  await channel.send({ content: `${interaction.user} ${staffRoleId ? `<@&${staffRoleId}>` : ''}`, embeds: [embed], components: [closeButton] });
  await interaction.reply({ content: `Dein Ticket wurde erstellt: ${channel}`, ephemeral: true });
}

// ---------- CLAN-TICKET SYSTEM ----------
async function handleClanTicketSelect(interaction) {
  const clanValue = interaction.values[0]; // z.B. clan_ticket_1

  const modal = new ModalBuilder()
    .setCustomId(`clan_app_modal_${clanValue}`)
    .setTitle('Clanbewerbung');

  const ingameName = new TextInputBuilder()
    .setCustomId('ingame_name').setLabel('Ingame-Name').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(32);
  const playtime = new TextInputBuilder()
    .setCustomId('playtime').setLabel('Playtime (z.B. in Stunden)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(32);
  const money = new TextInputBuilder()
    .setCustomId('money').setLabel('Money / Ingame-Vermögen').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(32);
  const alter = new TextInputBuilder()
    .setCustomId('alter').setLabel('Alter').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(8);
  const staerkenSchwaechen = new TextInputBuilder()
    .setCustomId('staerken_schwaechen').setLabel('Stärken und Schwächen').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500);

  modal.addComponents(
    new ActionRowBuilder().addComponents(ingameName),
    new ActionRowBuilder().addComponents(playtime),
    new ActionRowBuilder().addComponents(money),
    new ActionRowBuilder().addComponents(alter),
    new ActionRowBuilder().addComponents(staerkenSchwaechen),
  );

  await interaction.showModal(modal);
}

async function handleClanApplicationModalSubmit(interaction) {
  const clanValue = interaction.customId.replace('clan_app_modal_', '');
  const kategorieName = CLAN_TICKET_CATEGORIES[clanValue] || 'Clanbewerbung';

  const ingameName = interaction.fields.getTextInputValue('ingame_name');
  const playtime = interaction.fields.getTextInputValue('playtime');
  const money = interaction.fields.getTextInputValue('money');
  const alter = interaction.fields.getTextInputValue('alter');
  const staerkenSchwaechen = interaction.fields.getTextInputValue('staerken_schwaechen');

  const guild = interaction.guild;
  const data = loadData();
  data.ticketCount += 1;
  saveData(data);

  const channelName = `clan-ticket-${data.ticketCount}-${interaction.user.username}`.toLowerCase().slice(0, 90);

  const overwrites = [
    { id: guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: interaction.user.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
    },
  ];
  const staffRoleId = process.env.CLAN_STAFF_ROLE_ID || process.env.STAFF_ROLE_ID;
  if (staffRoleId) {
    overwrites.push({
      id: staffRoleId,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
    });
  }

  const channel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: process.env.CLAN_TICKET_CATEGORY_ID || process.env.TICKET_CATEGORY_ID || undefined,
    permissionOverwrites: overwrites,
  });

  const embed = new EmbedBuilder()
    .setTitle(`⚔️ Clanbewerbung: ${kategorieName}`)
    .addFields(
      { name: 'Bewerber', value: `${interaction.user}`, inline: true },
      { name: 'Ingame-Name', value: ingameName, inline: true },
      { name: 'Alter', value: alter, inline: true },
      { name: 'Playtime', value: playtime, inline: true },
      { name: 'Money', value: money, inline: true },
      { name: 'Stärken und Schwächen', value: staerkenSchwaechen },
    )
    .setColor(0x5865f2);

  const closeButton = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket_close').setLabel('Ticket schließen').setStyle(ButtonStyle.Danger).setEmoji('🔒')
  );

  await channel.send({ content: `${interaction.user} ${staffRoleId ? `<@&${staffRoleId}>` : ''}`, embeds: [embed], components: [closeButton] });
  await interaction.reply({ content: `Deine Bewerbung wurde eingereicht: ${channel}`, ephemeral: true });
}

async function handleTicketClose(interaction) {
  await interaction.reply('Dieses Ticket wird in 5 Sekunden geschlossen...');
  setTimeout(() => {
    interaction.channel.delete().catch(() => {});
  }, 5000);
}

// ---------- VERIFY SYSTEM ----------
async function handleVerifyButton(interaction) {
  const modal = new ModalBuilder().setCustomId('verify_modal').setTitle('Verifizierung');

  const nameInput = new TextInputBuilder()
    .setCustomId('ingame_name')
    .setLabel('Dein Minecraft-Ingame-Name')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(32);

  modal.addComponents(new ActionRowBuilder().addComponents(nameInput));
  await interaction.showModal(modal);
}

async function handleVerifyModalSubmit(interaction) {
  const ingameName = interaction.fields.getTextInputValue('ingame_name').trim();

  const data = loadData();
  if (!data.verifiedNames) data.verifiedNames = {};
  data.verifiedNames[interaction.user.id] = ingameName;
  saveData(data);

  try {
    await interaction.member.setNickname(ingameName);
  } catch (e) {
    console.error('Konnte Nickname nicht setzen:', e);
  }

  if (process.env.VERIFY_ROLE_ID) {
    try {
      await interaction.member.roles.add(process.env.VERIFY_ROLE_ID);
    } catch (e) {
      console.error('Konnte Verify-Rolle nicht vergeben:', e);
      return interaction.reply({
        content: `Dein Nickname wurde auf **${ingameName}** gesetzt, aber die Verify-Rolle konnte nicht vergeben werden (fehlende Berechtigung oder ungültige Rollen-ID). Bitte meld dich beim Team.`,
        ephemeral: true,
      });
    }
  }

  await interaction.reply({
    content: `✅ Du bist jetzt verifiziert! Dein Nickname wurde auf **${ingameName}** gesetzt.`,
    ephemeral: true,
  });
}

// ---------- GIVEAWAY SYSTEM ----------
async function handleGiveawayJoinButton(interaction) {
  const messageId = interaction.customId.replace('giveaway_join_', '');
  const data = loadData();
  const giveaway = data.giveaways[messageId];

  if (!giveaway || giveaway.beendet) {
    return interaction.reply({ content: 'Dieses Giveaway ist nicht mehr aktiv.', ephemeral: true });
  }
  if (giveaway.entries[interaction.user.id]) {
    return interaction.reply({ content: 'Du nimmst bereits mit dem Ingame-Namen **' + giveaway.entries[interaction.user.id] + '** teil!', ephemeral: true });
  }

  const modal = new ModalBuilder()
    .setCustomId(`giveaway_modal_${messageId}`)
    .setTitle('Giveaway-Teilnahme');

  const input = new TextInputBuilder()
    .setCustomId('ingame_name')
    .setLabel('Dein Ingame-Name')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(32);

  modal.addComponents(new ActionRowBuilder().addComponents(input));
  await interaction.showModal(modal);
}

async function handleGiveawayModalSubmit(interaction) {
  const messageId = interaction.customId.replace('giveaway_modal_', '');
  const ingameName = interaction.fields.getTextInputValue('ingame_name').trim();

  const data = loadData();
  const giveaway = data.giveaways[messageId];
  if (!giveaway || giveaway.beendet) {
    return interaction.reply({ content: 'Dieses Giveaway ist nicht mehr aktiv.', ephemeral: true });
  }

  giveaway.entries[interaction.user.id] = ingameName;
  saveData(data);

  await interaction.reply({ content: `Du nimmst jetzt mit dem Ingame-Namen **${ingameName}** am Giveaway teil. Viel Glück! 🍀`, ephemeral: true });

  // Teilnehmerzahl im Embed aktualisieren
  try {
    const channel = await client.channels.fetch(giveaway.channelId);
    const message = await channel.messages.fetch(messageId);
    const embed = EmbedBuilder.from(message.embeds[0]).setFooter({ text: `${Object.keys(giveaway.entries).length} Teilnehmer` });
    await message.edit({ embeds: [embed] });
  } catch (e) {
    console.error('Konnte Teilnehmerzahl nicht aktualisieren:', e);
  }
}

async function checkGiveaways() {
  const data = loadData();
  const now = Date.now();
  for (const [messageId, giveaway] of Object.entries(data.giveaways)) {
    if (!giveaway.beendet && giveaway.endTime <= now) {
      await endGiveaway(messageId);
    }
  }
}

async function endGiveaway(messageId) {
  const data = loadData();
  const giveaway = data.giveaways[messageId];
  if (!giveaway || giveaway.beendet) return;

  giveaway.beendet = true;
  saveData(data);

  try {
    const channel = await client.channels.fetch(giveaway.channelId);
    const message = await channel.messages.fetch(messageId);

    const teilnehmerIds = Object.keys(giveaway.entries);
    const anzahlGewinner = Math.min(giveaway.gewinnerAnzahl, teilnehmerIds.length);
    const gewinnerIds = [];
    const pool = [...teilnehmerIds];
    for (let i = 0; i < anzahlGewinner; i++) {
      const idx = Math.floor(Math.random() * pool.length);
      gewinnerIds.push(pool.splice(idx, 1)[0]);
    }

    const gewinnerText = gewinnerIds.length
      ? gewinnerIds.map(id => `<@${id}> (Ingame: **${giveaway.entries[id]}**)`).join('\n')
      : 'Niemand hat teilgenommen.';

    const embed = EmbedBuilder.from(message.embeds[0])
      .setTitle('🎉 Giveaway beendet 🎉')
      .setDescription(`**Preis:** ${giveaway.preis}\n\n**Gewinner:**\n${gewinnerText}`)
      .setColor(0xe74c3c);

    await message.edit({ embeds: [embed], components: [] });
    await channel.send(gewinnerIds.length ? `Herzlichen Glückwunsch ${gewinnerIds.map(id => `<@${id}>`).join(', ')}! Ihr habt **${giveaway.preis}** gewonnen! 🎉` : `Das Giveaway für **${giveaway.preis}** ist beendet, es gab leider keine Teilnehmer.`);
  } catch (e) {
    console.error('Fehler beim Beenden des Giveaways:', e);
  }
}

// ---------- TWITCH LIVE-BENACHRICHTIGUNG ----------
let twitchAppToken = null;
let twitchTokenExpiry = 0;
let twitchCheckStarted = false;

function getTwitchConfig() {
  const data = loadData();
  if (data.twitchConfig) return data.twitchConfig;
  if (process.env.TWITCH_CLIENT_ID && process.env.TWITCH_CLIENT_SECRET && process.env.TWITCH_USERNAME) {
    return {
      clientId: process.env.TWITCH_CLIENT_ID,
      clientSecret: process.env.TWITCH_CLIENT_SECRET,
      username: process.env.TWITCH_USERNAME.toLowerCase(),
      announceChannelId: process.env.TWITCH_ANNOUNCE_CHANNEL_ID || null,
      pingRoleId: process.env.TWITCH_PING_ROLE_ID || null,
    };
  }
  return null;
}

async function getTwitchToken(config) {
  if (twitchAppToken && Date.now() < twitchTokenExpiry) return twitchAppToken;

  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: 'client_credentials',
    }),
  });
  const json = await res.json();
  twitchAppToken = json.access_token;
  twitchTokenExpiry = Date.now() + (json.expires_in - 60) * 1000;
  return twitchAppToken;
}

async function checkTwitchLive() {
  try {
    const config = getTwitchConfig();
    if (!config) return;

    const token = await getTwitchToken(config);
    const username = config.username;

    const res = await fetch(`https://api.twitch.tv/helix/streams?user_login=${username}`, {
      headers: {
        'Client-Id': config.clientId,
        Authorization: `Bearer ${token}`,
      },
    });
    const json = await res.json();
    const stream = json.data && json.data[0];

    const data = loadData();
    if (!data.twitch) data.twitch = { live: false, lastStreamId: null };

    if (stream && !data.twitch.live) {
      // Stream ist gerade live gegangen
      data.twitch.live = true;
      data.twitch.lastStreamId = stream.id;
      saveData(data);
      await announceTwitchLive(stream, username, config);
    } else if (stream) {
      // weiterhin live, aber neue Stream-ID (z.B. nach Neustart des Streams) -> trotzdem nur einmal pro ID benachrichtigen
      if (data.twitch.lastStreamId !== stream.id) {
        data.twitch.lastStreamId = stream.id;
        data.twitch.live = true;
        saveData(data);
        await announceTwitchLive(stream, username, config);
      }
    } else if (!stream && data.twitch.live) {
      data.twitch.live = false;
      saveData(data);
    }
  } catch (e) {
    console.error('Fehler beim Prüfen des Twitch-Status:', e);
  }
}

async function announceTwitchLive(stream, username, config) {
  const channelId = config.announceChannelId;
  if (!channelId) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return;

  const thumbnail = stream.thumbnail_url
    .replace('{width}', '640')
    .replace('{height}', '360') + `?t=${Date.now()}`;

  const embed = new EmbedBuilder()
    .setTitle(`🔴 ${stream.user_name} ist jetzt live!`)
    .setURL(`https://twitch.tv/${username}`)
    .setDescription(stream.title || 'Kein Titel angegeben')
    .addFields({ name: 'Spiel', value: stream.game_name || 'Unbekannt', inline: true })
    .setImage(thumbnail)
    .setColor(0x9146ff)
    .setFooter({ text: 'Twitch' });

  const pingRole = config.pingRoleId ? `<@&${config.pingRoleId}> ` : '';
  await channel.send({
    content: `${pingRole}${stream.user_name} ist live: https://twitch.tv/${username}`,
    embeds: [embed],
  });
}

// ---------- SPIELE (WINDSMP) ----------
async function handleGameSelect(interaction) {
  const spiel = interaction.values[0];
  const guthaben = getGuthaben(interaction.user.id);

  if (guthaben < 0) {
    return interaction.reply({
      content: `⚠️ Du bist im Minus (**${formatGuthaben(guthaben)}** WindSMP-Coins) und kannst gerade nicht spielen. Öffne bitte ein Einzahlungs-Ticket, um deine Schulden zu begleichen.`,
      ephemeral: true,
    });
  }

  const spielInfo = GAMES[spiel];
  if (!spielInfo) return;

  const modal = new ModalBuilder()
    .setCustomId(`game_modal_${spiel}`)
    .setTitle(spielInfo.titel);

  const einsatzInput = new TextInputBuilder()
    .setCustomId('einsatz')
    .setLabel(`Einsatz (mind. ${formatGuthaben(MIN_EINSATZ)})`)
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setPlaceholder(`z.B. ${formatGuthaben(MIN_EINSATZ)}, 100k oder 1m`);

  modal.addComponents(new ActionRowBuilder().addComponents(einsatzInput));

  if (spielInfo.type === 'number') {
    const zahlInput = new TextInputBuilder()
      .setCustomId('zahl')
      .setLabel('Deine Zahl (1-6)')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(1)
      .setPlaceholder('z.B. 4');
    modal.addComponents(new ActionRowBuilder().addComponents(zahlInput));
  }

  await interaction.showModal(modal);
}

async function handleGameModalSubmit(interaction) {
  const spiel = interaction.customId.replace('game_modal_', '');
  const spielInfo = GAMES[spiel];
  if (!spielInfo) return;

  const einsatzRaw = interaction.fields.getTextInputValue('einsatz');
  const einsatz = parseBetrag(einsatzRaw);

  if (isNaN(einsatz) || einsatz <= 0) {
    return interaction.reply({ content: 'Bitte gib eine gültige Zahl als Einsatz ein (z.B. 500000, 100k oder 1m).', ephemeral: true });
  }
  if (einsatz < MIN_EINSATZ) {
    return interaction.reply({ content: `Der Mindesteinsatz beträgt **${formatGuthaben(MIN_EINSATZ)}** WindSMP-Coins.`, ephemeral: true });
  }

  const guthaben = getGuthaben(interaction.user.id);
  if (guthaben < 0) {
    return interaction.reply({ content: '⚠️ Du bist im Minus und kannst gerade nicht spielen. Öffne bitte ein Einzahlungs-Ticket.', ephemeral: true });
  }
  if (einsatz > guthaben) {
    return interaction.reply({ content: `Du hast nicht genug Guthaben. Aktueller Kontostand: **${formatGuthaben(guthaben)}**.`, ephemeral: true });
  }

  // ---- TRESOR: 4 Schlösser, 2 gewinnen / 2 verlieren, zufällig gemischt ----
  if (spielInfo.type === 'tresor') {
    const outcomes = shuffleArray(['win', 'win', 'lose', 'lose']);
    const row = new ActionRowBuilder().addComponents(
      outcomes.map((o, i) =>
        new ButtonBuilder()
          .setCustomId(`tresor_pick::${einsatz}::${o}::${i}`)
          .setLabel(`Schloss ${i + 1}`)
          .setEmoji('🔒')
          .setStyle(ButtonStyle.Secondary)
      )
    );
    const embed = new EmbedBuilder()
      .setTitle('🔓 Tresor knacken')
      .setDescription(`Einsatz: **${formatGuthaben(einsatz)}** WindSMP-Coins\n\nWähle 1 von 4 Schlössern – 2 öffnen den Tresor, 2 nicht!`)
      .setColor(0x9b59b6);

    await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
    return;
  }

  // ---- TRAUE DICH WEITER: Einsatz wird abgebucht, dann stufenweise weiterklettern oder aussteigen ----
  if (spielInfo.type === 'climb') {
    setGuthaben(interaction.user.id, guthaben - einsatz);

    const token = generateToken();
    const game = { userId: interaction.user.id, einsatz, stufe: 0, multiplikator: 1.0 };
    climbGames.set(token, game);

    await interaction.reply({
      embeds: [buildClimbEmbed(game, 'aktiv')],
      components: [buildClimbRow(token, game)],
      ephemeral: true,
    });
    return;
  }

  // ---- BODEN ODER LAVA: Links/Rechts wählen, gleiche Chancen wie bei der Leiter ----
  if (spielInfo.type === 'lava') {
    setGuthaben(interaction.user.id, guthaben - einsatz);

    const token = generateToken();
    const game = { userId: interaction.user.id, einsatz, stufe: 0, multiplikator: 1.0 };
    lavaGames.set(token, game);

    await interaction.reply({
      embeds: [buildLavaEmbed(game, 'aktiv')],
      components: [buildLavaRow(token, game)],
      ephemeral: true,
    });
    return;
  }

  // ---- ZAHLENWÜRFELN: Zahl 1-6 eingeben, Auszahlung nach Abstand zum Wurf ----
  if (spielInfo.type === 'number') {
    const zahlRaw = interaction.fields.getTextInputValue('zahl').trim();
    const zahl = parseInt(zahlRaw, 10);

    if (isNaN(zahl) || zahl < 1 || zahl > 6) {
      return interaction.reply({ content: 'Bitte gib eine ganze Zahl zwischen 1 und 6 ein.', ephemeral: true });
    }

    const frames = spielInfo.frames;
    await interaction.reply({
      embeds: [new EmbedBuilder().setTitle(`${spielInfo.emoji} ${spielInfo.titel}`).setDescription(frames[0]).setColor(0x9b59b6)],
      ephemeral: true,
    });
    for (let i = 1; i < frames.length; i++) {
      await sleep(700);
      await interaction.editReply({
        embeds: [new EmbedBuilder().setTitle(`${spielInfo.emoji} ${spielInfo.titel}`).setDescription(frames[i]).setColor(0x9b59b6)],
      });
    }
    await sleep(700);

    const wurf = 1 + Math.floor(Math.random() * 6);
    const distanz = Math.abs(zahl - wurf);
    const faktor = ZAHL_NET_FACTOR[distanz];
    const gewinnBetrag = Math.round(einsatz * faktor);
    const neuerKontostand = guthaben + gewinnBetrag;
    setGuthaben(interaction.user.id, neuerKontostand);

    let titel, farbe, ergebnisText;
    if (gewinnBetrag > 0) {
      titel = `${spielInfo.emoji} Gewonnen!`; farbe = 0x2ecc71;
      ergebnisText = `Du hast **${formatGuthaben(gewinnBetrag)}** WindSMP-Coins gewonnen!`;
    } else if (gewinnBetrag === 0) {
      titel = `${spielInfo.emoji} Unentschieden`; farbe = 0xf1c40f;
      ergebnisText = 'Dein Einsatz wurde zurückerstattet.';
    } else {
      titel = `${spielInfo.emoji} Verloren!`; farbe = 0xe74c3c;
      ergebnisText = `Du hast **${formatGuthaben(Math.abs(gewinnBetrag))}** WindSMP-Coins verloren.`;
    }

    const embed2 = new EmbedBuilder()
      .setTitle(titel)
      .setDescription(`Deine Zahl: **${zahl}** | Gewürfelt: **${wurf}** (Abstand: ${distanz})\n\n${ergebnisText}`)
      .addFields({ name: 'Neuer Kontostand', value: formatGuthaben(neuerKontostand) })
      .setFooter({ text: 'Wähle unten direkt weiter, wenn du willst. Diese Nachricht löscht sich in 1 Minute.' })
      .setColor(farbe);

    await interaction.editReply({ embeds: [embed2], components: [buildGameSelectRow()] });

    setTimeout(async () => {
      try { await interaction.deleteReply(); } catch (e) {}
    }, 60_000);
    return;
  }

  // ---- Standardspiele mit 2 Auswahl-Buttons (Coinflip, Kartenziehen) ----
  const embed = new EmbedBuilder()
    .setTitle(`${spielInfo.emoji} ${spielInfo.titel}`)
    .setDescription(`Einsatz: **${formatGuthaben(einsatz)}** WindSMP-Coins\n\nWähle jetzt deine Seite:`)
    .setColor(0x9b59b6);

  const row = new ActionRowBuilder().addComponents(
    spielInfo.choices.map(c =>
      new ButtonBuilder()
        .setCustomId(`game_choice::${spiel}::${einsatz}::${c.key}`)
        .setLabel(c.label)
        .setEmoji(c.emoji)
        .setStyle(ButtonStyle.Primary)
    )
  );

  await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
}

async function handleTresorPick(interaction) {
  const [, einsatzStr, outcome] = interaction.customId.split('::'); // 4. Teil (Index) wird nicht gebraucht
  const einsatz = parseInt(einsatzStr, 10);
  const guthaben = getGuthaben(interaction.user.id);

  if (guthaben < 0 || einsatz > guthaben) {
    return interaction.update({
      content: `⚠️ Du hast nicht mehr genug Guthaben für diesen Einsatz. Aktueller Kontostand: **${formatGuthaben(guthaben)}**.`,
      embeds: [], components: [],
    });
  }

  const frames = GAMES.game_tresor.frames;
  await interaction.update({
    embeds: [new EmbedBuilder().setTitle('🔓 Tresor knacken').setDescription(frames[0]).setColor(0x9b59b6)],
    components: [],
  });
  for (let i = 1; i < frames.length; i++) {
    await sleep(700);
    await interaction.editReply({
      embeds: [new EmbedBuilder().setTitle('🔓 Tresor knacken').setDescription(frames[i]).setColor(0x9b59b6)],
    });
  }
  await sleep(700);

  const gewonnen = outcome === 'win';
  const neuerKontostand = gewonnen ? guthaben + einsatz : guthaben - einsatz;
  setGuthaben(interaction.user.id, neuerKontostand);

  const embed = new EmbedBuilder()
    .setTitle(gewonnen ? '🔓 Tresor geknackt!' : '🔒 Falsches Schloss!')
    .setDescription(
      gewonnen
        ? `Der Tresor ging auf! Du hast **${formatGuthaben(einsatz)}** WindSMP-Coins gewonnen!`
        : `Der Tresor blieb zu. Du hast **${formatGuthaben(einsatz)}** WindSMP-Coins verloren.`
    )
    .addFields({ name: 'Neuer Kontostand', value: formatGuthaben(neuerKontostand) })
    .setFooter({ text: 'Wähle unten direkt weiter, wenn du willst. Diese Nachricht löscht sich in 1 Minute.' })
    .setColor(gewonnen ? 0x2ecc71 : 0xe74c3c);

  await interaction.editReply({ embeds: [embed], components: [buildGameSelectRow()] });

  setTimeout(async () => {
    try { await interaction.deleteReply(); } catch (e) {}
  }, 60_000);
}

async function handleClimbWeiter(interaction) {
  const token = interaction.customId.replace('climb_weiter::', '');
  const game = climbGames.get(token);

  if (!game) {
    return interaction.reply({ content: 'Diese Runde ist nicht mehr aktiv.', ephemeral: true });
  }
  if (game.userId !== interaction.user.id) {
    return interaction.reply({ content: 'Das ist nicht deine Runde!', ephemeral: true });
  }

  const ueberlebt = Math.random() < CLIMB_UEBERLEBENS_CHANCE;

  if (!ueberlebt) {
    climbGames.delete(token);
    await interaction.update({ embeds: [buildClimbEmbed(game, 'verloren')], components: [buildGameSelectRow()] });
    setTimeout(async () => {
      try { await interaction.deleteReply(); } catch (e) {}
    }, 60_000);
    return;
  }

  game.stufe += 1;
  game.multiplikator = Math.round(game.multiplikator * CLIMB_MULTIPLIKATOR_PRO_STUFE * 100) / 100;

  await interaction.update({ embeds: [buildClimbEmbed(game, 'aktiv')], components: [buildClimbRow(token, game)] });
}

async function handleClimbAussteigen(interaction) {
  const token = interaction.customId.replace('climb_aussteigen::', '');
  const game = climbGames.get(token);

  if (!game) {
    return interaction.reply({ content: 'Diese Runde ist nicht mehr aktiv.', ephemeral: true });
  }
  if (game.userId !== interaction.user.id) {
    return interaction.reply({ content: 'Das ist nicht deine Runde!', ephemeral: true });
  }

  climbGames.delete(token);
  const gewinn = Math.round(game.einsatz * game.multiplikator);
  setGuthaben(interaction.user.id, getGuthaben(interaction.user.id) + gewinn);

  await interaction.update({ embeds: [buildClimbEmbed(game, 'gewonnen', gewinn)], components: [buildGameSelectRow()] });

  setTimeout(async () => {
    try { await interaction.deleteReply(); } catch (e) {}
  }, 60_000);
}

async function handleLavaChoice(interaction) {
  const token = interaction.customId.split('::')[1]; // Seite (links/rechts) beeinflusst die Chance nicht - beide gleich fair
  const game = lavaGames.get(token);

  if (!game) {
    return interaction.reply({ content: 'Diese Runde ist nicht mehr aktiv.', ephemeral: true });
  }
  if (game.userId !== interaction.user.id) {
    return interaction.reply({ content: 'Das ist nicht deine Runde!', ephemeral: true });
  }

  const boden = Math.random() < CLIMB_UEBERLEBENS_CHANCE;

  if (!boden) {
    lavaGames.delete(token);
    await interaction.update({ embeds: [buildLavaEmbed(game, 'verloren')], components: [buildGameSelectRow()] });
    setTimeout(async () => {
      try { await interaction.deleteReply(); } catch (e) {}
    }, 60_000);
    return;
  }

  game.stufe += 1;
  game.multiplikator = Math.round(game.multiplikator * CLIMB_MULTIPLIKATOR_PRO_STUFE * 100) / 100;

  await interaction.update({ embeds: [buildLavaEmbed(game, 'aktiv')], components: [buildLavaRow(token, game)] });
}

async function handleLavaAussteigen(interaction) {
  const token = interaction.customId.replace('lava_aussteigen::', '');
  const game = lavaGames.get(token);

  if (!game) {
    return interaction.reply({ content: 'Diese Runde ist nicht mehr aktiv.', ephemeral: true });
  }
  if (game.userId !== interaction.user.id) {
    return interaction.reply({ content: 'Das ist nicht deine Runde!', ephemeral: true });
  }

  lavaGames.delete(token);
  const gewinn = Math.round(game.einsatz * game.multiplikator);
  setGuthaben(interaction.user.id, getGuthaben(interaction.user.id) + gewinn);

  await interaction.update({ embeds: [buildLavaEmbed(game, 'gewonnen', gewinn)], components: [buildGameSelectRow()] });

  setTimeout(async () => {
    try { await interaction.deleteReply(); } catch (e) {}
  }, 60_000);
}

async function handleGameChoiceButton(interaction) {
  const [, spiel, einsatzStr, choiceKey] = interaction.customId.split('::');
  const spielInfo = GAMES[spiel];
  const einsatz = parseInt(einsatzStr, 10);
  if (!spielInfo || isNaN(einsatz)) return;

  // Erneute Prüfung direkt vor dem Spiel (Guthaben könnte sich zwischenzeitlich geändert haben)
  const guthaben = getGuthaben(interaction.user.id);
  if (guthaben < 0 || einsatz > guthaben) {
    return interaction.update({
      content: `⚠️ Du hast nicht mehr genug Guthaben für diesen Einsatz. Aktueller Kontostand: **${formatGuthaben(guthaben)}**.`,
      embeds: [], components: [],
    });
  }

  const gewaehlteOption = spielInfo.choices.find(c => c.key === choiceKey);

  // ---- Animation: Nachricht wird mehrfach aktualisiert, bevor das Ergebnis kommt ----
  await interaction.update({
    embeds: [new EmbedBuilder().setTitle(`${spielInfo.emoji} ${spielInfo.titel}`).setDescription(spielInfo.frames[0]).setColor(0x9b59b6)],
    components: [],
  });
  for (let i = 1; i < spielInfo.frames.length; i++) {
    await sleep(700);
    await interaction.editReply({
      embeds: [new EmbedBuilder().setTitle(`${spielInfo.emoji} ${spielInfo.titel}`).setDescription(spielInfo.frames[i]).setColor(0x9b59b6)],
    });
  }
  await sleep(700);

  // Jedes Spiel hat exakt 50/50 Gewinnchance
  const { outcomeKey, displayText } = spielInfo.resolve();
  const gewonnen = outcomeKey === choiceKey;
  const neuerKontostand = gewonnen ? guthaben + einsatz : guthaben - einsatz;
  setGuthaben(interaction.user.id, neuerKontostand);

  const embed = new EmbedBuilder()
    .setTitle(gewonnen ? `${spielInfo.emoji} Gewonnen!` : `${spielInfo.emoji} Verloren!`)
    .setDescription(
      `Du hast **${gewaehlteOption.label}** gewählt. Ergebnis: **${displayText}**\n\n` +
      (gewonnen
        ? `Du hast **${formatGuthaben(einsatz)}** WindSMP-Coins gewonnen!`
        : `Du hast **${formatGuthaben(einsatz)}** WindSMP-Coins verloren.`)
    )
    .addFields({ name: 'Neuer Kontostand', value: formatGuthaben(neuerKontostand) })
    .setFooter({ text: 'Wähle unten direkt weiter, wenn du willst. Diese Nachricht löscht sich in 1 Minute.' })
    .setColor(gewonnen ? 0x2ecc71 : 0xe74c3c);

  await interaction.editReply({ embeds: [embed], components: [buildGameSelectRow()] });

  // Nachricht nach 1 Minute automatisch löschen
  setTimeout(async () => {
    try {
      await interaction.deleteReply();
    } catch (e) {
      // Nachricht wurde evtl. schon manuell gelöscht - kein Problem
    }
  }, 60_000);
}

// ---------- LIVE CRASH (ÖFFENTLICH, FÜR ALLE SICHTBAR) ----------
// Jeder Discord-Server (Guild) kann sein eigenes, unabhängiges Live-Crash-Event haben.
const WARTEZEIT_SEK = 15; // Countdown vor jeder Runde
const RUNDEN_PAUSE_MS = 8_000; // Pause nach dem Crash, bevor die nächste Runde startet

const liveCrashGames = new Map(); // guildId -> Spielzustand

function createLiveCrashGame(channel) {
  return {
    running: true,
    channel,
    message: null,
    phase: 'idle', // 'waiting' | 'running' | 'crashed'
    countdownEnd: 0,
    crashPoint: 0,
    multiplier: 1.0,
    participants: {}, // userId -> { username, einsatz, cashedOut, cashoutMultiplier, gewinn }
    countdownInterval: null,
    runInterval: null,
  };
}

function startLiveCrash(guildId, channel) {
  const game = createLiveCrashGame(channel);
  liveCrashGames.set(guildId, game);
  runLiveCrashWaitingPhase(game);
}

function stopLiveCrash(guildId) {
  const game = liveCrashGames.get(guildId);
  if (!game) return;
  game.running = false;
  clearInterval(game.countdownInterval);
  clearInterval(game.runInterval);
  liveCrashGames.delete(guildId);
}

function buildLiveCrashJoinRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('livecrash_join').setLabel('💰 Einsatz platzieren').setStyle(ButtonStyle.Success)
  );
}

function buildLiveCrashCashoutRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('livecrash_cashout').setLabel('🛑 Aussteigen').setStyle(ButtonStyle.Danger)
  );
}

function buildLiveCrashWaitingEmbed(game, restSekunden) {
  const teilnehmer = Object.values(game.participants);
  const liste = teilnehmer.length
    ? teilnehmer.map(p => `🟢 **${p.username}** – ${formatGuthaben(p.einsatz)} Coins`).join('\n')
    : 'Noch niemand dabei – sei der Erste!';

  return new EmbedBuilder()
    .setTitle('🚀 LIVE CRASH')
    .setDescription(`**Nächste Runde startet in: ${restSekunden}s**\n\nKlicke auf **"Einsatz platzieren"**, um mitzuspielen.\n\n**Teilnehmer:**\n${liste}`)
    .setColor(0x9b59b6);
}

function buildLiveCrashRunningEmbed(game) {
  const aktive = Object.values(game.participants).filter(p => !p.cashedOut);
  const ausgestiegen = Object.values(game.participants).filter(p => p.cashedOut);

  const aktiveListe = aktive.length
    ? aktive.map(p => `🟢 **${p.username}** – eingestiegen mit ${formatGuthaben(p.einsatz)} Coins`).join('\n')
    : '–';
  const ausgestiegenListe = ausgestiegen.length
    ? ausgestiegen.map(p => `🔴 **${p.username}** – ausgestiegen bei **${p.cashoutMultiplier.toFixed(2)}x** (${formatGuthaben(p.gewinn)} Coins)`).join('\n')
    : '–';

  return new EmbedBuilder()
    .setTitle('🚀 LIVE CRASH')
    .setDescription(`**Multiplikator: ${game.multiplier.toFixed(2)}x**\n\n**Noch dabei:**\n${aktiveListe}\n\n**Ausgestiegen:**\n${ausgestiegenListe}`)
    .setColor(0x9b59b6);
}

async function runLiveCrashWaitingPhase(game) {
  if (!game.running) return;

  // Alte Nachricht der vorherigen Runde löschen, damit sich nichts im Kanal ansammelt
  if (game.message) {
    try { await game.message.delete(); } catch (e) { /* evtl. schon manuell gelöscht */ }
  }

  game.phase = 'waiting';
  game.participants = {};
  game.countdownEnd = Date.now() + WARTEZEIT_SEK * 1000;

  game.message = await game.channel.send({
    embeds: [buildLiveCrashWaitingEmbed(game, WARTEZEIT_SEK)],
    components: [buildLiveCrashJoinRow()],
  });

  game.countdownInterval = setInterval(async () => {
    if (!game.running) { clearInterval(game.countdownInterval); return; }
    const restSekunden = Math.ceil((game.countdownEnd - Date.now()) / 1000);

    if (restSekunden <= 0) {
      clearInterval(game.countdownInterval);
      await startLiveCrashRunningPhase(game);
      return;
    }
    try {
      await game.message.edit({ embeds: [buildLiveCrashWaitingEmbed(game, restSekunden)] });
    } catch (e) { /* Nachricht evtl. gelöscht */ }
  }, 1000);
}

async function startLiveCrashRunningPhase(game) {
  if (!game.running) return;

  game.phase = 'running';
  const r = Math.random();
  game.crashPoint = Math.min(2.72, 1 / (1 - r)); // "provably fair": P(crash > 2x) = 50%, Durchschnitt ≈ 2,0x
  game.multiplier = 1.0;

  try {
    await game.message.edit({ embeds: [buildLiveCrashRunningEmbed(game)], components: [buildLiveCrashCashoutRow()] });
  } catch (e) {}

  game.runInterval = setInterval(async () => {
    if (!game.running) { clearInterval(game.runInterval); return; }
    game.multiplier = Math.round(game.multiplier * 1.04 * 100) / 100;

    if (game.multiplier >= game.crashPoint) {
      clearInterval(game.runInterval);
      await endLiveCrashRound(game);
      return;
    }
    try {
      await game.message.edit({ embeds: [buildLiveCrashRunningEmbed(game)], components: [buildLiveCrashCashoutRow()] });
    } catch (e) {
      clearInterval(game.runInterval);
    }
  }, 800);
}

async function endLiveCrashRound(game) {
  game.phase = 'crashed';

  const verloren = Object.values(game.participants).filter(p => !p.cashedOut);
  const gewonnen = Object.values(game.participants).filter(p => p.cashedOut);

  const verlorenListe = verloren.length
    ? verloren.map(p => `💥 **${p.username}** – verloren (${formatGuthaben(p.einsatz)} Coins)`).join('\n')
    : '–';
  const gewonnenListe = gewonnen.length
    ? gewonnen.map(p => `✅ **${p.username}** – ${p.cashoutMultiplier.toFixed(2)}x → ${formatGuthaben(p.gewinn)} Coins`).join('\n')
    : '–';

  const embed = new EmbedBuilder()
    .setTitle('💥 CRASH!')
    .setDescription(`Bei **${game.crashPoint.toFixed(2)}x** gecrasht!\n\n**Gewonnen:**\n${gewonnenListe}\n\n**Verloren:**\n${verlorenListe}\n\nNächste Runde startet in Kürze...`)
    .setColor(0xe74c3c);

  try {
    await game.message.edit({ embeds: [embed], components: [] });
  } catch (e) {}

  if (game.running) {
    setTimeout(() => runLiveCrashWaitingPhase(game), RUNDEN_PAUSE_MS);
  }
}

async function handleLiveCrashJoin(interaction) {
  const game = liveCrashGames.get(interaction.guildId);
  if (!game || game.phase !== 'waiting') {
    return interaction.reply({ content: 'Die Runde läuft schon oder ist vorbei – warte auf die nächste Runde.', ephemeral: true });
  }
  if (game.participants[interaction.user.id]) {
    return interaction.reply({ content: 'Du bist schon in dieser Runde dabei!', ephemeral: true });
  }
  const guthaben = getGuthaben(interaction.user.id);
  if (guthaben < 0) {
    return interaction.reply({ content: '⚠️ Du bist im Minus und kannst gerade nicht spielen. Öffne bitte ein Einzahlungs-Ticket.', ephemeral: true });
  }

  const modal = new ModalBuilder().setCustomId('livecrash_bet_modal').setTitle('Live Crash – Einsatz');
  const einsatzInput = new TextInputBuilder()
    .setCustomId('einsatz')
    .setLabel(`Einsatz (mind. ${formatGuthaben(MIN_EINSATZ)})`)
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setPlaceholder(`z.B. ${formatGuthaben(MIN_EINSATZ)}, 100k oder 1m`);
  modal.addComponents(new ActionRowBuilder().addComponents(einsatzInput));

  await interaction.showModal(modal);
}

async function handleLiveCrashBetModalSubmit(interaction) {
  const game = liveCrashGames.get(interaction.guildId);
  if (!game || game.phase !== 'waiting') {
    return interaction.reply({ content: 'Die Runde läuft schon oder ist vorbei – warte auf die nächste Runde.', ephemeral: true });
  }
  if (game.participants[interaction.user.id]) {
    return interaction.reply({ content: 'Du bist schon in dieser Runde dabei!', ephemeral: true });
  }

  const einsatz = parseBetrag(interaction.fields.getTextInputValue('einsatz'));
  if (isNaN(einsatz) || einsatz <= 0) {
    return interaction.reply({ content: 'Bitte gib eine gültige Zahl als Einsatz ein (z.B. 500000, 100k oder 1m).', ephemeral: true });
  }
  if (einsatz < MIN_EINSATZ) {
    return interaction.reply({ content: `Der Mindesteinsatz beträgt **${formatGuthaben(MIN_EINSATZ)}** WindSMP-Coins.`, ephemeral: true });
  }

  const guthaben = getGuthaben(interaction.user.id);
  if (guthaben < 0) {
    return interaction.reply({ content: '⚠️ Du bist im Minus und kannst gerade nicht spielen.', ephemeral: true });
  }
  if (einsatz > guthaben) {
    return interaction.reply({ content: `Du hast nicht genug Guthaben. Aktueller Kontostand: **${formatGuthaben(guthaben)}**.`, ephemeral: true });
  }

  // Einsatz wird sofort abgebucht (Auszahlung erfolgt beim Aussteigen)
  setGuthaben(interaction.user.id, guthaben - einsatz);

  game.participants[interaction.user.id] = {
    username: interaction.user.username,
    einsatz,
    cashedOut: false,
    cashoutMultiplier: null,
    gewinn: null,
  };

  await interaction.reply({ content: `✅ Du bist mit **${formatGuthaben(einsatz)}** WindSMP-Coins eingestiegen! Viel Glück.`, ephemeral: true });

  try {
    const restSekunden = Math.max(0, Math.ceil((game.countdownEnd - Date.now()) / 1000));
    await game.message.edit({ embeds: [buildLiveCrashWaitingEmbed(game, restSekunden)] });
  } catch (e) {}
}

async function handleLiveCrashCashout(interaction) {
  const game = liveCrashGames.get(interaction.guildId);
  const teilnehmer = game && game.participants[interaction.user.id];

  if (!game || game.phase !== 'running' || !teilnehmer) {
    return interaction.reply({ content: 'Du bist gerade nicht in einer laufenden Runde.', ephemeral: true });
  }
  if (teilnehmer.cashedOut) {
    return interaction.reply({ content: 'Du bist schon ausgestiegen!', ephemeral: true });
  }

  teilnehmer.cashedOut = true;
  teilnehmer.cashoutMultiplier = game.multiplier;
  teilnehmer.gewinn = Math.round(teilnehmer.einsatz * game.multiplier);
  setGuthaben(interaction.user.id, getGuthaben(interaction.user.id) + teilnehmer.gewinn);

  await interaction.reply({
    content: `🛑 Du bist bei **${game.multiplier.toFixed(2)}x** ausgestiegen und hast **${formatGuthaben(teilnehmer.gewinn)}** WindSMP-Coins erhalten!`,
    ephemeral: true,
  });
}

client.login(process.env.DISCORD_TOKEN);
