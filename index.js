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
const notificationTimes = [ { label: '3 Hours', value: '10800000' }, { label: '2 Hours', value: '7200000' }, { label: '1 Hour', value: '3600000' }, { label: '45 Minutes', value: '2700000' }, { label: '30 Minutes', value: '1800000' }, { label: '15 Minutes', value: '900000' } ];

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildScheduledEvents, GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.GuildMembers, GatewayIntentBits.DirectMessages, GatewayIntentBits.GuildPresences
    ],
    partials: [Partials.Message, Partials.Reaction, Partials.User, Partials.Channel]
});

const getEmoji = (name) => eventEmojis[name] || '🛸';

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
                const data = d.data();
                if (!data.alertedEventKeys) data.alertedEventKeys = [];
                if (!data.activeAlerts) data.activeAlerts = [];
                guildConfigs.set(guildId, data);
            }
        });
    } catch (e) { console.error("❌ Load Configs Error:", e.message); }
}

async function saveGuildConfig(guildId) {
    if (!await ensureAuth()) return;
    const config = guildConfigs.get(guildId);
    if (!config) return;
    try { await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'bot_configs', `${CLIENT_ID}_${guildId}`), config); } 
    catch (e) { console.error(`Save Error:`, e.message); }
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
    } catch (e) { console.error("❌ Cache Refresh Error:", e.message); }
}

