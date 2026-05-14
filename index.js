require('dotenv').config();
const { 
    Client, 
    GatewayIntentBits, 
    EmbedBuilder, 
    REST, 
    Routes, 
    SlashCommandBuilder, 
    PermissionFlagsBits,
    Events,
    ActionRowBuilder, 
    StringSelectMenuBuilder,
    ChannelSelectMenuBuilder,
    ChannelType,
    GuildScheduledEventPrivacyLevel,
    GuildScheduledEventEntityType,
    ActivityType,
    Partials,
    AttachmentBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    MessageFlags 
} = require('discord.js');
const axios = require('axios');
const http = require('http');
const fs = require('fs');
const path = require('path');

const { initializeApp } = require('firebase/app');
const { initializeFirestore, doc, getDoc, setDoc, collection, getDocs, deleteDoc, query } = require('firebase/firestore');
const { getAuth, signInAnonymously } = require('firebase/auth');

const firebaseConfig = {
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN,
    projectId: process.env.FIREBASE_PROJECT_ID,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.FIREBASE_APP_ID
};

const app = initializeApp(firebaseConfig);
const db = initializeFirestore(app, { experimentalForceLongPolling: true });
const auth = getAuth(app);
const appId = 'raider-companion';
const OWNER_ID = '444211741774184458';

const requiredEnvVars = ['FIREBASE_API_KEY', 'FIREBASE_AUTH_DOMAIN', 'FIREBASE_PROJECT_ID', 'DISCORD_TOKEN', 'CLIENT_ID'];
const missingVars = requiredEnvVars.filter(v => !process.env[v]);
if (missingVars.length > 0) {
    console.error('❌ Missing Environment Variables:', missingVars);
    process.exit(1);
}

const PORT = process.env.PORT || 8000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is running\n');
}).listen(PORT);

const TOKEN = process.env.DISCORD_TOKEN.trim();
const CLIENT_ID = process.env.CLIENT_ID.trim();
const API_URL = 'https://metaforge.app/api/arc-raiders/events-schedule';
const ARCS_API_URL = 'https://metaforge.app/api/arc-raiders/arcs';
const ITEMS_API_URL = 'https://metaforge.app/api/arc-raiders/items?limit=1000';
const TRADERS_API_URL = 'https://metaforge.app/api/arc-raiders/traders';
const QUESTS_API_URL = 'https://metaforge.app/api/arc-raiders/quests';
const CHECK_INTERVAL = 60000;

let guildConfigs = new Map();
let activeGuildUpdates = new Set(); 
let arcCache = [], itemCache = [], traderCache = {}, traderItemsFlat = [], traderCategories = [], questCache = [];
let isAuthorized = false, isGlobalUpdating = false;

const mapConfigs = {
    'Dam': { color: 0x3498db, fileName: 'dam_battlegrounds.png' },
    'Buried City': { color: 0xe67e22, fileName: 'buried_city.png' },
    'Blue Gate': { color: 0x9b59b6, fileName: 'blue_gate.png' },
    'Spaceport': { color: 0x2ecc71, fileName: 'spaceport.png' },
    'Stella Montis': { color: 0xf1c40f, fileName: 'stella_montis.png' }
};

const rarityColors = { 'Common': 0x95a5a6, 'Uncommon': 0x2ecc71, 'Rare': 0x3498db, 'Epic': 0x9b59b6, 'Legendary': 0xf1c40f };
const eventEmojis = { 'Night Raid': '🌙', 'Prospecting Probes': '📡', 'Matriarch': '👑', 'Bird City': '🐦', 'Hidden Bunker': '🏢', 'Cold Snap': '❄️', 'Harvester': '🚜', 'Electromagnetic Storm': '⚡', 'Lush Blooms': '🌸', 'Locked Gate': '🔒', 'Launch Tower Loot': '🚀', 'Uncovered Caches': '📦' };

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildScheduledEvents, GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.GuildMembers, GatewayIntentBits.DirectMessages, GatewayIntentBits.GuildPresences
    ],
    partials: [Partials.Message, Partials.Reaction, Partials.User, Partials.Channel]
});

async function ensureAuth() {
    if (isAuthorized) return true;
    try { await signInAnonymously(auth); isAuthorized = true; return true; } 
    catch (e) { console.error("❌ Auth Failed:", e.message); return false; }
}

async function loadAllConfigs() {
    if (!await ensureAuth()) return;
    try {
        const colRef = collection(db, 'artifacts', appId, 'public', 'data', 'bot_configs');
        const snap = await getDocs(colRef);
        snap.forEach((d) => {
            if (d.id.startsWith(CLIENT_ID)) {
                const guildId = d.id.replace(`${CLIENT_ID}_`, '');
                guildConfigs.set(guildId, d.data());
            }
        });
    } catch (e) { console.error("❌ Load Configs Error:", e.message); }
}

