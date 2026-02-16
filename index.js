require('dotenv').config();
const { 
    Client, 
    GatewayIntentBits, 
    EmbedBuilder, 
    REST, 
    Routes, 
    SlashCommandBuilder, 
    PermissionFlagsBits 
} = require('discord.js');
const axios = require('axios');
const http = require('http');
const admin = require('firebase-admin');

// --- FIREBASE ADMIN SETUP ---
if (!admin.apps.length) {
    admin.initializeApp({
        projectId: "raider-companion",
    });
}
const db = admin.firestore();
const appId = 'raider-companion';

// --- KOYEB HEALTH CHECK SERVER ---
const PORT = process.env.PORT || 8000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is running\n');
}).listen(PORT, () => console.log(`Health check server listening on port ${PORT}`));

// --- CONFIGURATION ---
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const API_URL = 'https://metaforge.app/api/arc-raiders/events-schedule';
const ARCS_API_URL = 'https://metaforge.app/api/arc-raiders/arcs';
const CHECK_INTERVAL = 60000;

let config = {
    channelId: null,
    messageIds: {
        'Dam': null,
        'Buried City': null,
        'Blue Gate': null,
        'Spaceport': null,
        'Stella Montis': null,
        'Summary': null
    }
};

const mapConfigs = {
    'Dam': { color: 0x3498db, image: 'https://media.discordapp.net/attachments/1397641556009156658/1472985276753121413/l547kr11ki1g1.png' },
    'Buried City': { color: 0xe67e22, image: 'https://media.discordapp.net/attachments/1397641556009156658/1472985571034140704/Buried_City.png' },
    'Blue Gate': { color: 0x9b59b6, image: 'https://cdn.discordapp.com/attachments/1397641556009156658/1472984992203149449/1200px-Blue_Gate.png.png' },
    'Spaceport': { color: 0x2ecc71, image: 'https://media.discordapp.net/attachments/1397641556009156658/1472985777280647319/Spaceport.png' },
    'Stella Montis': { color: 0xf1c40f, image: 'https://cdn.discordapp.com/attachments/1077242377099550863/1472982493719298281/ARC-Raiders-Stella-Montis-map-guide.png' }
};

const eventEmojis = {
    'Night Raid': '🌙', 'Prospecting Probes': '📡', 'Matriarch': '👑', 'Bird City': '🐦',
    'Hidden Bunker': '🏢', 'Cold Snap': '❄️', 'Harvester': '🚜', 'Electromagnetic Storm': '⚡',
    'Lush Blooms': '🌸', 'Locked Gate': '🔒', 'Launch Tower Loot': '🚀', 'Uncovered Caches': '📦'
};

const getEmoji = (name) => eventEmojis[name] || '🛸';

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

// Cache for Arc data to power autocomplete and commands
let arcCache = [];

// --- PERSISTENCE HELPERS ---
async function saveConfig() {
    try {
        const docRef = db.collection('artifacts').doc(appId).collection('public').doc('config');
        await docRef.set(config);
    } catch (e) { console.error("Error saving config:", e); }
}

async function loadConfig() {
    try {
        const docRef = db.collection('artifacts').doc(appId).collection('public').doc('config');
        const docSnap = await docRef.get();
        if (docSnap.exists) {
            config = docSnap.data();
        }
    } catch (e) { console.error("Error loading config:", e); }
}

// Fetch and cache Arc definitions
async function refreshArcCache() {
    try {
        const response = await axios.get(ARCS_API_URL);
        arcCache = response.data?.data || [];
        console.log(`Cached ${arcCache.length} ARCs.`);
    } catch (e) { console.error("Error fetching Arcs:", e.message); }
}