async function updateEvents(targetGuildId = null, forceNewMessages = false, purgeActivePings = false) {
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
                    
                    const embed = new EmbedBuilder().setTitle(`📍 ${mapName}`).setColor(mapSet.color).setTimestamp().setFooter({ text: 'metaforge.app/arc-raiders' });
                    embed.addFields({ name: '📡 Status', value: live.length > 0 ? `🟢 **LIVE:** ${getEmoji(live[0].name)} ${live[0].name}` : '⚪ Offline' });
                    next.forEach((e, i) => embed.addFields({ name: `Next Up #${i+1}`, value: `${getEmoji(e.name)} **${e.name}**\n<t:${Math.floor(e.startTime/1000)}:R>`, inline: true }));
                    
                    if (config.messageIds?.[mapName]) {
                        const msg = await channel.messages.fetch(config.messageIds[mapName]).catch(() => null);
                        if (msg) await msg.edit({ embeds: [embed] });
                        else { const s = await channel.send({ embeds: [embed] }); if(!config.messageIds) config.messageIds = {}; config.messageIds[mapName] = s.id; }
                    } else {
                        const s = await channel.send({ embeds: [embed] });
                        if (!config.messageIds) config.messageIds = {};
                        config.messageIds[mapName] = s.id;
                    }
                }
                await saveGuildConfig(guildId);
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
            if (interaction.commandName === 'traders') {
                const results = [];
                Object.keys(traderCache).forEach(n => { if (n.toLowerCase().includes(f)) results.push({ name: `👤 ${n}`, value: `trader:${n}` }); });
                traderCategories.forEach(c => { if (c.toLowerCase().includes(f)) results.push({ name: `📁 ${c}`, value: `category:${c}` }); });
                await interaction.respond(results.slice(0, 25));
            }
            return;
        }

        /* FIXED: Added deferReply to Select Menu handler for /servers to prevent timeout */
        if (interaction.isStringSelectMenu() && interaction.customId === 'server_mgmt_select') {
            if (interaction.user.id !== OWNER_ID) return;
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

            const guild = await client.guilds.fetch(interaction.values[0]).catch(() => null);
            if (!guild) return interaction.editReply("❌ Could not fetch server details.");

            const owner = await guild.fetchOwner().catch(() => null);
            const active = guild.members.cache.filter(m => m.presence && m.presence.status !== 'offline').size;
            
            const embed = new EmbedBuilder()
                .setTitle(`🛡️ Server: ${guild.name}`)
                .setThumbnail(guild.iconURL())
                .setColor(0x5865F2)
                .addFields(
                    { name: '👤 Owner', value: `${owner?.user.tag || "Unknown"} (\`${owner?.id || "N/A"}\`)`, inline: true },
                    { name: '🆔 Server ID', value: `\`${guild.id}\``, inline: true },
                    { name: '👥 Members', value: `Total: **${guild.memberCount}**\nActive: **${active}**`, inline: true }
                ).setTimestamp();

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`srv_leave_${guild.id}`).setLabel('Leave').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId(`srv_invite_${guild.id}`).setLabel('Get Invite').setStyle(ButtonStyle.Secondary)
            );

            await interaction.editReply({ embeds: [embed], components: [row] });
            return;
        }

        if (!interaction.isChatInputCommand()) return;

        /* FIXED: Added deferReply for initial /servers command */
        if (interaction.commandName === 'servers') {
            if (interaction.user.id !== OWNER_ID) return interaction.reply({ content: "❌ Unauthorized.", flags: [MessageFlags.Ephemeral] });
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            
            const guilds = client.guilds.cache.map(g => ({ label: g.name.substring(0, 25), value: g.id }));
            if (guilds.length === 0) return interaction.editReply("❌ No servers found.");

            const row = new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder().setCustomId('server_mgmt_select').setPlaceholder('Select a server...').addOptions(guilds.slice(0, 25))
            );
            await interaction.editReply({ content: "👤 **Server Management Console**", components: [row] });
        }

        /* FIXED: Updated mapdata parser to specifically look for "allData" key */
        if (interaction.commandName === 'mapdata') {
            if (interaction.user.id !== OWNER_ID) return interaction.reply({ content: '❌ Owner only.', flags: [MessageFlags.Ephemeral] });
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

            const mapID = interaction.options.getString('map');
            try {
                const res = await axios.get(`https://metaforge.app/api/game-map-data?tableID=arc_map_data&mapID=${mapID}`, { timeout: 15000 });
                let rawData = res.data;
                
                // Handle various response shapes (object with data, allData, or direct array)
                let markers = null;
                if (Array.isArray(rawData)) markers = rawData;
                else if (rawData?.allData) markers = rawData.allData; // MATCHES USER SAMPLE
                else if (rawData?.data) markers = rawData.data;

                if (!markers || !Array.isArray(markers) || markers.length === 0) {
                    return interaction.editReply(`⚠️ No data found for \`${mapID}\`. Structure check failed.`);
                }

                const sample = markers[0];
                const keys = Object.keys(sample);
                const schemaEmbed = new EmbedBuilder()
                    .setTitle(`🗺️ Map Data: ${mapID}`)
                    .setColor(0x5865F2)
                    .setDescription(`**Total records:** ${markers.length}\n**Keys found:** \`${keys.join(', ')}\``)
                    .setTimestamp();
                
                const sampleRecords = markers.slice(0, 2);
                sampleRecords.forEach((record, i) => {
                    const lines = keys.slice(0, 10).map(k => `${k}: ${String(record[k]).substring(0, 45)}`).join('\n');
                    schemaEmbed.addFields({ name: `📄 Sample #${i + 1}`, value: `\`\`\`\n${lines}\`\`\`` });
                });

                const attachment = new AttachmentBuilder(Buffer.from(JSON.stringify(markers, null, 2)), { name: `mapdata_${mapID}.json` });
                await interaction.editReply({ embeds: [schemaEmbed], files: [attachment] });
            } catch (err) { 
                console.error(`[mapdata] Error: ${err.message}`);
                await interaction.editReply(`❌ API error: \`${err.message}\``); 
            }
        }

        if (interaction.commandName === 'setup') {
            const cfg = guildConfigs.get(interaction.guildId) || { channelId: null };
            const embed = new EmbedBuilder().setTitle('⚙️ Bot Setup').setDescription(`Tactical Channel: ${cfg.channelId ? `<#${cfg.channelId}>` : "Not set"}`);
            const row = new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('setup_channel_select').addChannelTypes(ChannelType.GuildText));
            await interaction.reply({ embeds: [embed], components: [row], flags: [MessageFlags.Ephemeral] });
        }

        if (interaction.commandName === 'arc') {
            const arc = arcCache.find(a => a.id === interaction.options.getString('unit'));
            if (!arc) return interaction.reply({ content: "❌ Not found.", flags: [MessageFlags.Ephemeral] });
            const embed = new EmbedBuilder().setTitle(`🤖 Intel: ${arc.name}`).setDescription(arc.description).setColor(0x5865F2).setThumbnail(arc.icon).setImage(arc.image);
            await interaction.reply({ embeds: [embed] });
        }

        if (interaction.commandName === 'item') {
            const item = itemCache.find(i => i.id === interaction.options.getString('name'));
            if (!item) return interaction.reply({ content: "❌ Not found.", flags: [MessageFlags.Ephemeral] });
            const embed = new EmbedBuilder().setTitle(`📦 Item: ${item.name}`).setDescription(item.description || "No data.").setColor(rarityColors[item.rarity] || 0x5865F2).setThumbnail(item.icon).addFields({ name: 'Rarity', value: item.rarity || 'Common', inline: true }, { name: 'Value', value: `🪙 ${item.value?.toLocaleString() || 0}`, inline: true });
            await interaction.reply({ embeds: [embed] });
        }

        if (interaction.commandName === 'update') {
            await interaction.reply({ content: "🔄 Refreshing data...", flags: [MessageFlags.Ephemeral] });
            await refreshCaches();
            await updateEvents(interaction.guildId, true, true);
        }

    } catch (err) { console.error('Interaction error:', err.message); }
});