async function refreshCaches() {
    try {
        const [arcRes, itemRes, traderRes, questRes] = await Promise.all([
            axios.get(ARCS_API_URL), axios.get(ITEMS_API_URL), axios.get(TRADERS_API_URL), axios.get(QUESTS_API_URL)
        ]);
        arcCache = arcRes.data?.data || [];
        itemCache = itemRes.data?.data || [];
        traderCache = traderRes.data?.data || {};
        questCache = questRes.data?.data || [];
        traderItemsFlat = [];
        const cats = new Set();
        for (const [name, items] of Object.entries(traderCache)) {
            items.forEach(it => { traderItemsFlat.push({ ...it, traderName: name }); if (it.item_type) cats.add(it.item_type); });
        }
        traderCategories = Array.from(cats);
        console.log(`[Cache] Success: Loaded ${arcCache.length} ARCs, ${itemCache.length} Items.`);
    } catch (e) { console.error("❌ Cache Refresh Error:", e.message); }
}

async function updateEvents(targetGuildId = null) {
    if (!targetGuildId && isGlobalUpdating) return;
    if (!targetGuildId) isGlobalUpdating = true;

    try {
        const res = await axios.get(API_URL);
        const events = res.data?.data;
        if (!events || !Array.isArray(events)) return;

        const now = Date.now();
        const guildsToUpdate = targetGuildId ? [[targetGuildId, guildConfigs.get(targetGuildId)]] : Array.from(guildConfigs.entries());

        for (const [guildId, config] of guildsToUpdate) {
            if (!config?.channelId || activeGuildUpdates.has(guildId)) continue;
            activeGuildUpdates.add(guildId);
            try {
                const channel = await client.channels.fetch(config.channelId).catch(() => null);
                if (!channel) continue;

                for (const [mapName, mapSet] of Object.entries(mapConfigs)) {
                    const mapEvents = events.filter(e => e.map?.toLowerCase().replace(/\s/g, '') === mapName.toLowerCase().replace(/\s/g, ''));
                    const live = mapEvents.filter(e => e.startTime <= now && e.endTime > now);
                    const next = mapEvents.filter(e => e.startTime > now).sort((a,b) => a.startTime - b.startTime).slice(0, 3);
                    
                    const embed = new EmbedBuilder().setTitle(`📍 ${mapName}`).setColor(mapSet.color).setTimestamp();
                    embed.addFields({ name: '📡 Status', value: live.length > 0 ? `🟢 **LIVE:** ${live[0].name}` : '⚪ Offline' });
                    next.forEach((e, i) => embed.addFields({ name: `Next Up #${i+1}`, value: `**${e.name}**\n<t:${Math.floor(e.startTime/1000)}:R>`, inline: true }));
                    
                    if (config.messageIds?.[mapName]) {
                        const msg = await channel.messages.fetch(config.messageIds[mapName]).catch(() => null);
                        if (msg) await msg.edit({ embeds: [embed] });
                        else { const s = await channel.send({ embeds: [embed] }); config.messageIds[mapName] = s.id; }
                    } else {
                        const s = await channel.send({ embeds: [embed] });
                        if (!config.messageIds) config.messageIds = {};
                        config.messageIds[mapName] = s.id;
                    }
                }
            } finally { activeGuildUpdates.delete(guildId); }
        }
    } catch (e) { console.error('Loop error:', e.message); } finally { if (!targetGuildId) isGlobalUpdating = false; }
}

