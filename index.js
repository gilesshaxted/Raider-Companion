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
                // Defaults for new flags
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
        for (const [traderName, items] of Object.entries(traderCache)) {
            items.forEach(item => { traderItemsFlat.push({ ...item, traderName }); });
        }
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

                // 2. DISCORD SCHEDULED EVENTS SYNC (If Enabled)
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
                        else {
                            try { await guild.scheduledEvents.create({ name: finalName, scheduledStartTime: new Date(first.startTime), scheduledEndTime: new Date(Math.max(...group.map(ev => ev.endTime))), privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly, entityType: GuildScheduledEventEntityType.External, entityMetadata: { location: first.map }, image: dataURI, description: finalDesc }); } catch (err) {}
                        }
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

                // 5. ROLE PINGS (SENT LAST & If Enabled)
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
                            if (config.alertedEventKeys.length > 100) config.alertedEventKeys = config.alertedEventKeys.slice(-100);
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

// --- SETUP HELPERS ---
function generateSetupEmbed(guild, config) {
    return new EmbedBuilder()
        .setTitle(`⚙️ Tactical Setup: ${guild.name}`)
        .setColor(0x5865F2)
        .setThumbnail(guild.iconURL())
        .setDescription("Configure how Raider Companion operates in this server.")
        .addFields(
            { name: "📍 Tactical Channel", value: config.channelId ? `<#${config.channelId}>` : "❌ *Not Configured*", inline: true },
            { name: "📅 Discord Events", value: config.scheduledEventsEnabled !== false ? "✅ Enabled" : "❌ Disabled", inline: true },
            { name: "🔔 Role Pings", value: config.rolePingsEnabled !== false ? "✅ Enabled" : "❌ Disabled", inline: true }
        )
        .setFooter({ text: "Use the menu and buttons below to adjust settings." })
        .setTimestamp();
}

function generateSetupComponents(config) {
    const channelSelect = new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder()
            .setCustomId('setup_channel_select')
            .setPlaceholder('Select tactical channel...')
            .addChannelTypes(ChannelType.GuildText)
    );

    const toggleRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('setup_toggle_events')
            .setLabel(config.scheduledEventsEnabled !== false ? 'Disable Events Tab' : 'Enable Events Tab')
            .setStyle(config.scheduledEventsEnabled !== false ? ButtonStyle.Danger : ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId('setup_toggle_pings')
            .setLabel(config.rolePingsEnabled !== false ? 'Disable Role Pings' : 'Enable Role Pings')
            .setStyle(config.rolePingsEnabled !== false ? ButtonStyle.Danger : ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId('setup_create_roles')
            .setLabel('Create Rotation Roles')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('🎭')
    );

    return [channelSelect, toggleRow];
}

// --- PAGINATED HELP DATA ---
const helpPages = [
    {
        title: "🛸 Raider Companion - Overview",
        description: "Welcome Raider! I provide real-time intelligence for **ARC Raiders** operations. Stay informed about event rotations, item data, and trader inventories.",
        fields: [
            { name: "🤖 intelligence", value: "`/arc [unit]` - Technical data on ARC units.\n`/item [name]` - Search for weapons, materials, and stats.\n`/traders [name]` - View current inventory and pricing.\n`/quests [name]` - Mission objectives and rewards." },
            { name: "📜 Tips", value: "Use the **Live Summary** in your tracking channel to react for notification roles!" }
        ]
    },
    {
        title: "🔔 Personal Alerts (DMs)",
        description: "Never miss a rotation again. You can configure personal DM notifications for specific events.",
        fields: [
            { name: "Commands", value: "`/subscribe` - Manage your personal alerts.\n`/test-dm` - (Developer Only) Diagnostic check for your schedule." },
            { name: "How it works", value: "1. Run `/subscribe`.\n2. Pick a Map and a Rotation type.\n3. Select lead times (e.g. 1 hour and 15 mins).\n4. I will DM you exactly at those times before the event starts!" }
        ]
    },
    {
        title: "🛠️ Server Administration",
        description: "Tools for Discord staff to manage raider companion within their server.",
        fields: [
            { name: "Setup", value: "`/setup` - Open the tactical configuration dashboard." },
            { name: "Maintenance", value: "`/update` - Forces a full purge and repost of all intel embeds and notification pings to ensure everything is current." }
        ]
    },
    {
        title: "🔗 Sources & Attribution",
        description: "Intelligence data is provided by the **Metaforge** database.",
        fields: [
            { name: "Database", value: "[metaforge.app/arc-raiders](https://metaforge.app/arc-raiders)" },
            { name: "Support", value: "If you have issues with notifications, ensure your DMs are open and try running `/subscribe` to refresh your profile." }
        ]
    }
];

