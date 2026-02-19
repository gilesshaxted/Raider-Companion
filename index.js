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

// --- FIREBASE WEB SDK SETUP ---
const { initializeApp } = require('firebase/app');
const { getFirestore, doc, getDoc, setDoc, collection, getDocs, deleteDoc, query } = require('firebase/firestore');
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
const db = getFirestore(app);
const auth = getAuth(app);
const appId = 'raider-companion';
const OWNER_ID = '444211741774184458';

// --- CONFIGURATION VALIDATION ---
const requiredEnvVars = [
    'FIREBASE_API_KEY',
    'FIREBASE_AUTH_DOMAIN',
    'FIREBASE_PROJECT_ID',
    'FIREBASE_STORAGE_BUCKET',
    'FIREBASE_MESSAGING_SENDER_ID',
    'FIREBASE_APP_ID',
    'DISCORD_TOKEN',
    'CLIENT_ID'
];

const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingVars.length > 0) {
    console.error('❌ CRITICAL ERROR: Missing required Environment Variables:');
    missingVars.forEach(v => console.error(`   - ${v}`));
    process.exit(1); 
}

// --- KOYEB HEALTH CHECK SERVER ---
const PORT = process.env.PORT || 8000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is running\n');
}).listen(PORT, () => console.log(`Health check server listening on port ${PORT}`));

// --- BOT SETTINGS ---
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

const mapConfigs = {
    'Dam': { color: 0x3498db, fileName: 'dam_battlegrounds.png' },
    'Buried City': { color: 0xe67e22, fileName: 'buried_city.png' },
    'Blue Gate': { color: 0x9b59b6, fileName: 'blue_gate.png' },
    'Spaceport': { color: 0x2ecc71, fileName: 'spaceport.png' },
    'Stella Montis': { color: 0xf1c40f, fileName: 'stella_montis.png' }
};

const rarityColors = {
    'Common': 0x95a5a6, 'Uncommon': 0x2ecc71, 'Rare': 0x3498db, 'Epic': 0x9b59b6, 'Legendary': 0xf1c40f
};

const eventEmojis = {
    'Night Raid': '🌙', 'Prospecting Probes': '📡', 'Matriarch': '👑', 'Bird City': '🐦',
    'Hidden Bunker': '🏢', 'Cold Snap': '❄️', 'Harvester': '🚜', 'Electromagnetic Storm': '⚡',
    'Lush Blooms': '🌸', 'Locked Gate': '🔒', 'Launch Tower Loot': '🚀', 'Uncovered Caches': '📦'
};

const notificationTimes = [
    { label: '3 Hours', value: '10800000' },
    { label: '2 Hours', value: '7200000' },
    { label: '1 Hour', value: '3600000' },
    { label: '45 Minutes', value: '2700000' },
    { label: '30 Minutes', value: '1800000' },
    { label: '15 Minutes', value: '900000' }
];

const getEmoji = (name) => eventEmojis[name] || '🛸';

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildScheduledEvents,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildPresences
    ],
    partials: [Partials.Message, Partials.Reaction, Partials.User, Partials.Channel]
});

client.on(Events.Error, error => {
    console.error('⚠️ Discord Client Error:', error.message);
});

let arcCache = [], itemCache = [], traderCache = {}, traderItemsFlat = [], traderCategories = [], questCache = [];
let isAuthorized = false, isGlobalUpdating = false;

// --- PERSISTENCE HELPERS ---
async function ensureAuth() {
    if (isAuthorized) return true;
    try {
        await signInAnonymously(auth);
        isAuthorized = true;
        return true;
    } catch (e) {
        console.error("❌ Firebase Auth Failed:", e.message);
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
                if (!data.activeAlerts) data.activeAlerts = [];
                if (data.scheduledEventsEnabled === undefined) data.scheduledEventsEnabled = true;
                if (data.rolePingsEnabled === undefined) data.rolePingsEnabled = true;
                guildConfigs.set(guildId, data);
            }
        });
    } catch (e) { console.error("❌ Error loading configs:", e.message); }
}

// --- SUBSCRIPTION HELPERS ---
function getUserSubCollection(userId) {
    return collection(db, 'artifacts', appId, 'users', userId, 'subscriptions');
}

async function getUserSubscriptions(userId) {
    if (!await ensureAuth()) return [];
    try {
        const snap = await getDocs(getUserSubCollection(userId));
        return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (e) { return []; }
}

async function isGuildBlacklisted(guildId) {
    if (!await ensureAuth()) return false;
    const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'blacklist', guildId);
    const snap = await getDoc(docRef);
    return snap.exists();
}