// --- BOT LOGIC ---
async function updateEvents(forceNewMessages = false) {
    if (!config.channelId) return;

    try {
        const response = await axios.get(API_URL);
        const events = response.data?.data;
        if (!events || !Array.isArray(events)) return;

        const now = Date.now();
        const channel = await client.channels.fetch(config.channelId);
        if (!channel) return;

        if (forceNewMessages) {
            for (const key in config.messageIds) {
                if (config.messageIds[key]) {
                    try {
                        const m = await channel.messages.fetch(config.messageIds[key]);
                        await m.delete();
                    } catch (e) {}
                    config.messageIds[key] = null;
                }
            }
        }

        for (const [mapName, mapSet] of Object.entries(mapConfigs)) {
            const mapEvents = events.filter(e => e.map?.toLowerCase().replace(/\s/g, '') === mapName.toLowerCase().replace(/\s/g, ''));
            const activeEvent = mapEvents.find(e => e.startTime <= now && e.endTime > now);
            const upcoming = mapEvents.filter(e => e.startTime > now).sort((a, b) => a.startTime - b.startTime).slice(0, 3);

            const embed = new EmbedBuilder()
                .setTitle(`📍 ${mapName}`)
                .setColor(mapSet.color)
                .setImage(mapSet.image)
                .setTimestamp()
                .setFooter({ text: `Last update` });

            if (activeEvent) {
                embed.addFields({ name: '📡 Status', value: `🟢 **LIVE:** ${getEmoji(activeEvent.name)} **${activeEvent.name}**\nEnds <t:${Math.floor(activeEvent.endTime / 1000)}:R>` });
                if (activeEvent.icon) embed.setThumbnail(activeEvent.icon);
            } else {
                embed.addFields({ name: '📡 Status', value: '⚪ **Offline**' });
            }

            upcoming.forEach((e, i) => {
                embed.addFields({ name: `Next Up #${i + 1}`, value: `${getEmoji(e.name)} **${e.name}**\n<t:${Math.floor(e.startTime / 1000)}:R>`, inline: true });
            });

            await syncMessage(channel, mapName, embed);
        }

        const current = events.filter(e => e.startTime <= now && e.endTime > now);
        const summary = new EmbedBuilder()
            .setTitle('🛸 ARC Raiders - Live Summary')
            .setColor(0x00AE86)
            .setTimestamp();

        if (current.length > 0) {
            summary.addFields({ name: '✅ Currently Active', value: current.map(e => `${getEmoji(e.name)} **${e.name}**\n└ *${e.map}*\n────────────────`).join('\n') });
        } else {
            summary.addFields({ name: '✅ Currently Active', value: 'No events currently active.' });
        }

        await syncMessage(channel, 'Summary', summary);
        await saveConfig();

    } catch (error) { console.error('Update loop error:', error.message); }
}

async function syncMessage(channel, key, embed) {
    if (config.messageIds[key]) {
        try {
            const msg = await channel.messages.fetch(config.messageIds[key]);
            await msg.edit({ embeds: [embed] });
        } catch (e) {
            const sent = await channel.send({ embeds: [embed] });
            config.messageIds[key] = sent.id;
        }
    } else {
        const sent = await channel.send({ embeds: [embed] });
        config.messageIds[key] = sent.id;
    }
}

// --- COMMAND DATA ---
const commandsData = [
    new SlashCommandBuilder()
        .setName('setup')
        .setDescription('Set the channel for live event updates')
        .addChannelOption(option => 
            option.setName('channel')
                .setDescription('The channel to post in')
                .setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .toJSON(),
    new SlashCommandBuilder()
        .setName('arc')
        .setDescription('Get detailed intelligence on a specific ARC unit')
        .addStringOption(option =>
            option.setName('unit')
                .setDescription('Pick an ARC unit')
                .setRequired(true)
                .setAutocomplete(true))
        .toJSON()
];

client.on('interactionCreate', async interaction => {
    // Handle Autocomplete for /arc
    if (interaction.isAutocomplete()) {
        if (interaction.commandName === 'arc') {
            const focusedValue = interaction.options.getFocused().toLowerCase();
            const choices = arcCache.filter(arc => arc.name.toLowerCase().includes(focusedValue));
            await interaction.respond(
                choices.slice(0, 25).map(arc => ({ name: arc.name, value: arc.id }))
            );
        }
        return;
    }

    if (!interaction.isChatInputCommand()) return;
    
    if (interaction.commandName === 'setup') {
        const targetChannel = interaction.options.getChannel('channel');
        config.channelId = targetChannel.id;
        for (let key in config.messageIds) config.messageIds[key] = null;
        
        await interaction.reply({ content: `✅ Events will now be posted and kept current in ${targetChannel}.`, ephemeral: true });
        updateEvents();
    }

    if (interaction.commandName === 'arc') {
        const arcId = interaction.options.getString('unit');
        const arc = arcCache.find(a => a.id === arcId);

        if (!arc) {
            return interaction.reply({ content: "❌ Unit intelligence not found. Please pick a valid unit from the list.", ephemeral: true });
        }

        const embed = new EmbedBuilder()
            .setTitle(`🤖 Intelligence: ${arc.name}`)
            .setDescription(arc.description)
            .setColor(0x5865F2)
            .setThumbnail(arc.icon)
            .setImage(arc.image)
            .setTimestamp()
            .setFooter({ text: 'ARC Intelligence Database' });

        await interaction.reply({ embeds: [embed] });
    }
});

client.on('messageCreate', async message => {
    if (message.author.bot) return;
    if (message.channel.id === config.channelId) {
        updateEvents(true);
    }
});

client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    await loadConfig();
    await refreshArcCache();
    
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    try {
        const guilds = client.guilds.cache;
        for (const [guildId, guild] of guilds) {
            try {
                await rest.put(
                    Routes.applicationGuildCommands(CLIENT_ID, guildId),
                    { body: commandsData }
                );
            } catch (err) { console.error(`Guild refresh fail for ${guildId}:`, err.message); }
        }
        
        await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commandsData });
        console.log('Slash commands refreshed everywhere.');

    } catch (e) { console.error('Command registration fail:', e); }

    updateEvents();
    setInterval(updateEvents, CHECK_INTERVAL);
});

client.login(TOKEN);
