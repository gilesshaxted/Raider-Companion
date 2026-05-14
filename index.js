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

const requiredEnvVars = ['FIREBASE_API_KEY', 'FIREBASE_AUTH_DOMAIN', 'FIREBASE_PROJECT_ID', 'FIREBASE_STORAGE_BUCKET', 'FIREBASE_MESSAGING_SENDER_ID', 'FIREBASE_APP_ID', 'DISCORD_TOKEN', 'CLIENT_ID'];
const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingVars.length > 0) {
    console.error('❌ CRITICAL ERROR: Missing required Environment Variables:');
    missingVars.forEach(v => console.error(`   - ${v}`));
    process.exit(1); 
}

const PORT = process.env.PORT || 8000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is running\n');
}).listen(PORT, () => console.log(`Health check server listening on port ${PORT}`));

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

const rarityColors = { 'Common': 0x95a5a6, 'Uncommon': 0x2ecc71, 'Rare': 0x3498db, 'Epic': 0x9b59b6, 'Legendary': 0xf1c40f };
const eventEmojis = { 'Night Raid': '🌙', 'Prospecting Probes': '📡', 'Matriarch': '👑', 'Bird City': '🐦', 'Hidden Bunker': '🏢', 'Cold Snap': '❄️', 'Harvester': '🚜', 'Electromagnetic Storm': '⚡', 'Lush Blooms': '🌸', 'Locked Gate': '🔒', 'Launch Tower Loot': '🚀', 'Uncovered Caches': '📦' };
const notificationTimes = [{ label: '3 Hours', value: '10800000' }, { label: '2 Hours', value: '7200000' }, { label: '1 Hour', value: '3600000' }, { label: '45 Minutes', value: '2700000' }, { label: '30 Minutes', value: '1800000' }, { label: '15 Minutes', value: '900000' }];

const getEmoji = (name) => eventEmojis[name] || '🛸';

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildScheduledEvents, GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.GuildMembers, GatewayIntentBits.DirectMessages, GatewayIntentBits.GuildPresences
    ],
    partials: [Partials.Message, Partials.Reaction, Partials.User, Partials.Channel]
});

let arcCache = [], itemCache = [], traderCache = {}, traderItemsFlat = [], traderCategories = [], questCache = [];
let isAuthorized = false, isGlobalUpdating = false;

async function ensureAuth() {
    if (isAuthorized) return true;
    try { await signInAnonymously(auth); isAuthorized = true; return true; } catch (e) { return false; }
}

function getBotConfigDoc(guildId) { return doc(db, 'artifacts', appId, 'public', 'data', 'bot_configs', `${CLIENT_ID}_${guildId}`); }

async function saveGuildConfig(guildId) {
    if (!await ensureAuth()) return;
    const config = guildConfigs.get(guildId);
    if (!config) return;
    try { await setDoc(getBotConfigDoc(guildId), config); } catch (e) { console.error(`Save error: ${guildId}`, e.message); }
}

async function loadAllConfigs() {
    if (!await ensureAuth()) return;
    try {
        const querySnapshot = await getDocs(collection(db, 'artifacts', appId, 'public', 'data', 'bot_configs'));
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
    } catch (e) { console.error("Config load failed:", e.message); }
}

async function getUserSubscriptions(userId) {
    if (!await ensureAuth()) return [];
    try {
        const snap = await getDocs(collection(db, 'artifacts', appId, 'users', userId, 'subscriptions'));
        return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (e) { return []; }
}

async function blacklistGuild(guildId) {
    if (!await ensureAuth()) return;
    await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'blacklist', guildId), { blacklisted_at: Date.now() });
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
        console.log(`[Cache] Success: Loaded ${arcCache.length} ARC, ${itemCache.length} Items.`);
    } catch (e) { console.error("Cache refresh failed:", e.message); }
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