async function blacklistGuild(guildId) {
    if (!await ensureAuth()) return;
    const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'blacklist', guildId);
    await setDoc(docRef, { blacklisted_at: Date.now() });
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
        for (const [traderName, items] of Object.entries(traderCache)) {
            items.forEach(item => { 
                traderItemsFlat.push({ ...item, traderName }); 
                if (item.item_type) cats.add(item.item_type);
            });
        }
        traderCategories = Array.from(cats);
    } catch (e) { console.error("❌ Error refreshing caches:", e.message); }
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
        return role;
    } catch (e) { return null; }
}

function getLocalImageAsDataURI(fileName) {
    if (!fileName) return null;
    const filePath = path.join(__dirname, 'assets', fileName);
    if (!fs.existsSync(filePath)) return null;
    try {
        const buffer = fs.readFileSync(filePath);
        return `data:image/png;base64,${buffer.toString('base64')}`;
    } catch (err) { return null; }
}

// --- BOT LOGIC ---
async function updateEvents(targetGuildId = null, forceNewMessages = false, purgeActivePings = false) {
    if (!targetGuildId) {
        if (isGlobalUpdating) return;
        isGlobalUpdating = true;
    }

    try {
        const response = await axios.get(API_URL);
        const events = response.data?.data;
        if (!events || !Array.isArray(events)) { if (!targetGuildId) isGlobalUpdating = false; return; }

        const now = Date.now();
        const alertWindow = now + (60 * 60 * 1000); 
        const scheduleWindow = now + (3 * 60 * 60 * 1000); 

        // GLOBAL DM ENGINE
        if (!targetGuildId) {
            try {
                const activeUsersSnap = await getDocs(collection(db, 'artifacts', appId, 'public', 'data', 'subscription_users'));
                for (const userDoc of activeUsersSnap.docs) {
                    const userId = userDoc.id;
                    const subs = await getUserSubscriptions(userId);
                    const discordUser = await client.users.fetch(userId).catch(() => null);
                    if (!discordUser || subs.length === 0) continue;
                    for (const sub of subs) {
                        const matchedEvent = events.find(ev => ev.map?.toLowerCase().trim() === sub.map?.toLowerCase().trim() && ev.name?.toLowerCase().trim() === sub.event?.toLowerCase().trim() && ev.startTime > now);
                        if (matchedEvent) {
                            const timeUntil = matchedEvent.startTime - now;
                            for (const offsetMs of sub.offsets) {
                                const offsetNum = Number(offsetMs);
                                if (timeUntil <= offsetNum && timeUntil > (offsetNum - 120000)) {
                                    const alertKey = `dm_${userId}_${matchedEvent.map}_${matchedEvent.name}_${matchedEvent.startTime}_${offsetNum}`;
                                    const lockDoc = doc(db, 'artifacts', appId, 'public', 'data', 'sent_alerts', alertKey);
                                    const lockSnap = await getDoc(lockDoc);
                                    if (!lockSnap.exists()) {
                                        const embed = new EmbedBuilder().setTitle("🔔 Rotation Starting").setDescription(`${getEmoji(matchedEvent.name)} **${matchedEvent.name}** on **${matchedEvent.map}** starts <t:${Math.floor(matchedEvent.startTime/1000)}:R>!`).setColor(0x00AE86).setTimestamp();
                                        try { await discordUser.send({ embeds: [embed] }); await setDoc(lockDoc, { sent_at: now, expires_at: matchedEvent.startTime + (24 * 60 * 60 * 1000) }); } catch (dmErr) {}
                                    }
                                }
                            }
                        }
                    }
                }
            } catch (engErr) {}
        }

        const guildsToUpdate = targetGuildId ? [[targetGuildId, guildConfigs.get(targetGuildId)]] : Array.from(guildConfigs.entries());

        for (const [guildId, config] of guildsToUpdate) {
            if (!config || !config.channelId || activeGuildUpdates.has(guildId)) continue;
            activeGuildUpdates.add(guildId);
            try {
                let channel;
                try { channel = await client.channels.fetch(config.channelId); } catch (err) { continue; }
                if (!channel) continue;
                const guild = channel.guild;

                // 1. CLEANUP ROLE PINGS
                if (config.activeAlerts && config.activeAlerts.length > 0) {
                    const freshAlerts = [];
                    for (const alert of config.activeAlerts) {
                        if (now >= alert.startTime || purgeActivePings) {
                            try { const msg = await channel.messages.fetch(alert.messageId); await msg.delete(); } catch (err) {}
                            if (purgeActivePings) config.alertedEventKeys = config.alertedEventKeys.filter(k => !k.includes(String(alert.startTime)));
                        } else freshAlerts.push(alert);
                    }
                    config.activeAlerts = freshAlerts;
                }

                // 2. DISCORD SCHEDULED EVENTS SYNC
                if (config.scheduledEventsEnabled !== false) {
                    let existingScheduledEvents = [];
                    try { existingScheduledEvents = await guild.scheduledEvents.fetch(); } catch (e) {}
                    const seenSlots = new Set();
                    for (const se of existingScheduledEvents.values()) {
                        const key = `${se.scheduledStartTimestamp}_${se.entityMetadata?.location}`;
                        if (seenSlots.has(key)) { try { await se.delete(); } catch (e) {} } else { seenSlots.add(key); }
                    }
                    const scorableEvents = events.filter(e => e.startTime > now && e.startTime <= scheduleWindow);
                    const groupedEvents = {};
                    scorableEvents.forEach(e => {
                        const groupKey = `${e.map}_${e.startTime}`;
                        if (!groupedEvents[groupKey]) groupedEvents[groupKey] = [];
                        groupedEvents[groupKey].push(e);
                    });
                    for (const groupKey in groupedEvents) {
                        const group = groupedEvents[groupKey];
                        const first = group[0];
                        const existingEvent = existingScheduledEvents.find(se => se.entityMetadata?.location === first.map && Math.abs(se.scheduledStartTimestamp - first.startTime) < 120000);
                        const finalName = `${group.map(ev => `${getEmoji(ev.name)} ${ev.name}`).join(' & ')} (${first.map})`.substring(0, 100);
                        const finalDesc = `Upcoming rotation group on ${first.map}:\n${group.map(ev => `• ${getEmoji(ev.name)} **${ev.name}**`).join('\n')}`;
                        const mapKey = Object.keys(mapConfigs).find(k => k.toLowerCase().replace(/\s/g, '') === first.map?.toLowerCase().replace(/\s/g, ''));
                        const dataURI = mapKey ? getLocalImageAsDataURI(mapConfigs[mapKey].fileName) : null;
                        if (existingEvent) { try { await existingEvent.edit({ name: finalName, description: finalDesc, image: dataURI }); } catch (err) {} }
                        else { try { await guild.scheduledEvents.create({ name: finalName, scheduledStartTime: new Date(first.startTime), scheduledEndTime: new Date(Math.max(...group.map(ev => ev.endTime))), privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly, entityType: GuildScheduledEventEntityType.External, entityMetadata: { location: first.map }, image: dataURI, description: finalDesc }); } catch (err) {} }
                    }
                }

                // 3. MAP EMBEDS
                if (forceNewMessages) {
                    for (const key in config.messageIds) { if (config.messageIds[key]) { try { const m = await channel.messages.fetch(config.messageIds[key]); await m.delete(); } catch (e) {} config.messageIds[key] = null; } }
                }
                for (const [mapName, mapSet] of Object.entries(mapConfigs)) {
                    const mapEvents = events.filter(e => e.map?.toLowerCase().replace(/\s/g, '') === mapName.toLowerCase().replace(/\s/g, ''));
                    const activeEvents = mapEvents.filter(e => e.startTime <= now && e.endTime > now);
                    const upcoming = mapEvents.filter(e => e.startTime > now).sort((a, b) => a.startTime - b.startTime).slice(0, 3);
                    const imagePath = path.join(__dirname, 'assets', mapSet.fileName);
                    const file = fs.existsSync(imagePath) ? new AttachmentBuilder(imagePath) : null;
                    const embed = new EmbedBuilder().setTitle(`📍 ${mapName}`).setColor(mapSet.color).setTimestamp().setFooter({ text: `metaforge.app/arc-raiders` });
                    if (file) embed.setImage(`attachment://${mapSet.fileName}`);
                    if (activeEvents.length > 0) {
                        embed.addFields({ name: '📡 Status', value: activeEvents.map(ev => `🟢 **LIVE:** ${getEmoji(ev.name)} **${ev.name}** (Ends <t:${Math.floor(ev.endTime / 1000)}:R>)`).join('\n') });
                        if (activeEvents[0].icon) embed.setThumbnail(activeEvents[0].icon);
                    } else { embed.addFields({ name: '📡 Status', value: '⚪ **Offline**' }); }
                    upcoming.forEach((e, i) => { embed.addFields({ name: `Next Up #${i + 1}`, value: `${getEmoji(e.name)} **${e.name}**\n<t:${Math.floor(e.startTime / 1000)}:R>`, inline: true }); });
                    await syncMessageWithFile(channel, config, mapName, embed, file);
                }

                // 4. SUMMARY
                const summary = new EmbedBuilder().setTitle('🛸 ARC Raiders - Live Summary').setColor(0x00AE86).setDescription('React with an emoji below to get notification roles!').setFooter({ text: `Data: metaforge.app/arc-raiders` }).setTimestamp();
                const current = events.filter(e => e.startTime <= now && e.endTime > now);
                if (current.length > 0) summary.addFields({ name: '✅ Active', value: current.map(e => `${getEmoji(e.name)} **${e.name}** (${e.map})`).join('\n') });
                else summary.addFields({ name: '✅ Active', value: 'None.' });
                const summarySent = await syncMessage(channel, config, 'Summary', summary);
                if (summarySent && forceNewMessages) { for (const emoji of Object.values(eventEmojis)) { try { await summarySent.react(emoji); } catch (e) {} } }

                // 5. ROLE PINGS (SENT LAST)
                if (config.rolePingsEnabled !== false) {
                    const scorableForPing = events.filter(e => e.startTime > now && e.startTime <= alertWindow);
                    for (const e of scorableForPing) {
                        const alertKey = `${e.name}_${e.map}_${e.startTime}`;
                        if (!config.alertedEventKeys.includes(alertKey)) {
                            const role = await getOrCreateEventRole(guild, e.name);
                            const roleMention = role ? `<@&${role.id}>` : `**${e.name}**`;
                            const alertSent = await channel.send({ content: `⚠️ **Upcoming Event:** ${getEmoji(e.name)} ${roleMention} on **${e.map}** starts <t:${Math.floor(e.startTime / 1000)}:R>!` });
                            config.activeAlerts.push({ messageId: alertSent.id, startTime: e.startTime });
                            config.alertedEventKeys.push(alertKey);
                        }
                    }
                }
                await saveGuildConfig(guildId);
            } finally { activeGuildUpdates.delete(guildId); }
        }
    } catch (error) { console.error('Loop error:', error.message); } finally { if (!targetGuildId) isGlobalUpdating = false; }
}

