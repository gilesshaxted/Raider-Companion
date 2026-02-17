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
    GuildScheduledEventPrivacyLevel,
    GuildScheduledEventEntityType,
    ActivityType 
} = require('discord.js');
const axios = require('axios');
const http = require('http');

// --- FIREBASE WEB SDK SETUP ---
const { initializeApp } = require('firebase/app');
const { getFirestore, doc, getDoc, setDoc, collection, getDocs } = require('firebase/firestore');
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
const TRADERS_API_URL = 'https://metaforge.app/api/arc-raiders/traders';
const QUESTS_API_URL = 'https://metaforge.app/api/arc-raiders/quests';
const CHECK_INTERVAL = 60000;

let guildConfigs = new Map();

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
        'Guilds',
        'GuildMessages',
        'MessageContent',
        'GuildScheduledEvents' 
    ]
});

let arcCache = [];
let itemCache = [];
let traderCache = {}; 
let traderItemsFlat = []; 
let traderCategories = []; 
let questCache = []; 
let isAuthorized = false;
let isUpdating = false; 

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

function getBotConfigDoc(guildId) {
    return doc(db, 'artifacts', appId, 'public', 'data', 'bot_configs', `${CLIENT_ID}_${guildId}`);
}

async function saveGuildConfig(guildId) {
    if (!await ensureAuth()) return;
    const config = guildConfigs.get(guildId);
    if (!config) return;
    try {
        const docRef = getBotConfigDoc(guildId);
        await setDoc(docRef, config);
    } catch (e) { console.error(`Error saving config for guild ${guildId}:`, e.message); }
}

async function loadAllConfigs() {
    if (!await ensureAuth()) return;
    try {
        const colRef = collection(db, 'artifacts', appId, 'public', 'data', 'bot_configs');
        const querySnapshot = await getDocs(colRef);
        querySnapshot.forEach((doc) => {
            if (doc.id.startsWith(CLIENT_ID)) {
                const guildId = doc.id.replace(`${CLIENT_ID}_`, '');
                const data = doc.data();
                if (!data.alertedEventKeys) data.alertedEventKeys = [];
                guildConfigs.set(guildId, data);
            }
        });
        console.log(`Loaded configs for ${guildConfigs.size} guilds.`);
    } catch (e) { console.error("Error loading configs:", e.message); }
}

async function refreshCaches() {
    try {
        const [arcRes, itemRes, traderRes, questRes] = await Promise.all([
            axios.get(ARCS_API_URL),
            axios.get(ITEMS_API_URL),
            axios.get(TRADERS_API_URL),
            axios.get(QUESTS_API_URL)
        ]);

        arcCache = arcRes.data?.data || [];
        itemCache = itemRes.data?.data || [];
        traderCache = traderRes.data?.data || {};
        questCache = questRes.data?.data || [];

        traderItemsFlat = [];
        const cats = new Set();
        for (const [traderName, items] of Object.entries(traderCache)) {
            items.forEach(item => {
                traderItemsFlat.push({ ...item, traderName });
                if (item.item_type) cats.add(item.item_type);
            });
        }
        traderCategories = Array.from(cats);
        
        console.log(`Caches Refreshed: ${arcCache.length} ARCs, ${itemCache.length} Items, ${questCache.length} Quests.`);
    } catch (e) { console.error("Error refreshing caches:", e.message); }
}

async function getOrCreateEventRole(guild, eventName) {
    try {
        const roles = await guild.roles.fetch();
        let role = roles.find(r => r.name === eventName);
        if (!role) {
            role = await guild.roles.create({
                name: eventName,
                reason: 'Auto-created for ARC Raiders rotation alerts',
                mentionable: true,
                color: 0x5865F2
            });
        }
        return `<@&${role.id}>`;
    } catch (e) {
        return `**${eventName}**`;
    }
}

/**
 * Fetches an image and returns a base64 Data URI. 
 * This is the format required by Discord for Scheduled Event cover images.
 */