const commandsData = [
    new SlashCommandBuilder().setName('setup').setDescription('Configure the tactical channel for rotation updates').toJSON(),
    new SlashCommandBuilder().setName('update').setDescription('Force refresh rotation and item data').toJSON(),
    new SlashCommandBuilder().setName('servers').setDescription('Owner Only: Manage servers where the bot is installed').toJSON(),
    new SlashCommandBuilder().setName('help').setDescription('View available commands and bot information').toJSON(),
    new SlashCommandBuilder().setName('mapdata').setDescription('Owner Only: Inspect raw map marker data from the API')
        .addStringOption(option => option.setName('map').setDescription('The specific map key to query (e.g., dam, blue-gate)').setRequired(true)
            .addChoices(
                { name: 'Dam', value: 'dam' },
                { name: 'Blue Gate', value: 'blue-gate' },
                { name: 'Spaceport', value: 'spaceport' },
                { name: 'Buried City', value: 'buried-city' }
            )).toJSON(),
    new SlashCommandBuilder().setName('arc').setDescription('View tactical intel on specific ARC units')
        .addStringOption(opt => opt.setName('unit').setDescription('The name of the ARC unit').setRequired(true).setAutocomplete(true)).toJSON(),
    new SlashCommandBuilder().setName('item').setDescription('Search the database for item stats and values')
        .addStringOption(opt => opt.setName('name').setDescription('The name of the item to search for').setRequired(true).setAutocomplete(true)).toJSON(),
    new SlashCommandBuilder().setName('traders').setDescription('View current trader inventories and prices')
        .addStringOption(opt => opt.setName('name').setDescription('The trader name or item category').setRequired(true).setAutocomplete(true)).toJSON(),
    new SlashCommandBuilder().setName('quests').setDescription('Search active quest logs and requirements')
        .addStringOption(opt => opt.setName('name').setDescription('The name of the quest').setRequired(true).setAutocomplete(true)).toJSON(),
    new SlashCommandBuilder().setName('subscribe').setDescription('Configure personal DM notifications for specific rotations').toJSON()
];

client.once(Events.ClientReady, async () => {
    console.log(`[Ready] Logged in as ${client.user.tag}`);
    await ensureAuth();
    await loadAllConfigs();
    await refreshCaches();

    const rest = new REST({ version: '10' }).setToken(TOKEN);
    try {
        console.log('[Ready] Pushing slash commands globally...');
        await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commandsData });
        console.log('[Ready] Commands registered successfully.');
    } catch (e) { console.error('[Ready] Registry Error:', e); }

    setInterval(updateEvents, CHECK_INTERVAL);
});

client.login(TOKEN);