function generateHelpEmbed(pageIndex) {
    const data = helpPages[pageIndex];
    const embed = new EmbedBuilder()
        .setTitle(data.title)
        .setDescription(data.description)
        .setColor(0x5865F2)
        .setFooter({ text: `Page ${pageIndex + 1} of ${helpPages.length}` })
        .setTimestamp();
    if (data.fields) embed.addFields(data.fields);
    return embed;
}

function generateHelpComponents(pageIndex) {
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`help_prev_${pageIndex}`)
            .setLabel('Previous')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(pageIndex === 0),
        new ButtonBuilder()
            .setCustomId(`help_next_${pageIndex}`)
            .setLabel('Next')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(pageIndex === helpPages.length - 1)
    );
    return [row];
}

const commandsData = [
    new SlashCommandBuilder().setName('setup').setDescription('Open the tactical configuration dashboard').setDefaultMemberPermissions(PermissionFlagsBits.Administrator).toJSON(),
    new SlashCommandBuilder().setName('update').setDescription('Force refresh all embeds/pings').setDefaultMemberPermissions(PermissionFlagsBits.Administrator).toJSON(),
    new SlashCommandBuilder().setName('arc').setDescription('ARC Intel').addStringOption(o => o.setName('unit').setDescription('Unit').setRequired(true).setAutocomplete(true)).toJSON(),
    new SlashCommandBuilder().setName('item').setDescription('Item Search').addStringOption(o => o.setName('name').setDescription('Item').setRequired(true).setAutocomplete(true)).toJSON(),
    new SlashCommandBuilder().setName('traders').setDescription('Trader Inventories').addStringOption(o => o.setName('name').setDescription('Trader/Category').setRequired(true).setAutocomplete(true)).toJSON(),
    new SlashCommandBuilder().setName('quests').setDescription('Quest Logs').addStringOption(o => o.setName('name').setDescription('Quest').setRequired(true).setAutocomplete(true)).toJSON(),
    new SlashCommandBuilder().setName('subscribe').setDescription('Manage personal DM Alerts').toJSON(),
    new SlashCommandBuilder().setName('test-dm').setDescription('Verify alerts (Owner Only)').toJSON(),
    new SlashCommandBuilder().setName('help').setDescription('View guide on how to use Raider Companion').toJSON(),
    new SlashCommandBuilder().setName('servers').setDescription('Manage bot servers (Owner Only)').toJSON()
];