async function fetchImageAsDataURI(url) {
    if (!url) return null;
    try {
        const response = await axios.get(url, { responseType: 'arraybuffer' });
        const buffer = Buffer.from(response.data, 'binary');
        const base64 = buffer.toString('base64');
        return `data:image/png;base64,${base64}`;
    } catch (err) {
        console.error(`Failed to fetch image for data URI: ${url}`, err.message);
        return null;
    }
}

// --- BOT LOGIC ---
async function updateEvents(targetGuildId = null, forceNewMessages = false) {
    if (isUpdating && !targetGuildId) return;
    if (!targetGuildId) isUpdating = true;

    try {
        const response = await axios.get(API_URL);
        const events = response.data?.data;
        if (!events || !Array.isArray(events)) {
            isUpdating = false;
            return;
        }

        const now = Date.now();
        const alertWindow = now + (60 * 60 * 1000); 
        const scheduleWindow = now + (3 * 60 * 60 * 1000); 

        const guildsToUpdate = targetGuildId 
            ? [[targetGuildId, guildConfigs.get(targetGuildId)]] 
            : Array.from(guildConfigs.entries());

        for (const [guildId, config] of guildsToUpdate) {
            if (!config || !config.channelId) continue;

            let channel;
            try {
                channel = await client.channels.fetch(config.channelId);
            } catch (err) { continue; }
            if (!channel) continue;

            const guild = channel.guild;

            // 1. CLEANUP EXPIRED ALERTS
            if (config.activeAlerts && config.activeAlerts.length > 0) {
                const freshAlerts = [];
                for (const alert of config.activeAlerts) {
                    if (now >= alert.startTime) {
                        try {
                            const msg = await channel.messages.fetch(alert.messageId);
                            await msg.delete();
                        } catch (err) {}
                    } else {
                        freshAlerts.push(alert);
                    }
                }
                config.activeAlerts = freshAlerts;
            }

            // 2. DISCORD SCHEDULED EVENTS SYNC & DUPLICATE REMOVAL
            let existingScheduledEvents = [];
            try {
                existingScheduledEvents = await guild.scheduledEvents.fetch();
            } catch (e) { console.error("Could not fetch scheduled events:", e.message); }

            // --- DUPLICATE PURGE ---
            // If there are multiple Discord events for the same map/time/name, delete extras.
            const seenKeys = new Set();
            for (const se of existingScheduledEvents.values()) {
                const key = `${se.scheduledStartTimestamp}_${se.entityMetadata?.location}_${se.name.toLowerCase()}`;
                if (seenKeys.has(key)) {
                    console.log(`Deleting duplicate native event: ${se.name}`);
                    try { await se.delete(); } catch (e) {}
                } else {
                    seenKeys.add(key);
                }
            }

            const scorableEvents = events.filter(e => e.startTime > now && e.startTime <= scheduleWindow);
            
            for (const e of scorableEvents) {
                const alreadyScheduled = existingScheduledEvents.some(se => {
                    const sameLocation = se.entityMetadata?.location === e.map;
                    const sameTimeWindow = Math.abs(se.scheduledStartTimestamp - e.startTime) < 120000;
                    return sameLocation && sameTimeWindow;
                });

                if (!alreadyScheduled) {
                    try {
                        const mapKey = Object.keys(mapConfigs).find(k => 
                            k.toLowerCase().replace(/\s/g, '') === e.map?.toLowerCase().replace(/\s/g, '')
                        );
                        
                        const mapImage = mapKey ? mapConfigs[mapKey].image : null;
                        const dataURI = await fetchImageAsDataURI(mapImage);

                        await guild.scheduledEvents.create({
                            name: `${getEmoji(e.name)} ${e.name} (${e.map})`,
                            scheduledStartTime: new Date(e.startTime),
                            scheduledEndTime: new Date(e.endTime),
                            privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
                            entityType: GuildScheduledEventEntityType.External,
                            entityMetadata: { location: e.map },
                            image: dataURI, // Use Data URI for cover
                            description: `Upcoming in-game event rotation on ${e.map}. Be ready Raiders!`
                        });
                        console.log(`Created event for ${e.name} with cover.`);
                    } catch (err) {
                        console.error(`Failed to create scheduled event for ${e.name}:`, err.message);
                    }
                }

                // 3. CHANNEL PING LOGIC
                if (e.startTime <= alertWindow) {
                    const alertKey = `${e.name}_${e.map}_${e.startTime}`;
                    if (!config.alertedEventKeys) config.alertedEventKeys = [];
                    
                    if (!config.alertedEventKeys.includes(alertKey)) {
                        const roleMention = await getOrCreateEventRole(guild, e.name);
                        const alertSent = await channel.send({
                            content: `⚠️ **Upcoming Event:** ${getEmoji(e.name)} ${roleMention} on **${e.map}** starts <t:${Math.floor(e.startTime / 1000)}:R>!`
                        });
                        
                        config.activeAlerts.push({ messageId: alertSent.id, startTime: e.startTime });
                        config.alertedEventKeys.push(alertKey);
                        
                        if (config.alertedEventKeys.length > 100) {
                            config.alertedEventKeys = config.alertedEventKeys.slice(-100);
                        }
                    }
                }
            }

            // 4. LIVE EMBED UPDATES
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
                    .setFooter({ text: `metaforge.app/arc-raiders` });

                if (activeEvent) {
                    embed.addFields({ name: '📡 Status', value: `🟢 **LIVE:** ${getEmoji(activeEvent.name)} **${activeEvent.name}**\nEnds <t:${Math.floor(activeEvent.endTime / 1000)}:R>` });
                    if (activeEvent.icon) embed.setThumbnail(activeEvent.icon);
                } else {
                    embed.addFields({ name: '📡 Status', value: '⚪ **Offline**' });
                }

                upcoming.forEach((e, i) => {
                    embed.addFields({ name: `Next Up #${i + 1}`, value: `${getEmoji(e.name)} **${e.name}**\n<t:${Math.floor(e.startTime / 1000)}:R>`, inline: true });
                });

                await syncMessage(channel, config, mapName, embed);
            }

            const current = events.filter(e => e.startTime <= now && e.endTime > now);
            const summary = new EmbedBuilder()
                .setTitle('🛸 ARC Raiders - Live Summary')
                .setColor(0x00AE86)
                .setFooter({ text: `Data provided by metaforge.app/arc-raiders` })
                .setTimestamp();

            if (current.length > 0) {
                summary.addFields({ name: '✅ Currently Active', value: current.map(e => `${getEmoji(e.name)} **${e.name}**\n└ *${e.map}*\n────────────────`).join('\n') });
            } else {
                summary.addFields({ name: '✅ Currently Active', value: 'No events currently active.' });
            }

            await syncMessage(channel, config, 'Summary', summary);
            await saveGuildConfig(guildId);
        }

    } catch (error) { 
        console.error('Update loop error:', error.message); 
    } finally {
        if (!targetGuildId) isUpdating = false;
    }
}