async function updateEvents(targetGuildId = null, forceNewMessages = false, purgeActivePings = false) {
    if (!targetGuildId) { if (isGlobalUpdating) return; isGlobalUpdating = true; }
    try {
        const response = await axios.get(API_URL);
        const events = response.data?.data;
        if (!events || !Array.isArray(events)) { if (!targetGuildId) isGlobalUpdating = false; return; }

        const now = Date.now();
        const alertWindow = now + (60 * 60 * 1000); 
        const scheduleWindow = now + (3 * 60 * 60 * 1000); 

        // GLOBAL DM NOTIFICATIONS
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

                // CLEANUP ALERT PINGS
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

                // DISCORD SCHEDULED EVENTS SYNC
                if (config.scheduledEventsEnabled !== false) {
                    let existingScheduledEvents = [];
                    try { existingScheduledEvents = await guild.scheduledEvents.fetch(); } catch (e) {}
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
                        const finalDesc = `Upcoming rotation on ${first.map}:\n${group.map(ev => `• ${getEmoji(ev.name)} **${ev.name}**`).join('\n')}`;
                        const mapKey = Object.keys(mapConfigs).find(k => k.toLowerCase().replace(/\s/g, '') === first.map?.toLowerCase().replace(/\s/g, ''));
                        const dataURI = mapKey ? getLocalImageAsDataURI(mapConfigs[mapKey].fileName) : null;
                        if (existingEvent) { try { await existingEvent.edit({ name: finalName, description: finalDesc, image: dataURI }); } catch (err) {} }
                        else { try { await guild.scheduledEvents.create({ name: finalName, scheduledStartTime: new Date(first.startTime), scheduledEndTime: new Date(Math.max(...group.map(ev => ev.endTime))), privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly, entityType: GuildScheduledEventEntityType.External, entityMetadata: { location: first.map }, image: dataURI, description: finalDesc }); } catch (err) {} }
                    }
                }

                // EMBED UPDATES
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

                const summary = new EmbedBuilder().setTitle('🛸 ARC Raiders - Live Summary').setColor(0x00AE86).setDescription('React with an emoji below to get notification roles!').setFooter({ text: `Data: metaforge.app/arc-raiders` }).setTimestamp();
                const current = events.filter(e => e.startTime <= now && e.endTime > now);
                if (current.length > 0) summary.addFields({ name: '✅ Active', value: current.map(e => `${getEmoji(e.name)} **${e.name}** (${e.map})`).join('\n') });
                else summary.addFields({ name: '✅ Active', value: 'None.' });
                const summarySent = await syncMessage(channel, config, 'Summary', summary);
                if (summarySent && forceNewMessages) { for (const emoji of Object.values(eventEmojis)) { try { await summarySent.react(emoji); } catch (e) {} } }

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

function generateSetupEmbed(guild, config) {
    return new EmbedBuilder().setTitle(`⚙️ Tactical Setup: ${guild.name}`).setColor(0x5865F2).setThumbnail(guild.iconURL()).setDescription("Configure how Raider Companion operates in this server.").addFields({ name: "📍 Tactical Channel", value: config.channelId ? `<#${config.channelId}>` : "❌ *Not Configured*", inline: true }, { name: "📅 Discord Events", value: config.scheduledEventsEnabled !== false ? "✅ Enabled" : "❌ Disabled", inline: true }, { name: "🔔 Role Pings", value: config.rolePingsEnabled !== false ? "✅ Enabled" : "❌ Disabled", inline: true }).setTimestamp();
}

function generateSetupComponents(config) {
    const channelSelect = new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('setup_channel_select').setPlaceholder('Select tactical channel...').addChannelTypes(ChannelType.GuildText));
    const toggleRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('setup_toggle_events').setLabel(config.scheduledEventsEnabled !== false ? 'Disable Events Tab' : 'Enable Events Tab').setStyle(config.scheduledEventsEnabled !== false ? ButtonStyle.Danger : ButtonStyle.Success), new ButtonBuilder().setCustomId('setup_toggle_pings').setLabel(config.rolePingsEnabled !== false ? 'Disable Role Pings' : 'Enable Role Pings').setStyle(config.rolePingsEnabled !== false ? ButtonStyle.Danger : ButtonStyle.Success), new ButtonBuilder().setCustomId('setup_create_roles').setLabel('Create Roles').setStyle(ButtonStyle.Secondary));
    return [channelSelect, toggleRow];
}

