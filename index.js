require('dotenv').config();
const { 
    Client, 
    GatewayIntentBits, 
    EmbedBuilder, 
    REST, 
    Routes, 
    SlashCommandBuilder, 
    PermissionFlagsBits,
    Events 
} = require('discord.js');
const axios = require('axios');
const http = require('http');

// --- FIREBASE WEB SDK SETUP ---
const { initializeApp } = require('firebase/app');
const { getFirestore, doc, getDoc, setDoc } = require('firebase/firestore');
const { getAuth, signInAnonymously } = require('firebase/auth');

const firebaseConfig = {
    apiKey: "AIzaSyDFwBoTXmTxhh3lbDmVLlE7FIgw2syS0fQ",
    authDomain: "raider-companion.firebaseapp.com",
    projectId: "raider-companion",
    storageBucket: "raider-companion.firebasestorage.app",
    messagingSenderId: "1090143955392",
    appId: "1:1090143955392:web:37d509027eb7833e3d8025"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
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
const ITEMS_API_URL = 'https://metaforge.app/api/arc-raiders/items?limit=1000';
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

const rarityColors = {
    'Common': 0x95a5a6,
    'Uncommon': 0x2ecc71,
    'Rare': 0x3498db,
    'Epic': 0x9b59b6,
    'Legendary': 0xf1c40f
};

const eventEmojis = {
    'Night Raid': '🌙', 'Prospecting Probes': '📡', 'Matriarch': '👑', 'Bird City': '🐦',
    'Hidden Bunker': '🏢', 'Cold Snap': '❄️', 'Harvester': '🚜', 'Electromagnetic Storm': '⚡',
    'Lush Blooms': '🌸', 'Locked Gate': '🔒', 'Launch Tower Loot': '🚀', 'Uncovered Caches': '📦'
};

const getEmoji = (name) => eventEmojis[name] || '🛸';

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

let arcCache = [];
let itemCache = [];
let lastAlertedEventTime = null;
let isAuthorized = false;

// --- PERSISTENCE HELPERS ---
async function ensureAuth() {
    if (isAuthorized) return true;
    try {
        await signInAnonymously(auth);
        isAuthorized = true;
        return true;
    } catch (e) {
        console.error("Firebase Auth Failed:", e.message);
        return false;
    }
}

async function saveConfig() {
    if (!await ensureAuth()) return;
    try {
        // FIXED: Added 'bot' collection segment to ensure an even number of path segments (6 total)
        const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'bot', 'config');
        await setDoc(docRef, config);
    } catch (e) { console.error("Error saving config:", e.message); }
}

async function loadConfig() {
    if (!await ensureAuth()) return;
    try {
        // FIXED: Added 'bot' collection segment to ensure an even number of path segments (6 total)
        const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'bot', 'config');
        const docSnap = await getDoc(docRef);
        if (docSnap.exists()) {
            config = docSnap.data();
        }
    } catch (e) { console.error("Error loading config:", e.message); }
}

async function refreshCaches() {
    try {
        const arcRes = await axios.get(ARCS_API_URL);
        arcCache = arcRes.data?.data || [];
        
        const itemRes = await axios.get(ITEMS_API_URL);
        itemCache = itemRes.data?.data || [];
        
        console.log(`Caches Refreshed: ${arcCache.length} ARCs, ${itemCache.length} Items.`);
    } catch (e) { console.error("Error refreshing caches:", e.message); }
}

async function getOrCreateEventRole(guild, eventName) {
    let role = guild.roles.cache.find(r => r.name === eventName);
    if (!role) {
        try {
            role = await guild.roles.create({
                name: eventName,
                reason: 'Auto-created for ARC Raiders rotation alerts',
                mentionable: true
            });
        } catch (e) {
            return `**${eventName}**`;
        }
    }
    return `<@&${role.id}>`;
}