async function syncMessage(channel, config, key, embed) {
    if (config.messageIds[key]) { try { const msg = await channel.messages.fetch(config.messageIds[key]); return await msg.edit({ embeds: [embed] }); } catch (e) { const sent = await channel.send({ embeds: [embed] }); config.messageIds[key] = sent.id; return sent; } }
    else { const sent = await channel.send({ embeds: [embed] }); config.messageIds[key] = sent.id; return sent; }
}

async function syncMessageWithFile(channel, config, key, embed, file) {
    const files = file ? [file] : [];
    if (config.messageIds[key]) { try { const msg = await channel.messages.fetch(config.messageIds[key]); return await msg.edit({ embeds: [embed], files }); } catch (e) { const sent = await channel.send({ embeds: [embed], files }); config.messageIds[key] = sent.id; return sent; } }
    else { const sent = await channel.send({ embeds: [embed], files }); config.messageIds[key] = sent.id; return sent; }
}

function buildTraderItemEmbed(item) {
    return new EmbedBuilder().setTitle(`📦 Item: ${item.name}`).setDescription(item.description || "No info.").setColor(rarityColors[item.rarity] || 0x5865F2).setThumbnail(item.icon).addFields({ name: 'Trader Price', value: `🪙 ${item.trader_price.toLocaleString()}`, inline: true }, { name: 'Category', value: item.item_type, inline: true }).setTimestamp();
}