const commandsData = [
    new SlashCommandBuilder().setName('setup').setDescription('Setup tactical channel').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder().setName('update').setDescription('Refresh everything').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder().setName('arc').setDescription('ARC Intel').addStringOption(o => o.setName('unit').setDescription('Unit').setRequired(true).setAutocomplete(true)),
    new SlashCommandBuilder().setName('item').setDescription('Item Search').addStringOption(o => o.setName('name').setDescription('Item').setRequired(true).setAutocomplete(true)),
    new SlashCommandBuilder().setName('traders').setDescription('Trader Inventories').addStringOption(o => o.setName('name').setDescription('Trader/Category').setRequired(true).setAutocomplete(true)),
    new SlashCommandBuilder().setName('quests').setDescription('Quest Logs').addStringOption(o => o.setName('name').setDescription('Quest').setRequired(true).setAutocomplete(true)),
    new SlashCommandBuilder().setName('subscribe').setDescription('Personal DM Alerts'),
    new SlashCommandBuilder().setName('help').setDescription('Help guide'),
    new SlashCommandBuilder().setName('mapdata').setDescription('Inspect raw map data (Owner only)').addStringOption(o => o.setName('map').setDescription('Map choice').setRequired(true).addChoices({ name: 'Dam', value: 'dam' }, { name: 'Spaceport', value: 'spaceport' }, { name: 'Buried City', value: 'buried-city' }, { name: 'Blue Gate', value: 'blue-gate' }))
].map(c => c.toJSON());

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
            let cfg = guildConfigs.get(interaction.guildId) || { activeAlerts: [], alertedEventKeys: [], messageIds: {} };
            cfg.channelId = ch.id;
            guildConfigs.set(interaction.guildId, cfg);
            await saveGuildConfig(interaction.guildId);
            await interaction.update({ embeds: [generateSetupEmbed(interaction.guild, cfg)], components: generateSetupComponents(cfg) });
            await updateEvents(interaction.guildId, true, true);
            return;
        }

        if (!interaction.isChatInputCommand()) return;

        // FIXED: MAPDATA COMMAND WITH AUTOMATIC SCHEMA DETECTION
        if (interaction.commandName === 'mapdata') {
            if (interaction.user.id !== OWNER_ID) return interaction.reply({ content: '❌ Owner only.', flags: [MessageFlags.Ephemeral] });
            const mapID = interaction.options.getString('map');
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            try {
                const res = await axios.get(`https://metaforge.app/api/game-map-data?tableID=arc_map_data&mapID=${mapID}`);
                const rawPayload = res.data;
                // Supports both { data: [...] } and directly returning [...]
                const data = rawPayload?.data || (Array.isArray(rawPayload) ? rawPayload : null);

                if (!data || (Array.isArray(data) && data.length === 0)) {
                    console.log(`[mapdata] Empty response for ${mapID}. Full body:`, JSON.stringify(rawPayload));
                    return interaction.editReply(`⚠️ No data returned for \`${mapID}\`.`);
                }

                const sample = Array.isArray(data) ? data[0] : data;
                const keys = Object.keys(sample);
                const schemaEmbed = new EmbedBuilder().setTitle(`🗺️ Map Data: ${mapID}`).setColor(0x5865F2).setDescription(`**Total records:** ${Array.isArray(data) ? data.length : 1}\n**Fields:** \`${keys.join(', ')}\``).setTimestamp();
                
                const sampleRecords = (Array.isArray(data) ? data.slice(0, 3) : [data]);
                sampleRecords.forEach((record, i) => {
                    const lines = keys.map(k => `${k}: ${String(record[k]).substring(0, 50)}`).join('\n');
                    schemaEmbed.addFields({ name: `📄 Sample #${i + 1}`, value: `\`\`\`\n${lines}\`\`\`` });
                });

                const attachment = new AttachmentBuilder(Buffer.from(JSON.stringify(data, null, 2), 'utf-8'), { name: `mapdata_${mapID}.json` });
                await interaction.editReply({ embeds: [schemaEmbed], files: [attachment] });
            } catch (err) { await interaction.editReply(`❌ API error: \`${err.message}\``); }
        }

        // STANDARD COMMANDS
        if (interaction.commandName === 'arc') {
            const arc = arcCache.find(a => a.id === interaction.options.getString('unit'));
            if (!arc) return interaction.reply({ content: "❌ Not found.", flags: [MessageFlags.Ephemeral] });
            await interaction.reply({ embeds: [new EmbedBuilder().setTitle(`🤖 Intel: ${arc.name}`).setDescription(arc.description).setColor(0x5865F2).setThumbnail(arc.icon).setImage(arc.image)] });
        }

        if (interaction.commandName === 'setup') {
            const cfg = guildConfigs.get(interaction.guildId) || { channelId: null };
            await interaction.reply({ embeds: [generateSetupEmbed(interaction.guild, cfg)], components: generateSetupComponents(cfg), flags: [MessageFlags.Ephemeral] });
        }
        
        if (interaction.commandName === 'update') {
            await interaction.reply({ content: '🔄 Refreshing...', flags: [MessageFlags.Ephemeral] });
            await updateEvents(interaction.guildId, true, true);
        }

    } catch (err) { console.error('❌ Interaction Error:', err.message); }
});

client.once(Events.ClientReady, async () => {
    console.log(`[Startup] Logged in as ${client.user.tag}`);
    client.user.setActivity('metaforge.app/arc-raiders', { type: ActivityType.Listening });

    (async () => {
        await ensureAuth(); 
        await loadAllConfigs(); 
        await refreshCaches();

        const rest = new REST({ version: '10' }).setToken(TOKEN);
        try {
            // FIXED: ONLY REGISTER GLOBALLY TO PREVENT DUPLICATES
            console.log('[Startup] Registering commands globally...');
            await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commandsData });
            console.log('[Startup] Global commands registered successfully.');
        } catch (e) { console.error('[Startup] Failed to register commands:', e.message); }

        await updateEvents(null, true, true); 
        setInterval(updateEvents, CHECK_INTERVAL);
    })();
});

process.on('unhandledRejection', e => console.error('⚠️ Unhandled rejection:', e.message));
client.login(TOKEN).catch(console.error);