client.on('interactionCreate', async interaction => {
    try {
        if (interaction.isAutocomplete()) {
            const f = interaction.options.getFocused().toLowerCase();
            if (interaction.commandName === 'arc') await interaction.respond(arcCache.filter(a => a.name.toLowerCase().includes(f)).slice(0, 25).map(a => ({ name: a.name, value: a.id })));
            if (interaction.commandName === 'item') await interaction.respond(itemCache.filter(i => i.name.toLowerCase().includes(f)).slice(0, 25).map(i => ({ name: i.name, value: i.id })));
            if (interaction.commandName === 'traders') await interaction.respond(Object.keys(traderCache).filter(n => n.toLowerCase().includes(f)).slice(0, 25).map(n => ({ name: `👤 ${n}`, value: `trader:${n}` })));
            if (interaction.commandName === 'quests') await interaction.respond(questCache.filter(q => q.name.toLowerCase().includes(f)).slice(0, 25).map(q => ({ name: q.name, value: q.id })));
            return;
        }

        if (interaction.isChannelSelectMenu()) {
            if (interaction.customId === 'setup_channel_select') {
                const channel = interaction.channels.first();
                const guildId = interaction.guildId;
                let config = guildConfigs.get(guildId) || { activeAlerts: [], alertedEventKeys: [], messageIds: { 'Dam': null, 'Buried City': null, 'Blue Gate': null, 'Spaceport': null, 'Stella Montis': null, 'Summary': null } };
                config.channelId = channel.id;
                guildConfigs.set(guildId, config);
                await saveGuildConfig(guildId);
                await interaction.update({ embeds: [generateSetupEmbed(interaction.guild, config)], components: generateSetupComponents(config) });
                await updateEvents(guildId, true, true);
            }
            return;
        }

        if (interaction.isStringSelectMenu()) {
            if (interaction.customId === 'trader_item_select') {
                const i = traderItemsFlat.find(it => it.id === interaction.values[0]);
                if (i) await interaction.reply({ embeds: [buildTraderItemEmbed(i)], flags: [MessageFlags.Ephemeral] });
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
                const numericOffsets = interaction.values.map(Number);
                const subId = `${map}_${event}`.toLowerCase().replace(/\s/g, '_');
                await setDoc(doc(db, 'artifacts', appId, 'users', interaction.user.id, 'subscriptions', subId), { map, event, offsets: numericOffsets, created_at: Date.now() });
                await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'subscription_users', interaction.user.id), { active: true });
                await interaction.update({ content: `✅ **Active!** DMs set for **${event}** on **${map}**.`, components: [] });
            }
            if (interaction.customId === 'server_mgmt_select') {
                if (interaction.user.id !== OWNER_ID) return;
                const guild = await client.guilds.fetch(interaction.values[0]).catch(() => null);
                if (!guild) return interaction.reply({ content: "❌ Server not accessible.", flags: [MessageFlags.Ephemeral] });
                const owner = await guild.fetchOwner().catch(() => null);
                const botJoinedAt = guild.members.me?.joinedTimestamp;
                const activeMembers = guild.members.cache.filter(m => m.presence && m.presence.status !== 'offline').size;
                const embed = new EmbedBuilder().setTitle(`🛡️ Server Intelligence: ${guild.name}`).setThumbnail(guild.iconURL({ dynamic: true })).setColor(0x5865F2).addFields({ name: '👤 Owner', value: `${owner?.user.tag || "Unknown"} (\`${owner?.id || "N/A"}\`)`, inline: true }, { name: '🆔 Server ID', value: `\`${guild.id}\``, inline: true }, { name: '📅 Bot Joined', value: botJoinedAt ? `<t:${Math.floor(botJoinedAt / 1000)}:f> (<t:${Math.floor(botJoinedAt / 1000)}:R>)` : "Unknown", inline: false }, { name: '👥 Member Count', value: `Total: **${guild.memberCount.toLocaleString()}**\nActive: **${activeMembers.toLocaleString()}**`, inline: true }).setTimestamp();
                const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`srv_invite_${guild.id}`).setLabel('Create Invite').setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId(`srv_dm_${owner?.id || guild.id}`).setLabel('DM Owner').setStyle(ButtonStyle.Secondary), new ButtonBuilder().setCustomId(`srv_leave_${guild.id}`).setLabel('Leave Server').setStyle(ButtonStyle.Danger), new ButtonBuilder().setCustomId(`srv_block_${guild.id}`).setLabel('Block/Blacklist').setStyle(ButtonStyle.Danger));
                await interaction.reply({ embeds: [embed], components: [row], flags: [MessageFlags.Ephemeral] });
            }
            return;
        }

        if (interaction.isButton()) {
            if (interaction.customId === 'setup_toggle_events') {
                const guildId = interaction.guildId;
                let config = guildConfigs.get(guildId);
                config.scheduledEventsEnabled = config.scheduledEventsEnabled === false ? true : false;
                guildConfigs.set(guildId, config);
                await saveGuildConfig(guildId);
                await interaction.update({ embeds: [generateSetupEmbed(interaction.guild, config)], components: generateSetupComponents(config) });
            }
            if (interaction.customId === 'setup_toggle_pings') {
                const guildId = interaction.guildId;
                let config = guildConfigs.get(guildId);
                config.rolePingsEnabled = config.rolePingsEnabled === false ? true : false;
                guildConfigs.set(guildId, config);
                await saveGuildConfig(guildId);
                await interaction.update({ embeds: [generateSetupEmbed(interaction.guild, config)], components: generateSetupComponents(config) });
            }
            if (interaction.customId === 'setup_create_roles') {
                await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
                for (const eventName of Object.keys(eventEmojis)) { await getOrCreateEventRole(interaction.guild, eventName); }
                await interaction.editReply({ content: "✅ All rotation roles created/verified." });
            }
            if (interaction.customId === 'sub_create_start') {
                const opts = Object.keys(mapConfigs).map(m => ({ label: m, value: m }));
                await interaction.reply({ content: "📝 **New Alert**\nPick map:", components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('sub_create_map').setPlaceholder('Pick...').addOptions(opts))], flags: [MessageFlags.Ephemeral] });
            }
            if (interaction.customId.startsWith('help_')) {
                const [, action, current] = interaction.customId.split('_');
                const nextIndex = action === 'next' ? parseInt(current) + 1 : parseInt(current) - 1;
                await interaction.update({ embeds: [generateHelpEmbed(nextIndex)], components: generateHelpComponents(nextIndex) });
            }
            if (interaction.customId.startsWith('srv_')) {
                if (interaction.user.id !== OWNER_ID) return;
                const [, action, targetId] = interaction.customId.split('_');
                if (action === 'invite') {
                    const g = await client.guilds.fetch(targetId);
                    const c = g.channels.cache.find(ch => ch.isTextBased() && ch.permissionsFor(client.user).has('CreateInstantInvite'));
                    const inv = await c?.createInvite();
                    await interaction.reply({ content: inv?.url || "Could not create invite.", flags: [MessageFlags.Ephemeral] });
                }
                if (action === 'leave') {
                    const g = await client.guilds.fetch(targetId);
                    await g.leave();
                    await interaction.reply({ content: `✅ Left ${g.name}`, flags: [MessageFlags.Ephemeral] });
                }
                if (action === 'block') {
                    await blacklistGuild(targetId);
                    const g = await client.guilds.fetch(targetId).catch(() => null);
                    if (g) await g.leave();
                    await interaction.reply({ content: `🚫 Blacklisted ${targetId}`, flags: [MessageFlags.Ephemeral] });
                }
                if (action === 'dm') {
                    const modal = new ModalBuilder().setCustomId(`srv_modal_dm_${targetId}`).setTitle('Message Owner');
                    modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('dm_text').setLabel('Content').setStyle(TextInputStyle.Paragraph)));
                    await interaction.showModal(modal);
                }
            }
            return;
        }

        if (interaction.isModalSubmit() && interaction.customId.startsWith('srv_modal_dm_')) {
            const u = await client.users.fetch(interaction.customId.replace('srv_modal_dm_', '')).catch(() => null);
            if (u) await u.send(`**Dev Message:** ${interaction.fields.getTextInputValue('dm_text')}`).catch(() => {});
            await interaction.reply({ content: "✅ Sent.", flags: [MessageFlags.Ephemeral] });
        }

        if (!interaction.isChatInputCommand()) return;

        if (interaction.commandName === 'servers') {
            if (interaction.user.id !== OWNER_ID) return interaction.reply({ content: "❌ Unauthorized.", flags: [MessageFlags.Ephemeral] });
            const guilds = client.guilds.cache.map(g => ({ label: g.name.substring(0, 25), value: g.id }));
            if (guilds.length === 0) return interaction.reply({ content: "No servers.", flags: [MessageFlags.Ephemeral] });
            await interaction.reply({ content: "👤 **Management Console**", components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('server_mgmt_select').setPlaceholder('Select...').addOptions(guilds.slice(0, 25)))], flags: [MessageFlags.Ephemeral] });
        }

        if (interaction.commandName === 'setup') {
            const config = guildConfigs.get(interaction.guildId) || { channelId: null, scheduledEventsEnabled: true, rolePingsEnabled: true };
            await interaction.reply({ embeds: [generateSetupEmbed(interaction.guild, config)], components: generateSetupComponents(config), flags: [MessageFlags.Ephemeral] });
        }

        if (interaction.commandName === 'help') {
            await interaction.reply({ embeds: [generateHelpEmbed(0)], components: generateHelpComponents(0), flags: [MessageFlags.Ephemeral] });
        }

        if (interaction.commandName === 'test-dm') {
            if (interaction.user.id !== OWNER_ID) return interaction.reply({ content: "❌ Unauthorized.", flags: [MessageFlags.Ephemeral] });
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] }).catch(() => {});
            const subs = await getUserSubscriptions(interaction.user.id);
            if (subs.length === 0) return interaction.editReply({ content: "❌ No alerts." }).catch(() => {});
            try {
                const res = await axios.get(API_URL);
                const evs = res.data?.data || [];
                const now = Date.now();
                const embed = new EmbedBuilder().setTitle("🧪 Alert Diagnostic").setColor(0x3498db);
                let desc = `Verification for: **${interaction.user.tag}**.\n\n`;
                for (const s of subs) {
                    const m = evs.find(e => e.map?.toLowerCase().trim() === s.map?.toLowerCase().trim() && e.name?.toLowerCase().trim() === s.event?.toLowerCase().trim() && e.startTime > now);
                    desc += `📡 **Sub:** ${getEmoji(s.event)} ${s.event} on ${s.map}\n`;
                    if (m) {
                        desc += `└ 🟢 **Upcoming:** <t:${Math.floor(m.startTime/1000)}:F>\n`;
                        s.offsets.forEach(o => {
                            const t = m.startTime - Number(o);
                            if (t > now) desc += `   └ 🔔 **Next Alert:** <t:${Math.floor(t/1000)}:R>\n`;
                            else desc += `   └ ⚪ **Alert Passed**\n`;
                        });
                    } else desc += `└ ⚪ **No matching events found** in schedule.\n`;
                }
                embed.setDescription(desc);
                await interaction.user.send({ embeds: [embed] });
                await interaction.editReply({ content: "✅ Diagnostic DM sent!" });
            } catch (e) { await interaction.editReply({ content: `❌ Failed: ${e.message}` }); }
        }

        if (interaction.commandName === 'subscribe') {
            const subs = await getUserSubscriptions(interaction.user.id);
            const embed = new EmbedBuilder().setTitle('🔔 DM Subscriptions').setColor(0x5865F2).setDescription('Manage personal rotation alerts.');
            if (subs.length > 0) {
                const list = subs.map(s => `• ${getEmoji(s.event)} ${s.event} on ${s.map}\n└ Alerts: ${s.offsets.map(o => notificationTimes.find(t => t.value === String(o))?.label).join(', ')}`).join('\n\n');
                embed.addFields({ name: 'Active Alerts', value: list });
                const sel = new StringSelectMenuBuilder().setCustomId('sub_delete_select').setPlaceholder('Delete alert...').addOptions(subs.map(s => ({ label: `${s.event || 'Unknown'} on ${s.map || 'Unknown'}`, value: s.id })));
                await interaction.reply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('sub_create_start').setLabel('Add Alert').setStyle(ButtonStyle.Success)), new ActionRowBuilder().addComponents(sel)], flags: [MessageFlags.Ephemeral] });
            } else {
                embed.addFields({ name: 'Status', value: 'No alerts.' });
                await interaction.reply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('sub_create_start').setLabel('Add Alert').setStyle(ButtonStyle.Success))], flags: [MessageFlags.Ephemeral] });
            }
        }

        if (interaction.commandName === 'update') {
            await interaction.reply({ content: '🔄 Refreshing all data, embeds, and active pings...', flags: [MessageFlags.Ephemeral] });
            await updateEvents(interaction.guildId, true, true); 
        }
    } catch (fatal) { console.error('❌ Interaction Error:', fatal.message); }
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
        await updateEvents(null, true, true); 
        setInterval(updateEvents, CHECK_INTERVAL);
    })();
});

process.on('unhandledRejection', error => { console.error('⚠️ Unhandled rejection:', error.message); });
client.login(TOKEN).catch(console.error);