function generateSetupEmbed(guild, config) {
    return new EmbedBuilder().setTitle(`⚙️ Tactical Setup: ${guild.name}`).setColor(0x5865F2).setThumbnail(guild.iconURL()).setDescription("Configure how Raider Companion operates in this server.").addFields({ name: "📍 Tactical Channel", value: config.channelId ? `<#${config.channelId}>` : "❌ *Not Configured*", inline: true }, { name: "📅 Discord Events", value: config.scheduledEventsEnabled !== false ? "✅ Enabled" : "❌ Disabled", inline: true }, { name: "🔔 Role Pings", value: config.rolePingsEnabled !== false ? "✅ Enabled" : "❌ Disabled", inline: true }).setFooter({ text: "Use the menu and buttons below to adjust settings." }).setTimestamp();
}

function generateSetupComponents(config) {
    const channelSelect = new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('setup_channel_select').setPlaceholder('Select tactical channel...').addChannelTypes(ChannelType.GuildText));
    const toggleRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('setup_toggle_events').setLabel(config.scheduledEventsEnabled !== false ? 'Disable Events Tab' : 'Enable Events Tab').setStyle(config.scheduledEventsEnabled !== false ? ButtonStyle.Danger : ButtonStyle.Success), new ButtonBuilder().setCustomId('setup_toggle_pings').setLabel(config.rolePingsEnabled !== false ? 'Disable Role Pings' : 'Enable Role Pings').setStyle(config.rolePingsEnabled !== false ? ButtonStyle.Danger : ButtonStyle.Success), new ButtonBuilder().setCustomId('setup_create_roles').setLabel('Create Roles').setStyle(ButtonStyle.Secondary).setEmoji('🎭'));
    return [channelSelect, toggleRow];
}