// --- BOT LOGIC ---
async function updateEvents(forceNewMessages = false) {
    if (!config.channelId) return;

    try {
        const response = await axios.get(API_URL);
        const events = response.data?.data;
        if (!events || !Array.isArray(events)) return;

        const now = Date.now();
        const fifteenMinsFromNow = now + (15 * 60 * 1000);
        
        const channel = await client.channels.fetch(config.channelId);
        if (!channel) return;

        const guild = channel.guild;

        const overallNext = events
            .filter(e => e.startTime > now)
            .sort((a, b) => a.startTime - b.startTime)[0];

        if (overallNext && overallNext.startTime <= fifteenMinsFromNow) {
            if (lastAlertedEventTime !== overallNext.startTime) {
                const roleMention = await getOrCreateEventRole(guild, overallNext.name);
                await channel.send({
                    content: `⚠️ **Upcoming Event:** ${getEmoji(overallNext.name)} ${roleMention} starts <t:${Math.floor(overallNext.startTime / 1000)}:R>!`
                });
                lastAlertedEventTime = overallNext.startTime;
            }
        }

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
        .addChannelOption(option => option.setName('channel').setDescription('The channel to post in').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .toJSON(),
    new SlashCommandBuilder()
        .setName('arc')
        .setDescription('Get intelligence on a specific ARC unit')
        .addStringOption(option => option.setName('unit').setDescription('Pick an ARC unit').setRequired(true).setAutocomplete(true))
        .toJSON(),
    new SlashCommandBuilder()
        .setName('item')
        .setDescription('Lookup an item, weapon, or material')
        .addStringOption(option => option.setName('name').setDescription('Search for an item').setRequired(true).setAutocomplete(true))
        .toJSON()
];

client.on('interactionCreate', async interaction => {
    if (interaction.isAutocomplete()) {
        const focusedValue = interaction.options.getFocused().toLowerCase();
        if (interaction.commandName === 'arc') {
            const choices = arcCache.filter(arc => arc.name.toLowerCase().includes(focusedValue));
            await interaction.respond(choices.slice(0, 25).map(arc => ({ name: arc.name, value: arc.id })));
        }
        if (interaction.commandName === 'item') {
            const choices = itemCache.filter(item => item.name.toLowerCase().includes(focusedValue));
            await interaction.respond(choices.slice(0, 25).map(item => ({ name: item.name, value: item.id })));
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
        const arc = arcCache.find(a => a.id === interaction.options.getString('unit'));
        if (!arc) return interaction.reply({ content: "❌ Intelligence not found.", ephemeral: true });

        const embed = new EmbedBuilder()
            .setTitle(`🤖 Intelligence: ${arc.name}`)
            .setDescription(arc.description)
            .setColor(0x5865F2)
            .setThumbnail(arc.icon)
            .setImage(arc.image)
            .setTimestamp();
        await interaction.reply({ embeds: [embed] });
    }

    if (interaction.commandName === 'item') {
        const item = itemCache.find(i => i.id === interaction.options.getString('name'));
        if (!item) return interaction.reply({ content: "❌ Item not found.", ephemeral: true });

        const embed = new EmbedBuilder()
            .setTitle(`📦 Item: ${item.name}`)
            .setDescription(item.description || 'No description available.')
            .setColor(rarityColors[item.rarity] || 0x5865F2)
            .setThumbnail(item.icon)
            .addFields(
                { name: 'Rarity', value: item.rarity || 'Common', inline: true },
                { name: 'Type', value: item.item_type || 'Unknown', inline: true },
                { name: 'Value', value: `🪙 ${item.value?.toLocaleString() || 0}`, inline: true }
            );

        if (item.workbench) embed.addFields({ name: 'Crafting', value: `🛠️ ${item.workbench}`, inline: true });
        if (item.loot_area) embed.addFields({ name: 'Loot Area', value: `📍 ${item.loot_area}`, inline: true });

        if (item.stat_block) {
            const stats = Object.entries(item.stat_block)
                .filter(([_, v]) => v !== 0 && v !== null && v !== "")
                .map(([k, v]) => `• **${k.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase())}:** ${v}`)
                .join('\n');
            if (stats) embed.addFields({ name: '📊 Statistics', value: stats });
        }

        if (item.flavor_text) embed.setFooter({ text: item.flavor_text });

        await interaction.reply({ embeds: [embed] });
    }
});

client.on('messageCreate', async message => {
    if (message.author.bot || !config.channelId) return;
    if (message.channel.id === config.channelId) updateEvents(true);
});

client.once(Events.ClientReady, async () => {
    console.log(`Logged in as ${client.user.tag}`);
    await loadConfig();
    await refreshCaches();
    
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    try {
        const guilds = client.guilds.cache;
        for (const [guildId, guild] of guilds) {
            try {
                await rest.put(Routes.applicationGuildCommands(CLIENT_ID, guildId), { body: commandsData });
            } catch (err) {}
        }
        await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commandsData });
    } catch (e) {}

    updateEvents();
    setInterval(updateEvents, CHECK_INTERVAL);
});

client.login(TOKEN);
