import io
import json
import os
import re
import asyncio
from datetime import datetime, timezone

import discord
from discord import app_commands
from discord.ext import commands

# ============================================================
# KONFIGURATION
# Nur der Token kommt aus der Umgebung (DISCORD_TOKEN).
# Alles andere wird im Discord mit /setup eingestellt.
# ============================================================
TOKEN = os.getenv("DISCORD_TOKEN")

CONFIG_FILE = "config.json"

CLAN_NAME = "Duel Clan"
SERVER_NAME = "WindSMP"
EMBED_COLOR = 0x3498DB

MC_NAME_REGEX = re.compile(r"^[A-Za-z0-9_]{3,16}$")
VERIFIED_FILE = "verified.json"  # speichert vergebene MC-Namen


# ============================================================
# Hilfsfunktionen
# ============================================================
def load_config() -> dict:
    if not os.path.exists(CONFIG_FILE):
        return {}
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return {}


def save_config(data: dict) -> None:
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)


def get_cfg(guild_id: int, key: str) -> int:
    return int(load_config().get(str(guild_id), {}).get(key, 0))


def set_cfg(guild_id: int, key: str, value: int) -> None:
    data = load_config()
    data.setdefault(str(guild_id), {})[key] = value
    save_config(data)


def load_verified() -> dict:
    if not os.path.exists(VERIFIED_FILE):
        return {}
    try:
        with open(VERIFIED_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return {}


def save_verified(data: dict) -> None:
    with open(VERIFIED_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


async def send_log(guild: discord.Guild, **kwargs) -> None:
    log_id = get_cfg(guild.id, "log_channel")
    if not log_id:
        return
    channel = guild.get_channel(log_id)
    if channel:
        try:
            await channel.send(**kwargs)
        except discord.HTTPException:
            pass


def is_staff(member: discord.Member) -> bool:
    if member.guild_permissions.administrator:
        return True
    staff_id = get_cfg(member.guild.id, "staff_role")
    return any(r.id == staff_id for r in member.roles)


# ============================================================
# TICKET SYSTEM
# ============================================================
async def create_ticket(
    interaction: discord.Interaction,
    ticket_type: str,
    prefix: str,
    embed: discord.Embed,
):
    guild = interaction.guild
    user = interaction.user

    # Nur ein offenes Ticket pro Typ und Nutzer
    marker = f"ticket:{user.id}:{ticket_type}"
    for ch in guild.text_channels:
        if ch.topic == marker:
            await interaction.response.send_message(
                f"Du hast bereits ein offenes Ticket: {ch.mention}", ephemeral=True
            )
            return

    cat_id = get_cfg(guild.id, "ticket_category")
    staff_id = get_cfg(guild.id, "staff_role")
    category = guild.get_channel(cat_id) if cat_id else None
    staff_role = guild.get_role(staff_id) if staff_id else None

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
            manage_channels=True,
            read_message_history=True,
        ),
    }
    if staff_role:
        overwrites[staff_role] = discord.PermissionOverwrite(
            view_channel=True,
            send_messages=True,
            read_message_history=True,
            attach_files=True,
        )

    safe_name = re.sub(r"[^a-z0-9-]", "", user.name.lower()) or str(user.id)
    try:
        channel = await guild.create_text_channel(
            name=f"{prefix}-{safe_name}"[:90],
            category=category if isinstance(category, discord.CategoryChannel) else None,
            topic=marker,
            overwrites=overwrites,
            reason=f"Ticket ({ticket_type}) von {user}",
        )
    except discord.Forbidden:
        await interaction.response.send_message(
            "Mir fehlen die Rechte, um einen Ticket-Kanal zu erstellen (Kanäle verwalten).",
            ephemeral=True,
        )
        return

    ping = staff_role.mention if staff_role else ""
    await channel.send(
        content=f"{user.mention} {ping}".strip(),
        embed=embed,
        view=TicketControlView(),
        allowed_mentions=discord.AllowedMentions(users=True, roles=True),
    )
    await interaction.response.send_message(
        f"Dein Ticket wurde erstellt: {channel.mention}", ephemeral=True
    )
    await send_log(
        guild,
        content=f"🎫 Neues Ticket **{ticket_type}** von {user.mention}: {channel.mention}",
    )


