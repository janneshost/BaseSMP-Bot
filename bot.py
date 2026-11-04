import io
import os
import re
import asyncio

import discord
from discord import app_commands
from discord.ext import commands

# ------------------------------------------------------------------
# Konfiguration (alles über Railway -> Variables setzen)
# ------------------------------------------------------------------
TOKEN = os.getenv("DISCORD_TOKEN")


def env_int(name):
    value = os.getenv(name, "").strip()
    return int(value) if value.isdigit() else None


SERVER_NAME = os.getenv("SERVER_NAME", "BaseSMP")
WELCOME_CHANNEL_ID = env_int("WELCOME_CHANNEL_ID")
RULES_CHANNEL_ID = env_int("RULES_CHANNEL_ID")        # optional
TICKET_CHANNEL_ID = env_int("TICKET_CHANNEL_ID")      # optional (Link in Willkommensnachricht)
TICKET_CATEGORY_ID = env_int("TICKET_CATEGORY_ID")    # Kategorie, in der Tickets erstellt werden
SUPPORT_ROLE_ID = env_int("SUPPORT_ROLE_ID")          # Team-Rolle, die Tickets sieht
LOG_CHANNEL_ID = env_int("TICKET_LOG_CHANNEL_ID")     # optional: Transcripts
AUTO_ROLE_ID = env_int("AUTO_ROLE_ID")                # optional: Rolle für neue Member

COLOR = 0x2ECC71

TICKET_CATEGORIES = [
    ("Support", "Allgemeine Fragen & Hilfe", "🛠️"),
    ("Bug melden", "Fehler auf dem Server melden", "🐛"),
    ("Bewerbung", "Bewirb dich fürs Team", "📝"),
    ("Entbannung", "Entbannungsantrag stellen", "🔓"),
    ("Sonstiges", "Alles andere", "💬"),
]

intents = discord.Intents.default()
intents.members = True  # wichtig für die Willkommensnachricht


class BaseBot(commands.Bot):
    def __init__(self):
        super().__init__(command_prefix="!", intents=intents)

    async def setup_hook(self):
        # Persistente Views, damit Buttons nach einem Neustart weiter funktionieren
        self.add_view(TicketPanelView())
        self.add_view(TicketControlView())
        await self.tree.sync()


bot = BaseBot()


# ------------------------------------------------------------------
# Willkommensnachricht
# ------------------------------------------------------------------
@bot.event
async def on_member_join(member: discord.Member):
    if member.bot:
        return

    if AUTO_ROLE_ID:
        role = member.guild.get_role(AUTO_ROLE_ID)
        if role:
            try:
                await member.add_roles(role, reason="Auto-Rolle")
            except discord.Forbidden:
                pass

    if not WELCOME_CHANNEL_ID:
        return
    channel = member.guild.get_channel(WELCOME_CHANNEL_ID)
    if not channel:
        return

    description = (
        f"Hey {member.mention}, schön dass du da bist! 🎉\n"
        f"Du bist unser **{member.guild.member_count}. Mitglied**.\n\n"
    )
    if RULES_CHANNEL_ID:
        description += f"📜 Lies dir bitte die Regeln in <#{RULES_CHANNEL_ID}> durch.\n"
    if TICKET_CHANNEL_ID:
        description += f"🎫 Brauchst du Hilfe? Erstelle ein Ticket in <#{TICKET_CHANNEL_ID}>.\n"
    description += f"\nViel Spaß auf **{SERVER_NAME}**!"

    embed = discord.Embed(
        title=f"Willkommen auf {SERVER_NAME}!",
        description=description,
        color=COLOR,
    )
    embed.set_thumbnail(url=member.display_avatar.url)
    embed.set_footer(text=SERVER_NAME)
    await channel.send(content=member.mention, embed=embed)


# ------------------------------------------------------------------
# Ticket-System
# ------------------------------------------------------------------
def is_staff(member: discord.Member) -> bool:
    if member.guild_permissions.manage_channels:
        return True
    if SUPPORT_ROLE_ID:
        return any(r.id == SUPPORT_ROLE_ID for r in member.roles)
    return False


class TicketSelect(discord.ui.Select):
    def __init__(self):
        options = [
            discord.SelectOption(label=name, description=desc, emoji=emoji, value=name)
            for name, desc, emoji in TICKET_CATEGORIES
        ]
        super().__init__(
            placeholder="Wähle eine Ticket-Kategorie …",
            min_values=1,
            max_values=1,
            options=options,
            custom_id="basesmp:ticket_select",
        )

    async def callback(self, interaction: discord.Interaction):
        await create_ticket(interaction, self.values[0])
        # Auswahl im Panel zurücksetzen
        try:
            await interaction.message.edit(view=TicketPanelView())
        except discord.HTTPException:
            pass


class TicketPanelView(discord.ui.View):
    def __init__(self):
        super().__init__(timeout=None)
        self.add_item(TicketSelect())