const helpPages = [
    { title: "🛸 Overview", description: "Stay informed about ARC Raiders rotations and items.", fields: [{ name: "Intelligence", value: "`/arc`, `/item`, `/traders`, `/quests`" }] },
    { title: "🔔 Alerts", description: "Personal DM notifications.", fields: [{ name: "Command", value: "`/subscribe`" }] },
    { title: "🛠️ Admin", description: "Configure the bot.", fields: [{ name: "Setup", value: "`/setup` and `/update`" }] }
];

function generateHelpEmbed(i) { return new EmbedBuilder().setTitle(helpPages[i].title).setDescription(helpPages[i].description).setColor(0x5865F2).addFields(helpPages[i].fields).setFooter({ text: `Page ${i + 1}/3` }); }
function generateHelpComponents(i) { return [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`help_prev_${i}`).setLabel('Prev').setStyle(ButtonStyle.Secondary).setDisabled(i === 0), new ButtonBuilder().setCustomId(`help_next_${i}`).setLabel('Next').setStyle(ButtonStyle.Primary).setDisabled(i === 2))]; }

const commandsData = [
    new SlashCommandBuilder().setName('setup').setDescription('Setup tactical channel').setDefaultMemberPermissions(PermissionFlagsBits.Administrator).toJSON(),
    new SlashCommandBuilder().setName('update').setDescription('Refresh everything').setDefaultMemberPermissions(PermissionFlagsBits.Administrator).toJSON(),
    new SlashCommandBuilder().setName('arc').setDescription('ARC Intel').addStringOption(o => o.setName('unit').setDescription('Unit').setRequired(true).setAutocomplete(true)).toJSON(),
    new SlashCommandBuilder().setName('item').setDescription('Item Search').addStringOption(o => o.setName('name').setDescription('Item').setRequired(true).setAutocomplete(true)).toJSON(),
    new SlashCommandBuilder().setName('traders').setDescription('Trader Inventories').addStringOption(o => o.setName('name').setDescription('Trader/Category').setRequired(true).setAutocomplete(true)).toJSON(),
    new SlashCommandBuilder().setName('quests').setDescription('Quest Logs').addStringOption(o => o.setName('name').setDescription('Quest').setRequired(true).setAutocomplete(true)).toJSON(),
    new SlashCommandBuilder().setName('subscribe').setDescription('Personal DM Alerts').toJSON(),
    new SlashCommandBuilder().setName('test-dm').setDescription('Verify alerts (Owner Only)').toJSON(),
    new SlashCommandBuilder().setName('help').setDescription('Help guide').toJSON(),
    new SlashCommandBuilder().setName('servers').setDescription('Manage servers (Owner Only)').toJSON()
];

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
            if (interaction.commandName === 'quests') await interaction.respond(questCache.filter(q => q.name.toLowerCase().includes(f)).slice(0, 25).map(q => ({ name: q.name, value: q.id })));
            return;
        }

        if (interaction.isChannelSelectMenu() && interaction.customId === 'setup_channel_select') {
            const ch = interaction.channels.first();
            let cfg = guildConfigs.get(interaction.guildId) || { activeAlerts: [], alertedEventKeys: [] };
            cfg.channelId = ch.id;
            guildConfigs.set(interaction.guildId, cfg);
            await saveGuildConfig(interaction.guildId);
            await interaction.update({ embeds: [generateSetupEmbed(interaction.guild, cfg)], components: generateSetupComponents(cfg) });
            await updateEvents(interaction.guildId, true, true);
            return;
        }

        if (interaction.isStringSelectMenu()) {
            if (interaction.customId === 'trader_item_select') {
                const item = traderItemsFlat.find(i => i.id === interaction.values[0]);
                if (item) await interaction.reply({ embeds: [buildTraderItemEmbed(item)], flags: [MessageFlags.Ephemeral] });
            }
            if (interaction.customId === 'sub_delete_select') {
                await deleteDoc(doc(db, 'artifacts', appId, 'users', interaction.user.id, 'subscriptions', interaction.values[0]));
                await interaction.update({ content: "✅ Deleted.", embeds: [], components: [] });
            }
            if (interaction.customId === 'sub_create_map') {
                const opts = Object.keys(eventEmojis).map(e => ({ label: e, value: e, emoji: eventEmojis[e] }));
                await interaction.update({ content: `📍 Map: **${interaction.values[0]}**\nSelect rotation:`, components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`sub_create_event|${interaction.values[0]}`).setPlaceholder('Select...').addOptions(opts))] });
            }
            if (interaction.customId.startsWith('sub_create_event|')) {
                const map = interaction.customId.split('|')[1];
                await interaction.update({ content: `📍 Map: **${map}**\n🛸 Rotation: **${interaction.values[0]}**\nSelect lead times:`, components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`sub_create_times|${map}|${interaction.values[0]}`).setPlaceholder('Select...').setMinValues(1).setMaxValues(2).addOptions(notificationTimes))] });
            }
            if (interaction.customId.startsWith('sub_create_times|')) {
                const [, map, event] = interaction.customId.split('|');
                const subId = `${map}_${event}`.toLowerCase().replace(/\s/g, '_');
                await setDoc(doc(db, 'artifacts', appId, 'users', interaction.user.id, 'subscriptions', subId), { map, event, offsets: interaction.values.map(Number), created_at: Date.now() });
                await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'subscription_users', interaction.user.id), { active: true });
                await interaction.update({ content: `✅ **Active!** DMs set for **${event}** on **${map}**.`, components: [] });
            }
            if (interaction.customId === 'server_mgmt_select') {
                if (interaction.user.id !== OWNER_ID) return;
                const guild = await client.guilds.fetch(interaction.values[0]);
                const owner = await guild.fetchOwner();
                const BotJoined = guild.members.me?.joinedTimestamp;
                const active = guild.members.cache.filter(m => m.presence && m.presence.status !== 'offline').size;
                const embed = new EmbedBuilder().setTitle(guild.name).setThumbnail(guild.iconURL()).setColor(0x5865F2).addFields({ name: 'Owner', value: `${owner.user.tag} (\`${owner.id}\`)`, inline: true }, { name: 'ID', value: `\`${guild.id}\``, inline: true }, { name: 'Joined', value: `<t:${Math.floor(BotJoined/1000)}:R>`, inline: true }, { name: 'Members', value: `Total: ${guild.memberCount}\nActive: ${active}`, inline: true });
                const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`srv_invite_${guild.id}`).setLabel('Invite').setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId(`srv_dm_${owner.id}`).setLabel('DM').setStyle(ButtonStyle.Secondary), new ButtonBuilder().setCustomId(`srv_leave_${guild.id}`).setLabel('Leave').setStyle(ButtonStyle.Danger), new ButtonBuilder().setCustomId(`srv_block_${guild.id}`).setLabel('Block').setStyle(ButtonStyle.Danger));
                await interaction.reply({ embeds: [embed], components: [row], flags: [MessageFlags.Ephemeral] });
            }
            return;
        }

        if (interaction.isButton()) {
            if (interaction.customId === 'setup_toggle_events') {
                let cfg = guildConfigs.get(interaction.guildId);
                cfg.scheduledEventsEnabled = !cfg.scheduledEventsEnabled;
                guildConfigs.set(interaction.guildId, cfg);
                await saveGuildConfig(interaction.guildId);
                await interaction.update({ embeds: [generateSetupEmbed(interaction.guild, cfg)], components: generateSetupComponents(cfg) });
            }
            if (interaction.customId === 'setup_toggle_pings') {
                let cfg = guildConfigs.get(interaction.guildId);
                cfg.rolePingsEnabled = !cfg.rolePingsEnabled;
                guildConfigs.set(interaction.guildId, cfg);
                await saveGuildConfig(interaction.guildId);
                await interaction.update({ embeds: [generateSetupEmbed(interaction.guild, cfg)], components: generateSetupComponents(cfg) });
            }
            if (interaction.customId === 'setup_create_roles') {
                await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
                for (const n of Object.keys(eventEmojis)) await getOrCreateEventRole(interaction.guild, n);
                await interaction.editReply("✅ Roles verified.");
            }
            if (interaction.customId === 'sub_create_start') {
                const opts = Object.keys(mapConfigs).map(m => ({ label: m, value: m }));
                await interaction.reply({ content: "📝 **New Alert**", components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('sub_create_map').setPlaceholder('Pick...').addOptions(opts))], flags: [MessageFlags.Ephemeral] });
            }
            if (interaction.customId.startsWith('help_')) {
                const [, act, cur] = interaction.customId.split('_');
                const nxt = act === 'next' ? Number(cur)+1 : Number(cur)-1;
                await interaction.update({ embeds: [generateHelpEmbed(nxt)], components: generateHelpComponents(nxt) });
            }
            if (interaction.customId.startsWith('srv_')) {
                if (interaction.user.id !== OWNER_ID) return;
                const [, act, tid] = interaction.customId.split('_');
                if (act === 'invite') {
                    const g = await client.guilds.fetch(tid);
                    const c = g.channels.cache.find(ch => ch.isTextBased() && ch.permissionsFor(client.user).has('CreateInstantInvite'));
                    const inv = await c?.createInvite();
                    await interaction.reply({ content: inv?.url || "Error", flags: [MessageFlags.Ephemeral] });
                }
                if (act === 'leave') { await (await client.guilds.fetch(tid)).leave(); await interaction.reply({ content: "Left.", flags: [MessageFlags.Ephemeral] }); }
                if (act === 'block') { await blacklistGuild(tid); await (await client.guilds.fetch(tid)).leave().catch(()=>{}); await interaction.reply({ content: "Blocked.", flags: [MessageFlags.Ephemeral] }); }
                if (act === 'dm') {
                    const modal = new ModalBuilder().setCustomId(`srv_modal_dm_${tid}`).setTitle('DM');
                    modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('dm_text').setLabel('Content').setStyle(TextInputStyle.Paragraph)));
                    await interaction.showModal(modal);
                }
            }
            return;
        }

        if (interaction.isModalSubmit() && interaction.customId.startsWith('srv_modal_dm_')) {
            const u = await client.users.fetch(interaction.customId.replace('srv_modal_dm_', ''));
            await u.send(`**Dev:** ${interaction.fields.getTextInputValue('dm_text')}`);
            await interaction.reply({ content: "Sent.", flags: [MessageFlags.Ephemeral] });
            return;
        }

        if (!interaction.isChatInputCommand()) return;

        // RESTORED: /arc command
        if (interaction.commandName === 'arc') {
            const unitId = interaction.options.getString('unit');
            const arc = arcCache.find(a => a.id === unitId);
            if (!arc) return interaction.reply({ content: "❌ Not found.", flags: [MessageFlags.Ephemeral] });
            const embed = new EmbedBuilder().setTitle(`🤖 Intelligence: ${arc.name}`).setDescription(arc.description).setColor(0x5865F2).setThumbnail(arc.icon).setImage(arc.image).setTimestamp();
            await interaction.reply({ embeds: [embed] });
        }

        // RESTORED: /item command
        if (interaction.commandName === 'item') {
            const itemId = interaction.options.getString('name');
            const item = itemCache.find(i => i.id === itemId);
            if (!item) return interaction.reply({ content: "❌ Not found.", flags: [MessageFlags.Ephemeral] });
            const embed = new EmbedBuilder().setTitle(`📦 Item: ${item.name}`).setDescription(item.description || "No data.").setColor(rarityColors[item.rarity] || 0x5865F2).setThumbnail(item.icon).addFields({ name: 'Rarity', value: item.rarity || 'Common', inline: true }, { name: 'Value', value: `🪙 ${item.value?.toLocaleString() || 0}`, inline: true });
            if (item.workbench) embed.addFields({ name: 'Workbench', value: `🛠️ ${item.workbench}`, inline: true });
            if (item.loot_area) embed.addFields({ name: 'Loot', value: `📍 ${item.loot_area}`, inline: true });
            await interaction.reply({ embeds: [embed] });
        }

        // RESTORED: /traders command
        if (interaction.commandName === 'traders') {
            const query = interaction.options.getString('name');
            if (query.startsWith('category:')) {
                const cat = query.split(':')[1];
                const items = traderItemsFlat.filter(i => i.item_type === cat);
                const list = items.map(i => `• ${i.name} (${i.traderName})`).join('\n');
                const embed = new EmbedBuilder().setTitle(`📁 Category: ${cat}`).setDescription(list).setColor(0x3498db);
                const sel = new StringSelectMenuBuilder().setCustomId('trader_item_select').setPlaceholder('Select...').addOptions(items.slice(0, 25).map(i => ({ label: i.name, value: i.id })));
                await interaction.reply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(sel)] });
            } else if (query.startsWith('trader:')) {
                const name = query.split(':')[1];
                const items = traderCache[name];
                const list = items.map(i => `• ${i.name} - 🪙 ${i.trader_price.toLocaleString()}`).join('\n');
                const embed = new EmbedBuilder().setTitle(`👤 Trader: ${name}`).setDescription(list).setColor(0x00AE86);
                const sel = new StringSelectMenuBuilder().setCustomId('trader_item_select').setPlaceholder('Select...').addOptions(items.slice(0, 25).map(i => ({ label: i.name, value: i.id })));
                await interaction.reply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(sel)] });
            }
        }

        // RESTORED: /quests command
        if (interaction.commandName === 'quests') {
            const questId = interaction.options.getString('name');
            await interaction.deferReply();
            try {
                const res = await axios.get(`${QUESTS_API_URL}?id=${questId}&page=1`);
                const q = res.data?.data;
                if (!q) return interaction.editReply("❌ Not found.");
                const embed = new EmbedBuilder().setTitle(`📜 Quest: ${q.name}`).setColor(0x3498db).setThumbnail(q.image);
                if (q.trader_name) embed.addFields({ name: 'Giver', value: q.trader_name, inline: true });
                if (q.xp > 0) embed.addFields({ name: 'XP', value: q.xp.toLocaleString(), inline: true });
                if (q.objectives?.length > 0) embed.addFields({ name: 'Objectives', value: q.objectives.map(o => `• ${o}`).join('\n') });
                await interaction.editReply({ embeds: [embed] });
            } catch (e) { await interaction.editReply("❌ API Error."); }
        }

        if (interaction.commandName === 'servers') {
            if (interaction.user.id !== OWNER_ID) return;
            const guilds = client.guilds.cache.map(g => ({ label: g.name.substring(0, 25), value: g.id }));
            await interaction.reply({ content: "👤 **Management**", components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('server_mgmt_select').setPlaceholder('Pick...').addOptions(guilds.slice(0, 25)))], flags: [MessageFlags.Ephemeral] });
        }
        if (interaction.commandName === 'setup') {
            const cfg = guildConfigs.get(interaction.guildId) || { channelId: null };
            await interaction.reply({ embeds: [generateSetupEmbed(interaction.guild, cfg)], components: generateSetupComponents(cfg), flags: [MessageFlags.Ephemeral] });
        }
        if (interaction.commandName === 'help') await interaction.reply({ embeds: [generateHelpEmbed(0)], components: generateHelpComponents(0), flags: [MessageFlags.Ephemeral] });
        if (interaction.commandName === 'update') { await interaction.reply({ content: '🔄 Refreshing...', flags: [MessageFlags.Ephemeral] }); await updateEvents(interaction.guildId, true, true); }
        if (interaction.commandName === 'test-dm') {
            if (interaction.user.id !== OWNER_ID) return;
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            const subs = await getUserSubscriptions(interaction.user.id);
            const res = await axios.get(API_URL);
            const evs = res.data?.data || [];
            const embed = new EmbedBuilder().setTitle("🧪 Diagnostic").setColor(0x3498db);
            let desc = "";
            for (const s of subs) {
                const m = evs.find(e => e.map?.toLowerCase().trim() === s.map?.toLowerCase().trim() && e.name?.toLowerCase().trim() === s.event?.toLowerCase().trim() && e.startTime > Date.now());
                desc += `📡 ${s.event} on ${s.map}: ${m ? "Upcoming found" : "None found"}\n`;
            }
            embed.setDescription(desc || "No subs.");
            await interaction.user.send({ embeds: [embed] });
            await interaction.editReply("✅ DM Sent.");
        }
    } catch (err) { console.error('❌ Interaction Error:', err.message); }
});