class ApplicationModal(discord.ui.Modal, title=f"Bewerbung – {CLAN_NAME}"):
    mc_name = discord.ui.TextInput(
        label="Minecraft-Name",
        placeholder="z. B. Steve",
        min_length=3,
        max_length=16,
    )
    age = discord.ui.TextInput(
        label="Alter",
        placeholder="z. B. 16",
        max_length=3,
    )
    experience = discord.ui.TextInput(
        label="Erfahrung (PvP, SMPs, Clans)",
        style=discord.TextStyle.paragraph,
        max_length=800,
    )
    why = discord.ui.TextInput(
        label=f"Warum möchtest du zu {CLAN_NAME}?",
        style=discord.TextStyle.paragraph,
        max_length=800,
    )
    playtime = discord.ui.TextInput(
        label="Wie oft bist du online?",
        placeholder="z. B. täglich 2–3 Stunden",
        max_length=200,
    )

    async def on_submit(self, interaction: discord.Interaction):
        embed = discord.Embed(
            title=f"📨 Clan-Bewerbung – {self.mc_name.value}",
            color=EMBED_COLOR,
            timestamp=datetime.now(timezone.utc),
        )
        embed.add_field(name="Minecraft-Name", value=self.mc_name.value, inline=True)
        embed.add_field(name="Alter", value=self.age.value, inline=True)
        embed.add_field(name="Aktivität", value=self.playtime.value, inline=False)
        embed.add_field(name="Erfahrung", value=self.experience.value, inline=False)
        embed.add_field(name="Motivation", value=self.why.value, inline=False)
        embed.set_footer(text=f"Bewerber: {interaction.user}")
        embed.set_thumbnail(url=interaction.user.display_avatar.url)
        await create_ticket(interaction, "bewerbung", "bewerbung", embed)


class GeneralModal(discord.ui.Modal, title="Allgemeines Ticket"):
    topic = discord.ui.TextInput(
        label="Thema",
        placeholder="Worum geht es?",
        max_length=100,
    )
    description = discord.ui.TextInput(
        label="Beschreibung",
        style=discord.TextStyle.paragraph,
        max_length=1500,
    )

    async def on_submit(self, interaction: discord.Interaction):
        embed = discord.Embed(
            title=f"🎫 Allgemein – {self.topic.value}",
            description=self.description.value,
            color=EMBED_COLOR,
            timestamp=datetime.now(timezone.utc),
        )
        embed.set_footer(text=f"Erstellt von {interaction.user}")
        await create_ticket(interaction, "allgemein", "ticket", embed)