class TicketControlView(discord.ui.View):
    def __init__(self):
        super().__init__(timeout=None)

    @discord.ui.button(
        label="Ticket schließen",
        style=discord.ButtonStyle.danger,
        emoji="🔒",
        custom_id="basesmp:ticket_close",
    )
    async def close_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        channel = interaction.channel
        topic = channel.topic or ""
        match = re.match(r"ticket_owner:(\d+)", topic)
        owner_id = int(match.group(1)) if match else None

        if not (interaction.user.id == owner_id or is_staff(interaction.user)):
            await interaction.response.send_message(
                "❌ Nur der Ticket-Ersteller oder das Team kann das Ticket schließen.",
                ephemeral=True,
            )
            return

        await interaction.response.send_message("🔒 Ticket wird in 5 Sekunden geschlossen …")
        await send_transcript(channel, interaction.user)
        await asyncio.sleep(5)
        try:
            await channel.delete(reason=f"Ticket geschlossen von {interaction.user}")
        except discord.HTTPException:
            pass


async def send_transcript(channel: discord.TextChannel, closed_by: discord.Member):
    if not LOG_CHANNEL_ID:
        return
    log_channel = channel.guild.get_channel(LOG_CHANNEL_ID)
    if not log_channel:
        return

    lines = []
    async for msg in channel.history(limit=None, oldest_first=True):
        ts = msg.created_at.strftime("%d.%m.%Y %H:%M")
        content = msg.clean_content or ""
        if msg.attachments:
            content += " " + " ".join(a.url for a in msg.attachments)
        lines.append(f"[{ts}] {msg.author}: {content}")

    data = io.BytesIO("\n".join(lines).encode("utf-8"))
    file = discord.File(data, filename=f"{channel.name}.txt")

    embed = discord.Embed(title="Ticket geschlossen", color=0xE74C3C)
    embed.add_field(name="Ticket", value=channel.name, inline=True)
    embed.add_field(name="Geschlossen von", value=closed_by.mention, inline=True)
    await log_channel.send(embed=embed, file=file)


async def create_ticket(interaction: discord.Interaction, category_label: str):
    await interaction.response.defer(ephemeral=True)
    guild = interaction.guild
    user = interaction.user
    marker = f"ticket_owner:{user.id}"

    # Nur ein offenes Ticket pro User
    for ch in guild.text_channels:
        if ch.topic and ch.topic.startswith(marker):
            await interaction.followup.send(
                f"❌ Du hast bereits ein offenes Ticket: {ch.mention}", ephemeral=True
            )
            return

    category = guild.get_channel(TICKET_CATEGORY_ID) if TICKET_CATEGORY_ID else None

    overwrites = {
        guild.default_role: discord.PermissionOverwrite(view_channel=False),
        user: discord.PermissionOverwrite(
            view_channel=True,
            send_messages=True,
            read_message_history=True,
            attach_files=True,
        ),
        guild.me: discord.PermissionOverwrite(
            view_channel=True,
            send_messages=True,
            read_message_history=True,
            manage_channels=True,
        ),
    }
    support_role = guild.get_role(SUPPORT_ROLE_ID) if SUPPORT_ROLE_ID else None
    if support_role:
        overwrites[support_role] = discord.PermissionOverwrite(
            view_channel=True,
            send_messages=True,
            read_message_history=True,
            attach_files=True,
        )

    safe_name = re.sub(r"[^a-z0-9]", "", user.name.lower()) or "user"
    try:
        channel = await guild.create_text_channel(
            name=f"ticket-{safe_name}",
            category=category,
            topic=f"{marker} | {category_label}",
            overwrites=overwrites,
            reason=f"Ticket von {user}",
        )
    except discord.Forbidden:
        await interaction.followup.send(
            "❌ Mir fehlt die Berechtigung, Kanäle zu erstellen.", ephemeral=True
        )
        return

    embed = discord.Embed(
        title=f"🎫 Ticket – {category_label}",
        description=(
            f"Hey {user.mention}, danke für dein Ticket!\n"
            "Beschreibe bitte dein Anliegen so genau wie möglich. "
            "Das Team meldet sich so schnell wie möglich."
        ),
        color=COLOR,
    )
    embed.set_footer(text=SERVER_NAME)

    ping = f"{user.mention} {support_role.mention}" if support_role else user.mention
    await channel.send(content=ping, embed=embed, view=TicketControlView())
    await interaction.followup.send(f"✅ Dein Ticket wurde erstellt: {channel.mention}", ephemeral=True)


@bot.tree.command(name="ticketpanel", description="Sendet das Ticket-Panel in diesen Kanal")
@app_commands.default_permissions(administrator=True)
@app_commands.guild_only()
async def ticketpanel(interaction: discord.Interaction):
    embed = discord.Embed(
        title=f"🎫 {SERVER_NAME} Support",
        description=(
            "Du brauchst Hilfe oder hast ein Anliegen?\n"
            "Wähle unten eine Kategorie aus, um ein Ticket zu erstellen."
        ),
        color=COLOR,
    )
    embed.set_footer(text=SERVER_NAME)
    await interaction.channel.send(embed=embed, view=TicketPanelView())
    await interaction.response.send_message("✅ Panel gesendet.", ephemeral=True)


@bot.tree.command(name="welcometest", description="Testet die Willkommensnachricht")
@app_commands.default_permissions(administrator=True)
@app_commands.guild_only()
async def welcometest(interaction: discord.Interaction):
    await interaction.response.send_message("Teste Willkommensnachricht …", ephemeral=True)
    await on_member_join(interaction.user)


@bot.event
async def on_ready():
    print(f"Eingeloggt als {bot.user} (ID: {bot.user.id})")


if __name__ == "__main__":
    if not TOKEN:
        raise SystemExit("DISCORD_TOKEN ist nicht gesetzt!")
    bot.run(TOKEN)