async function syncMessage(channel, config, key, embed) {
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

function buildTraderItemEmbed(item) {
    return new EmbedBuilder()
        .setTitle(`📦 Trader Item: ${item.name}`)
        .setDescription(item.description || "No description provided.")
        .setColor(rarityColors[item.rarity] || 0x5865F2)
        .setThumbnail(item.icon)
        .addFields(
            { name: 'Seller', value: `👤 ${item.traderName}`, inline: true },
            { name: 'Trader Price', value: `🪙 ${item.trader_price.toLocaleString()}`, inline: true },
            { name: 'Base Value', value: `🪙 ${item.value.toLocaleString()}`, inline: true },
            { name: 'Rarity', value: item.rarity, inline: true },
            { name: 'Category', value: item.item_type, inline: true }
        )
        .setTimestamp();
}

const commandsData = [
    new SlashCommandBuilder()
        .setName('setup')
        .setDescription('Set the channel for live event updates')
        .addChannelOption(option => option.setName('channel').setDescription('The channel to post in').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .toJSON(),
    new SlashCommandBuilder()
        .setName('update')
        .setDescription('Force a manual update of the live event embeds in this guild')
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
        .toJSON(),
    new SlashCommandBuilder()
        .setName('traders')
        .setDescription('View trader inventories or find where an item is sold')
        .addStringOption(option => 
            option.setName('name')
                .setDescription('Search for a Trader or Category (e.g. Weapon)')
                .setRequired(true)
                .setAutocomplete(true))
        .toJSON(),
    new SlashCommandBuilder()
        .setName('quests')
        .setDescription('View detailed objectives and rewards for ARC Raiders quests')
        .addStringOption(option => 
            option.setName('name')
                .setDescription('Search for a quest name')
                .setRequired(true)
                .setAutocomplete(true))
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

        if (interaction.commandName === 'traders') {
            const results = [];
            Object.keys(traderCache).forEach(name => {
                if (name.toLowerCase().includes(focusedValue)) {
                    results.push({ name: `👤 Trader: ${name}`, value: `trader:${name}` });
                }
            });
            traderCategories.forEach(cat => {
                if (cat.toLowerCase().includes(focusedValue)) {
                    results.push({ name: `📁 Category: ${cat}`, value: `category:${cat}` });
                }
            });
            await interaction.respond(results.slice(0, 25));
        }

        if (interaction.commandName === 'quests') {
            const choices = questCache.filter(q => q.name.toLowerCase().includes(focusedValue));
            await interaction.respond(choices.slice(0, 25).map(q => ({ name: q.name, value: q.id })));
        }
        return;
    }

    if (interaction.isStringSelectMenu()) {
        if (interaction.customId === 'trader_item_select') {
            const itemId = interaction.values[0];
            const item = traderItemsFlat.find(i => i.id === itemId);
            if (item) {
                await interaction.reply({ embeds: [buildTraderItemEmbed(item)], ephemeral: true });
            }
        }
        return;
    }

    if (!interaction.isChatInputCommand()) return;
    
    if (interaction.commandName === 'setup') {
        const targetChannel = interaction.options.getChannel('channel');
        const guildId = interaction.guildId;
        
        const newConfig = {
            channelId: targetChannel.id,
            activeAlerts: [],
            alertedEventKeys: [], 
            lastAlertedEventTime: null,
            messageIds: { 'Dam': null, 'Buried City': null, 'Blue Gate': null, 'Spaceport': null, 'Stella Montis': null, 'Summary': null }
        };
        
        guildConfigs.set(guildId, newConfig);
        await interaction.reply({ content: `✅ Events will now be posted and kept current in ${targetChannel} for this server.`, ephemeral: true });
        await updateEvents(guildId, true);
    }

    if (interaction.commandName === 'update') {
        const guildId = interaction.guildId;
        if (!guildConfigs.has(guildId)) return interaction.reply({ content: "❌ Please run `/setup` first!", ephemeral: true });
        
        await interaction.reply({ content: '🔄 Forcing update of all event embeds in this server...', ephemeral: true });
        await updateEvents(guildId, true);
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

        await interaction.reply({ embeds: [embed] });
    }

    if (interaction.commandName === 'traders') {
        const selection = interaction.options.getString('name');
        
        if (selection.startsWith('category:')) {
            const catName = selection.split(':')[1];
            const items = traderItemsFlat.filter(i => i.item_type === catName);
            if (items.length === 0) return interaction.reply({ content: "❌ No trader items found in this category.", ephemeral: true });
            const list = items.map(i => `• **${i.name}** sold by **${i.traderName}** (🪙 ${i.trader_price.toLocaleString()})`).join('\n');
            const embed = new EmbedBuilder()
                .setTitle(`📁 Browsing Category: ${catName}`)
                .setDescription(list)
                .setColor(0x3498db);
            const select = new StringSelectMenuBuilder()
                .setCustomId('trader_item_select')
                .setPlaceholder('Select an item to see details...')
                .addOptions(items.slice(0, 25).map(i => ({ label: i.name, description: `Seller: ${i.traderName} | Price: ${i.trader_price}`, value: i.id })));
            const row = new ActionRowBuilder().addComponents(select);
            await interaction.reply({ embeds: [embed], components: [row] });
        }
        else if (selection.startsWith('trader:')) {
            const traderName = selection.split(':')[1];
            const items = traderCache[traderName];
            if (!items) return interaction.reply({ content: "❌ Trader not found.", ephemeral: true });
            const inventoryList = items.map(i => `• **${i.name}**\n└ 🪙 ${i.trader_price.toLocaleString()} (${i.rarity})`).join('\n');
            const embed = new EmbedBuilder()
                .setTitle(`👤 Trader Inventory: ${traderName}`)
                .setDescription(inventoryList || 'This trader is currently out of stock.')
                .setColor(0x00AE86);
            const select = new StringSelectMenuBuilder()
                .setCustomId('trader_item_select')
                .setPlaceholder(`Select one of ${traderName}'s items...`)
                .addOptions(items.slice(0, 25).map(i => ({ label: i.name, description: `Type: ${i.item_type} | Price: ${i.trader_price}`, value: i.id })));
            const row = new ActionRowBuilder().addComponents(select);
            await interaction.reply({ embeds: [embed], components: [row] });
        } 
    }

    if (interaction.commandName === 'quests') {
        const questId = interaction.options.getString('name');
        try {
            await interaction.deferReply();
            const res = await axios.get(`${QUESTS_API_URL}?id=${questId}&page=1`);
            const quest = res.data?.data;
            if (!quest) return interaction.editReply("❌ Quest data could not be retrieved.");
            const embed = new EmbedBuilder()
                .setTitle(`📜 Quest: ${quest.name}`)
                .setColor(0x3498db)
                .setThumbnail(quest.image)
                .setTimestamp();
            if (quest.trader_name) embed.addFields({ name: '👤 Giver', value: quest.trader_name, inline: true });
            if (quest.xp > 0) embed.addFields({ name: '✨ XP Reward', value: `\`${quest.xp.toLocaleString()}\``, inline: true });
            if (quest.objectives && quest.objectives.length > 0) {
                const objectiveList = quest.objectives.map(o => `• ${o}`).join('\n');
                embed.addFields({ name: '🎯 Objectives', value: objectiveList });
            }
            let rewardsText = "";
            if (quest.granted_items && quest.granted_items.length > 0) {
                rewardsText += quest.granted_items.map(r => `✅ **${r.quantity}x** ${r.item.name}`).join('\n') + '\n';
            }
            if (quest.rewards && quest.rewards.length > 0) {
                rewardsText += quest.rewards.map(r => `🎁 **${r.quantity}x** ${r.item.name}`).join('\n');
            }
            if (rewardsText) embed.addFields({ name: '💰 Rewards', value: rewardsText });
            if (quest.guide_links && quest.guide_links.length > 0) {
                const links = quest.guide_links.map(l => `[${l.label}](${l.url})`).join('\n');
                embed.addFields({ name: '📖 Guides', value: links });
            }
            await interaction.editReply({ embeds: [embed] });
        } catch (e) {
            await interaction.editReply("❌ An error occurred while fetching quest details.");
        }
    }
});

client.on('messageCreate', async message => {
    if (message.author.bot) return;
    const config = guildConfigs.get(message.guildId);
    if (config && message.channel.id === config.channelId) updateEvents(message.guildId, true);
});

client.once(Events.ClientReady, async () => {
    console.log(`Logged in as ${client.user.tag}`);
    client.user.setActivity('you loot', { type: ActivityType.Watching });
    await loadAllConfigs();
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