class TicketPanelView(discord.ui.View):
    def __init__(self):
        super().__init__(timeout=None)

    @discord.ui.button(
        label="Clan bewerben",
        emoji="⚔️",
        style=discord.ButtonStyle.success,
        custom_id="duel:ticket:bewerbung",
    )
    async def apply(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_modal(ApplicationModal())

    @discord.ui.button(
        label="Allgemein",
        emoji="🎫",
        style=discord.ButtonStyle.primary,
        custom_id="duel:ticket:allgemein",
    )
    async def general(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_modal(GeneralModal())


class TicketControlView(discord.ui.View):
    def __init__(self):
        super().__init__(timeout=None)

    @discord.ui.button(
        label="Ticket schließen",
        emoji="🔒",
        style=discord.ButtonStyle.danger,
        custom_id="duel:ticket:close",
    )
    async def close(self, interaction: discord.Interaction, button: discord.ui.Button):
        channel = interaction.channel
        topic = channel.topic or ""
        owner_id = None
        if topic.startswith("ticket:"):
            try:
                owner_id = int(topic.split(":")[1])
            except (IndexError, ValueError):
                pass

        if not (is_staff(interaction.user) or interaction.user.id == owner_id):
            await interaction.response.send_message(
                "Nur Staff oder der Ticket-Ersteller kann das Ticket schließen.",
                ephemeral=True,
            )
            return

        await interaction.response.send_message(
            "🔒 Ticket wird in 5 Sekunden geschlossen …"
        )

        # Transkript erstellen
        lines = []
        async for msg in channel.history(limit=None, oldest_first=True):
            ts = msg.created_at.strftime("%Y-%m-%d %H:%M:%S")
            content = msg.content or ""
            if msg.embeds:
                content += " [Embed]"
            if msg.attachments:
                content += " " + " ".join(a.url for a in msg.attachments)
            lines.append(f"[{ts}] {msg.author}: {content}")
        transcript = "\n".join(lines) or "(leer)"

        file = discord.File(
            io.BytesIO(transcript.encode("utf-8")),
            filename=f"transcript-{channel.name}.txt",
        )
        await send_log(
            interaction.guild,
            content=f"🔒 Ticket **{channel.name}** geschlossen von {interaction.user.mention}",
            file=file,
        )

        await asyncio.sleep(5)
        try:
            await channel.delete(reason=f"Ticket geschlossen von {interaction.user}")
        except discord.HTTPException:
            pass


# ============================================================
# VERIFIZIERUNG
# ============================================================
class VerifyModal(discord.ui.Modal, title="Verifizierung"):
    mc_name = discord.ui.TextInput(
        label="Dein Minecraft-Name",
        placeholder="Exakt wie ingame, z. B. Steve",
        min_length=3,
        max_length=16,
    )

    async def on_submit(self, interaction: discord.Interaction):
        name = self.mc_name.value.strip()
        member = interaction.user
        guild = interaction.guild

        if not MC_NAME_REGEX.match(name):
            await interaction.response.send_message(
                "❌ Ungültiger Minecraft-Name. Erlaubt sind 3–16 Zeichen: "
                "Buchstaben, Zahlen und Unterstrich.",
                ephemeral=True,
            )
            return

        verified = load_verified()
        for uid, existing in verified.items():
            if existing.lower() == name.lower() and uid != str(member.id):
                await interaction.response.send_message(
                    "❌ Dieser Minecraft-Name wurde bereits von jemand anderem verifiziert. "
                    "Öffne ein Ticket, falls das ein Fehler ist.",
                    ephemeral=True,
                )
                return

        await interaction.response.defer(ephemeral=True)

        problems = []

        # Umbenennen
        try:
            await member.edit(nick=name, reason="Verifizierung (Minecraft-Name)")
        except discord.Forbidden:
            problems.append(
                "Ich konnte dich nicht umbenennen (meine Rolle muss über deiner stehen; "
                "der Server-Owner kann nicht umbenannt werden)."
            )
        except discord.HTTPException:
            problems.append("Beim Umbenennen ist ein Fehler aufgetreten.")

        # Rolle vergeben
        verified_role_id = get_cfg(guild.id, "verified_role")
        if verified_role_id:
            role = guild.get_role(verified_role_id)
            if role:
                try:
                    await member.add_roles(role, reason="Verifizierung")
                except discord.Forbidden:
                    problems.append(
                        "Ich konnte dir die Verifiziert-Rolle nicht geben "
                        "(Rolle liegt über meiner)."
                    )

        verified[str(member.id)] = name
        save_verified(verified)

        if problems:
            await interaction.followup.send(
                "⚠️ Teilweise verifiziert:\n- " + "\n- ".join(problems), ephemeral=True
            )
        else:
            await interaction.followup.send(
                f"✅ Du wurdest verifiziert und in **{name}** umbenannt. Willkommen bei {CLAN_NAME}!",
                ephemeral=True,
            )

        await send_log(
            guild,
            content=f"✅ {member.mention} hat sich als **{name}** verifiziert.",
        )


class VerifyPanelView(discord.ui.View):
    def __init__(self):
        super().__init__(timeout=None)

    @discord.ui.button(
        label="Verifizieren",
        emoji="✅",
        style=discord.ButtonStyle.success,
        custom_id="duel:verify",
    )
    async def verify(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_modal(VerifyModal())


# ============================================================
# BOT
# ============================================================
class DuelBot(commands.Bot):
    def __init__(self):
        intents = discord.Intents.default()
        super().__init__(command_prefix="!", intents=intents)

    async def setup_hook(self):
        # Persistente Views, damit Buttons nach Neustart weiter funktionieren
        self.add_view(TicketPanelView())
        self.add_view(TicketControlView())
        self.add_view(VerifyPanelView())
        await self.tree.sync()

    async def on_ready(self):
        print(f"Eingeloggt als {self.user} (ID: {self.user.id})")


bot = DuelBot()


@bot.tree.command(
    name="setup",
    description="Bot einstellen (ohne Angaben: aktuelle Einstellungen anzeigen)",
)
@app_commands.describe(
    ticket_kategorie="Kategorie, in der Tickets erstellt werden",
    staff_rolle="Rolle, die Tickets sehen und schließen darf",
    verifiziert_rolle="Rolle, die nach der Verifizierung vergeben wird",
    log_kanal="Kanal für Transkripte und Verifizierungs-Logs",
)
@app_commands.default_permissions(administrator=True)
@app_commands.guild_only()
async def setup_cmd(
    interaction: discord.Interaction,
    ticket_kategorie: discord.CategoryChannel | None = None,
    staff_rolle: discord.Role | None = None,
    verifiziert_rolle: discord.Role | None = None,
    log_kanal: discord.TextChannel | None = None,
):
    gid = interaction.guild.id
    if ticket_kategorie:
        set_cfg(gid, "ticket_category", ticket_kategorie.id)
    if staff_rolle:
        set_cfg(gid, "staff_role", staff_rolle.id)
    if verifiziert_rolle:
        set_cfg(gid, "verified_role", verifiziert_rolle.id)
    if log_kanal:
        set_cfg(gid, "log_channel", log_kanal.id)

    cat = interaction.guild.get_channel(get_cfg(gid, "ticket_category"))
    staff = interaction.guild.get_role(get_cfg(gid, "staff_role"))
    ver = interaction.guild.get_role(get_cfg(gid, "verified_role"))
    log = interaction.guild.get_channel(get_cfg(gid, "log_channel"))

    embed = discord.Embed(title="⚙️ Einstellungen", color=EMBED_COLOR)
    embed.add_field(name="Ticket-Kategorie", value=cat.name if cat else "❌ nicht gesetzt", inline=False)
    embed.add_field(name="Staff-Rolle", value=staff.mention if staff else "❌ nicht gesetzt", inline=False)
    embed.add_field(name="Verifiziert-Rolle", value=ver.mention if ver else "❌ nicht gesetzt", inline=False)
    embed.add_field(name="Log-Kanal", value=log.mention if log else "❌ nicht gesetzt", inline=False)
    await interaction.response.send_message(embed=embed, ephemeral=True)


@bot.tree.command(name="ticket_panel", description="Sendet das Ticket-Panel in diesen Kanal")
@app_commands.default_permissions(administrator=True)
@app_commands.guild_only()
async def ticket_panel(interaction: discord.Interaction):
    embed = discord.Embed(
        title=f"🎫 {CLAN_NAME} – Tickets",
        description=(
            f"Du möchtest dem **{CLAN_NAME}** auf **{SERVER_NAME}** beitreten "
            "oder hast eine Frage?\n\n"
            "⚔️ **Clan bewerben** – Bewirb dich bei uns.\n"
            "🎫 **Allgemein** – Fragen, Probleme oder sonstige Anliegen."
        ),
        color=EMBED_COLOR,
    )
    await interaction.channel.send(embed=embed, view=TicketPanelView())
    await interaction.response.send_message("Ticket-Panel gesendet.", ephemeral=True)


@bot.tree.command(name="verify_panel", description="Sendet das Verifizier-Panel in diesen Kanal")
@app_commands.default_permissions(administrator=True)
@app_commands.guild_only()
async def verify_panel(interaction: discord.Interaction):
    embed = discord.Embed(
        title=f"✅ Verifizierung – {CLAN_NAME}",
        description=(
            "Klicke auf den Button und gib deinen **Minecraft-Namen** ein.\n"
            "Du wirst danach automatisch auf diesen Namen umbenannt "
            "und bekommst Zugriff auf den Server."
        ),
        color=EMBED_COLOR,
    )
    await interaction.channel.send(embed=embed, view=VerifyPanelView())
    await interaction.response.send_message("Verifizier-Panel gesendet.", ephemeral=True)


if __name__ == "__main__":
    if not TOKEN:
        raise SystemExit("DISCORD_TOKEN ist nicht gesetzt.")
    bot.run(TOKEN)