client.on('interactionCreate', async interaction => {
    try {
        if (interaction.isAutocomplete()) {
            const f = interaction.options.getFocused().toLowerCase();
            if (interaction.commandName === 'arc') await interaction.respond(arcCache.filter(a => a.name.toLowerCase().includes(f)).slice(0, 25).map(a => ({ name: a.name, value: a.id })));
            if (interaction.commandName === 'item') await interaction.respond(itemCache.filter(i => i.name.toLowerCase().includes(f)).slice(0, 25).map(i => ({ name: i.name, value: i.id })));
            return;
        }

        if (!interaction.isChatInputCommand()) return;

        /* FIXED: Improved Data Parser for MapData */
        if (interaction.commandName === 'mapdata') {
            if (interaction.user.id !== OWNER_ID) return interaction.reply({ content: '❌ Owner only.', flags: [MessageFlags.Ephemeral] });
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

            const mapID = interaction.options.getString('map');
            try {
                const res = await axios.get(`https://metaforge.app/api/game-map-data?tableID=arc_map_data&mapID=${mapID}`, { timeout: 15000 });
                let data = res.data;

                // Handle string responses if API doesn't send JSON headers
                if (typeof data === 'string') {
                    try { 
                        const parsed = JSON.parse(data); 
                        data = parsed.data || (Array.isArray(parsed) ? parsed : data);
                    } catch(e) { console.error("[mapdata] String parse failed."); }
                } else if (data?.data) {
                    data = data.data;
                }

                if (!data || (Array.isArray(data) && data.length === 0)) {
                    return interaction.editReply(`⚠️ No data found for \`${mapID}\`.`);
                }

                const sample = Array.isArray(data) ? data[0] : data;
                const keys = Object.keys(sample);
                const schemaEmbed = new EmbedBuilder()
                    .setTitle(`🗺️ Map Data: ${mapID}`)
                    .setColor(0x5865F2)
                    .setDescription(`**Total records:** ${Array.isArray(data) ? data.length : 1}\n**Keys:** \`${keys.join(', ')}\``)
                    .setTimestamp();
                
                const sampleRecords = (Array.isArray(data) ? data.slice(0, 2) : [data]);
                sampleRecords.forEach((record, i) => {
                    const lines = keys.slice(0, 10).map(k => `${k}: ${String(record[k]).substring(0, 45)}`).join('\n');
                    schemaEmbed.addFields({ name: `📄 Sample #${i + 1}`, value: `\`\`\`\n${lines}\`\`\`` });
                });

                const attachment = new AttachmentBuilder(Buffer.from(JSON.stringify(data, null, 2)), { name: `mapdata_${mapID}.json` });
                await interaction.editReply({ embeds: [schemaEmbed], files: [attachment] });
            } catch (err) { 
                console.error(`[mapdata] Error: ${err.message}`);
                await interaction.editReply(`❌ API error: \`${err.message}\``); 
            }
        }

        /* FIXED: Added immediate defer to prevent "Application did not respond" */
        if (interaction.commandName === 'servers') {
            if (interaction.user.id !== OWNER_ID) return interaction.reply({ content: "❌ Unauthorized.", flags: [MessageFlags.Ephemeral] });
            
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            
            const guilds = client.guilds.cache.map(g => ({ label: g.name.substring(0, 25), value: g.id }));
            if (guilds.length === 0) return interaction.editReply("❌ No servers found.");

            const row = new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId('server_mgmt_select')
                    .setPlaceholder('Select a server to manage...')
                    .addOptions(guilds.slice(0, 25))
            );

            await interaction.editReply({ 
                content: "👤 **Server Management Console**", 
                components: [row] 
            });
        }

        if (interaction.commandName === 'setup') {
            const cfg = guildConfigs.get(interaction.guildId) || { channelId: null };
            const embed = new EmbedBuilder().setTitle('⚙️ Bot Setup').setDescription(`Tactical Channel: ${cfg.channelId ? `<#${cfg.channelId}>` : "Not set"}`);
            const row = new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('setup_channel_select').addChannelTypes(ChannelType.GuildText));
            await interaction.reply({ embeds: [embed], components: [row], flags: [MessageFlags.Ephemeral] });
        }
    } catch (err) { console.error('Interaction error:', err.message); }
});

// CRITICAL: Every command AND every option must have a .setDescription() call.
const commandsData = [
    new SlashCommandBuilder()
        .setName('setup')
        .setDescription('Configure the tactical channel for rotation updates')
        .toJSON(),
    new SlashCommandBuilder()
        .setName('mapdata')
        .setDescription('Owner Only: Inspect raw map marker data from the API')
        .addStringOption(option => 
            option.setName('map')
                .setDescription('The internal ID of the map to query')
                .setRequired(true)
                .addChoices(
                    { name: 'Dam', value: 'dam' },
                    { name: 'Blue Gate', value: 'blue-gate' },
                    { name: 'Spaceport', value: 'spaceport' },
                    { name: 'Buried City', value: 'buried-city' }
                )
        )
        .toJSON(),
    new SlashCommandBuilder()
        .setName('servers')
        .setDescription('Owner Only: List and manage servers the bot is currently in')
        .toJSON(),
    new SlashCommandBuilder()
        .setName('arc')
        .setDescription('Retrieve tactical intel on specific ARC units')
        .addStringOption(option => 
            option.setName('unit')
                .setDescription('The name of the ARC unit to research')
                .setRequired(true)
                .setAutocomplete(true)
        )
        .toJSON(),
    new SlashCommandBuilder()
        .setName('item')
        .setDescription('Search the database for item stats and locations')
        .addStringOption(option => 
            option.setName('name')
                .setDescription('The name of the item to search for')
                .setRequired(true)
                .setAutocomplete(true)
        )
        .toJSON()
];

client.once(Events.ClientReady, async () => {
    console.log(`[Ready] Logged in as ${client.user.tag}`);
    await ensureAuth();
    await loadAllConfigs();
    await refreshCaches();

    const rest = new REST({ version: '10' }).setToken(TOKEN);
    try {
        // REGISTER GLOBALLY ONLY (Prevents double-command entries)
        console.log('[Ready] Pushing slash commands to Global Registry...');
        await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commandsData });
        console.log('[Ready] Commands registered successfully.');
    } catch (e) { 
        console.error('[Ready] Command Registry Error:', e); 
    }

    setInterval(updateEvents, CHECK_INTERVAL);
});

client.login(TOKEN);