client.on('messageCreate', async m => {
    if (m.author.bot || m.guild) return;
    if (m.author.id === OWNER_ID && m.content.toLowerCase() === 'ping') return m.reply('Pong!');
    const dev = await client.users.fetch(OWNER_ID);
    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`srv_dm_${m.author.id}`).setLabel(`Reply`).setStyle(ButtonStyle.Primary));
    await dev.send({ embeds: [new EmbedBuilder().setTitle('DM').setAuthor({ name: m.author.tag }).setDescription(m.content)], components: [row] });
    await m.reply("✅ Forwarded.");
});

client.once(Events.ClientReady, async () => {
    console.log(`[Startup] Logged in as ${client.user.tag}`);
    client.user.setActivity('metaforge.app/arc-raiders', { type: ActivityType.Listening });
    (async () => {
        await ensureAuth(); await loadAllConfigs(); await refreshCaches();
        const rest = new REST({ version: '10' }).setToken(TOKEN);
        try {
            for (const [gid] of client.guilds.cache) { try { await rest.put(Routes.applicationGuildCommands(CLIENT_ID, gid), { body: commandsData }); } catch (e) {} }
            await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commandsData });
        } catch (e) {}
        await updateEvents(null, true, true); setInterval(updateEvents, CHECK_INTERVAL);
    })();
});

process.on('unhandledRejection', e => console.error('⚠️ Unhandled rejection:', e.message));
client.login(TOKEN).catch(console.error);
