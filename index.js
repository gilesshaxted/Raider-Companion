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
const { getFirestore, doc, getDoc, setDoc, collection, getDocs, deleteDoc } = require('firebase/firestore');
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
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
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

const getEmoji = (name) => eventEmojis[name] || '🛸';

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildScheduledEvents,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.DirectMessages 
    ],
    partials: [
        Partials.Message, 
        Partials.Reaction, 
        Partials.User,
        Partials.Channel 
    ]
});

let arcCache = [], itemCache = [], traderCache = {}, traderItemsFlat = [], traderCategories = [], questCache = [];
let isAuthorized = false, isGlobalUpdating = false;

// --- PERSISTENCE HELPERS ---
async function ensureAuth() {
    if (isAuthorized) return true;
    try {
        console.log('Firebase: Attempting anonymous authentication...');
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
                guildConfigs.set(guildId, data);
            }
        });
    } catch (e) { console.error("❌ Error loading configs:", e.message); }
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
        console.log('API: Refreshing data caches...');
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
        console.log('API: Caches refreshed.');
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
async function updateEvents(targetGuildId = null, forceNewMessages = false) {
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

        const guildsToUpdate = targetGuildId 
            ? [[targetGuildId, guildConfigs.get(targetGuildId)]] 
            : Array.from(guildConfigs.entries());

        for (const [guildId, config] of guildsToUpdate) {
            if (!config || !config.channelId) continue;
            if (activeGuildUpdates.has(guildId)) continue;
            activeGuildUpdates.add(guildId);

            try {
                let channel;
                try { channel = await client.channels.fetch(config.channelId); } catch (err) { continue; }
                if (!channel) continue;
                const guild = channel.guild;

                // 1. Cleanup expired chat pings
                if (config.activeAlerts && config.activeAlerts.length > 0) {
                    const freshAlerts = [];
                    for (const alert of config.activeAlerts) {
                        if (now >= alert.startTime) {
                            try { const msg = await channel.messages.fetch(alert.messageId); await msg.delete(); } catch (err) {}
                        } else { freshAlerts.push(alert); }
                    }
                    config.activeAlerts = freshAlerts;
                }

                // 2. DISCORD SCHEDULED EVENTS: GROUPED LOGIC
                let existingScheduledEvents = [];
                try { existingScheduledEvents = await guild.scheduledEvents.fetch(); } catch (e) {}

                // Initial cleanup of standard duplicates
                const seenSlots = new Set();
                for (const se of existingScheduledEvents.values()) {
                    const key = `${se.scheduledStartTimestamp}_${se.entityMetadata?.location}`;
                    if (seenSlots.has(key)) {
                        try { await se.delete(); } catch (e) {}
                    } else { seenSlots.add(key); }
                }

                const scorableEvents = events.filter(e => e.startTime > now && e.startTime <= scheduleWindow);
                
                // Group overlapping events by Map + StartTime
                const groupedEvents = {};
                scorableEvents.forEach(e => {
                    const groupKey = `${e.map}_${e.startTime}`;
                    if (!groupedEvents[groupKey]) groupedEvents[groupKey] = [];
                    groupedEvents[groupKey].push(e);
                });

                for (const groupKey in groupedEvents) {
                    const group = groupedEvents[groupKey];
                    const first = group[0];

                    const alreadyScheduled = existingScheduledEvents.some(se => {
                        const sameLocation = se.entityMetadata?.location === first.map;
                        const sameTimeWindow = Math.abs(se.scheduledStartTimestamp - first.startTime) < 120000;
                        return sameLocation && sameTimeWindow;
                    });

                    if (!alreadyScheduled) {
                        try {
                            // Build combined title: "Emoji Name & Emoji Name (Map)"
                            const combinedTitle = group.map(ev => `${getEmoji(ev.name)} ${ev.name}`).join(' & ');
                            const finalName = `${combinedTitle} (${first.map})`.substring(0, 100);

                            const mapKey = Object.keys(mapConfigs).find(k => k.toLowerCase().replace(/\s/g, '') === first.map?.toLowerCase().replace(/\s/g, ''));
                            const dataURI = mapKey ? getLocalImageAsDataURI(mapConfigs[mapKey].fileName) : null;

                            await guild.scheduledEvents.create({
                                name: finalName,
                                scheduledStartTime: new Date(first.startTime),
                                scheduledEndTime: new Date(Math.max(...group.map(ev => ev.endTime))),
                                privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
                                entityType: GuildScheduledEventEntityType.External,
                                entityMetadata: { location: first.map },
                                image: dataURI, 
                                description: `Upcoming rotation group on ${first.map}:\n${group.map(ev => `• ${getEmoji(ev.name)} **${ev.name}**`).join('\n')}`
                            });
                        } catch (err) { console.error(`❌ Multi-Event Create Error:`, err.message); }
                    }
                    
                    // 3. INDIVIDUAL CHANNEL PING LOGIC (Keep individual for role pings)
                    for (const e of group) {
                        const alertKey = `${e.name}_${e.map}_${e.startTime}`;
                        if (e.startTime <= alertWindow && !config.alertedEventKeys.includes(alertKey)) {
                            const role = await getOrCreateEventRole(guild, e.name);
                            const roleMention = role ? `<@&${role.id}>` : `**${e.name}**`;
                            const alertSent = await channel.send({
                                content: `⚠️ **Upcoming Event:** ${getEmoji(e.name)} ${roleMention} on **${e.map}** starts <t:${Math.floor(e.startTime / 1000)}:R>!`
                            });
                            config.activeAlerts.push({ messageId: alertSent.id, startTime: e.startTime });
                            config.alertedEventKeys.push(alertKey);
                            if (config.alertedEventKeys.length > 100) config.alertedEventKeys = config.alertedEventKeys.slice(-100);
                        }
                    }
                }

                // 4. MAP EMBEDS & SUMMARY
                if (forceNewMessages) {
                    for (const key in config.messageIds) {
                        if (config.messageIds[key]) {
                            try { const m = await channel.messages.fetch(config.messageIds[key]); await m.delete(); } catch (e) {}
                            config.messageIds[key] = null;
                        }
                    }
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
                        const liveText = activeEvents.map(ev => `🟢 **LIVE:** ${getEmoji(ev.name)} **${ev.name}** (Ends <t:${Math.floor(ev.endTime / 1000)}:R>)`).join('\n');
                        embed.addFields({ name: '📡 Status', value: liveText });
                        if (activeEvents[0].icon) embed.setThumbnail(activeEvents[0].icon);
                    } else { embed.addFields({ name: '📡 Status', value: '⚪ **Offline**' }); }

                    upcoming.forEach((e, i) => { embed.addFields({ name: `Next Up #${i + 1}`, value: `${getEmoji(e.name)} **${e.name}**\n<t:${Math.floor(e.startTime / 1000)}:R>`, inline: true }); });
                    await syncMessageWithFile(channel, config, mapName, embed, file);
                }

                const current = events.filter(e => e.startTime <= now && e.endTime > now);
                const summary = new EmbedBuilder().setTitle('🛸 ARC Raiders - Live Summary').setColor(0x00AE86).setDescription('React to this message with an emoji below to get the notification role!').setFooter({ text: `Data provided by metaforge.app/arc-raiders` }).setTimestamp();
                if (current.length > 0) summary.addFields({ name: '✅ Currently Active', value: current.map(e => `${getEmoji(e.name)} **${e.name}**\n└ *${e.map}*\n────────────────`).join('\n') });
                else summary.addFields({ name: '✅ Currently Active', value: 'No events currently active.' });
                const summarySent = await syncMessage(channel, config, 'Summary', summary);
                if (summarySent && forceNewMessages) {
                    for (const emoji of Object.values(eventEmojis)) { try { await summarySent.react(emoji); } catch (e) {} }
                }
                await saveGuildConfig(guildId);
            } finally { activeGuildUpdates.delete(guildId); }
        }
    } catch (error) { console.error('Update loop error:', error.message); } finally { if (!targetGuildId) isGlobalUpdating = false; }
}

async function syncMessage(channel, config, key, embed) {
    if (config.messageIds[key]) {
        try { const msg = await channel.messages.fetch(config.messageIds[key]); return await msg.edit({ embeds: [embed] }); } 
        catch (e) { const sent = await channel.send({ embeds: [embed] }); config.messageIds[key] = sent.id; return sent; }
    } else { const sent = await channel.send({ embeds: [embed] }); config.messageIds[key] = sent.id; return sent; }
}

async function syncMessageWithFile(channel, config, key, embed, file) {
    const files = file ? [file] : [];
    if (config.messageIds[key]) {
        try { const msg = await channel.messages.fetch(config.messageIds[key]); return await msg.edit({ embeds: [embed], files }); } 
        catch (e) { const sent = await channel.send({ embeds: [embed], files }); config.messageIds[key] = sent.id; return sent; }
    } else { const sent = await channel.send({ embeds: [embed], files }); config.messageIds[key] = sent.id; return sent; }
}

function buildTraderItemEmbed(item) {
    return new EmbedBuilder().setTitle(`📦 Trader Item: ${item.name}`).setDescription(item.description || "No description provided.").setColor(rarityColors[item.rarity] || 0x5865F2).setThumbnail(item.icon).addFields({ name: 'Seller', value: `👤 ${item.traderName}`, inline: true }, { name: 'Trader Price', value: `🪙 ${item.trader_price.toLocaleString()}`, inline: true }, { name: 'Base Value', value: `🪙 ${item.value.toLocaleString()}`, inline: true }, { name: 'Rarity', value: item.rarity, inline: true }, { name: 'Category', value: item.item_type, inline: true }).setTimestamp();
}

const commandsData = [
    new SlashCommandBuilder().setName('setup').setDescription('Set the channel for live event updates').addChannelOption(option => option.setName('channel').setDescription('The channel to post in').setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.Administrator).toJSON(),
    new SlashCommandBuilder().setName('update').setDescription('Force a manual update of the live event embeds in this guild').setDefaultMemberPermissions(PermissionFlagsBits.Administrator).toJSON(),
    new SlashCommandBuilder().setName('arc').setDescription('Get intelligence on a specific ARC unit').addStringOption(option => option.setName('unit').setDescription('Pick an ARC unit').setRequired(true).setAutocomplete(true)).toJSON(),
    new SlashCommandBuilder().setName('item').setDescription('Lookup an item, weapon, or material').addStringOption(option => option.setName('name').setDescription('Search for an item').setRequired(true).setAutocomplete(true)).toJSON(),
    new SlashCommandBuilder().setName('traders').setDescription('View trader inventories or find where an item is sold').addStringOption(option => option.setName('name').setDescription('Search for a Trader or Category (e.g. Weapon)').setRequired(true).setAutocomplete(true)).toJSON(),
    new SlashCommandBuilder().setName('quests').setDescription('View detailed objectives and rewards for ARC Raiders quests').addStringOption(option => option.setName('name').setDescription('Search for a quest name').setRequired(true).setAutocomplete(true)).toJSON(),
    new SlashCommandBuilder().setName('servers').setDescription('Manage servers the bot is in (Owner Only)').toJSON()
];

async function handleReaction(reaction, user, add = true) {
    if (user.bot) return;
    if (reaction.partial) { try { await reaction.fetch(); } catch (e) { return; } }
    const guildId = reaction.message.guildId;
    const config = guildConfigs.get(guildId);
    if (!config || reaction.message.id !== config.messageIds.Summary) return;
    const eventName = Object.keys(eventEmojis).find(key => eventEmojis[key] === reaction.emoji.name);
    if (!eventName) return;
    const guild = reaction.message.guild;
    const member = await guild.members.fetch(user.id);
    const role = await getOrCreateEventRole(guild, eventName);
    if (role) { if (add) { await member.roles.add(role).catch(() => {}); } else { await member.roles.remove(role).catch(() => {}); } }
}

client.on('interactionCreate', async interaction => {
    if (interaction.isAutocomplete()) {
        const focusedValue = interaction.options.getFocused().toLowerCase();
        if (interaction.commandName === 'arc') { const choices = arcCache.filter(arc => arc.name.toLowerCase().includes(focusedValue)); await interaction.respond(choices.slice(0, 25).map(arc => ({ name: arc.name, value: arc.id }))); }
        if (interaction.commandName === 'item') { const choices = itemCache.filter(item => item.name.toLowerCase().includes(focusedValue)); await interaction.respond(choices.slice(0, 25).map(item => ({ name: item.name, value: item.id }))); }
        if (interaction.commandName === 'traders') {
            const results = [];
            Object.keys(traderCache).forEach(name => { if (name.toLowerCase().includes(focusedValue)) results.push({ name: `👤 Trader: ${name}`, value: `trader:${name}` }); });
            traderCategories.forEach(cat => { if (cat.toLowerCase().includes(focusedValue)) results.push({ name: `📁 Category: ${cat}`, value: `category:${cat}` }); });
            await interaction.respond(results.slice(0, 25));
        }
        if (interaction.commandName === 'quests') { const choices = questCache.filter(q => q.name.toLowerCase().includes(focusedValue)); await interaction.respond(choices.slice(0, 25).map(q => ({ name: q.name, value: q.id }))); }
        return;
    }

    if (interaction.isStringSelectMenu()) {
        if (interaction.customId === 'trader_item_select') {
            const itemId = interaction.values[0];
            const item = traderItemsFlat.find(i => i.id === itemId);
            if (item) { await interaction.reply({ embeds: [buildTraderItemEmbed(item)], ephemeral: true }); }
        }
        if (interaction.customId === 'server_mgmt_select') {
            if (interaction.user.id !== OWNER_ID) return interaction.reply({ content: "Unauthorized.", flags: [MessageFlags.Ephemeral] });
            const guildId = interaction.values[0];
            const guild = await client.guilds.fetch(guildId).catch(() => null);
            if (!guild) return interaction.reply({ content: "Server no longer accessible.", flags: [MessageFlags.Ephemeral] });
            const owner = await guild.fetchOwner();
            const embed = new EmbedBuilder().setTitle(`🏠 Server Details: ${guild.name}`).setColor(0x5865F2).setThumbnail(guild.iconURL()).addFields({ name: 'ID', value: `\`${guild.id}\``, inline: true }, { name: 'Owner', value: `${owner.user.tag} (\`${owner.id}\`)`, inline: true }, { name: 'Members', value: guild.memberCount.toString(), inline: true }, { name: 'Age', value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:R>`, inline: true });
            const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`srv_invite_${guild.id}`).setLabel('Create Invite').setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId(`srv_dm_${owner.id}`).setLabel('DM Owner').setStyle(ButtonStyle.Secondary), new ButtonBuilder().setCustomId(`srv_leave_${guild.id}`).setLabel('Leave Server').setStyle(ButtonStyle.Danger), new ButtonBuilder().setCustomId(`srv_block_${guild.id}`).setLabel('Block/Blacklist').setStyle(ButtonStyle.Danger));
            await interaction.reply({ embeds: [embed], components: [row], flags: [MessageFlags.Ephemeral] });
        }
        return;
    }

    if (interaction.isButton()) {
        if (interaction.user.id !== OWNER_ID) return interaction.reply({ content: "Unauthorized.", flags: [MessageFlags.Ephemeral] });
        const [prefix, action, targetId] = interaction.customId.split('_');
        if (prefix !== 'srv') return;
        if (action === 'invite') {
            const guild = await client.guilds.fetch(targetId).catch(() => null);
            const channel = guild.channels.cache.find(c => c.isTextBased() && c.permissionsFor(client.user).has('CreateInstantInvite'));
            if (!channel) return interaction.reply({ content: "No permission to create invites.", flags: [MessageFlags.Ephemeral] });
            const invite = await channel.createInvite({ maxAge: 0, maxUses: 1 });
            await interaction.reply({ content: `🔗 Invite created: ${invite.url}`, flags: [MessageFlags.Ephemeral] });
        }
        if (action === 'dm') {
            const modal = new ModalBuilder().setCustomId(`srv_modal_dm_${targetId}`).setTitle('Message User');
            const input = new TextInputBuilder().setCustomId('dm_text').setLabel('Message content').setStyle(TextInputStyle.Paragraph).setRequired(true);
            modal.addComponents(new ActionRowBuilder().addComponents(input));
            await interaction.showModal(modal);
        }
        if (action === 'leave') {
            const guild = await client.guilds.fetch(targetId).catch(() => null);
            await guild.leave();
            await interaction.reply({ content: `✅ Left server: ${guild.name}`, flags: [MessageFlags.Ephemeral] });
        }
        if (action === 'block') {
            const guild = await client.guilds.fetch(targetId).catch(() => null);
            await blacklistGuild(targetId);
            if (guild) await guild.leave().catch(() => {});
            await interaction.reply({ content: `🚫 Server blacklisted and bot has left.`, flags: [MessageFlags.Ephemeral] });
        }
    }

    if (interaction.isModalSubmit()) {
        if (interaction.customId.startsWith('srv_modal_dm_')) {
            const targetUserId = interaction.customId.replace('srv_modal_dm_', '');
            const user = await client.users.fetch(targetUserId);
            const text = interaction.fields.getTextInputValue('dm_text');
            try { await user.send(`**Message from Bot Developer:**\n${text}`); await interaction.reply({ content: `✅ Message sent to ${user.tag}`, flags: [MessageFlags.Ephemeral] }); } 
            catch (e) { await interaction.reply({ content: `❌ Could not DM user.`, flags: [MessageFlags.Ephemeral] }); }
        }
    }

    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName === 'servers') {
        if (interaction.user.id !== OWNER_ID) return interaction.reply({ content: "❌ Developer Only.", flags: [MessageFlags.Ephemeral] });
        const guilds = client.guilds.cache.map(g => ({ label: g.name.substring(0, 25), value: g.id, description: `ID: ${g.id} | ${g.memberCount} members` }));
        const select = new StringSelectMenuBuilder().setCustomId('server_mgmt_select').setPlaceholder('Select server...').addOptions(guilds.slice(0, 25));
        const row = new ActionRowBuilder().addComponents(select);
        await interaction.reply({ content: "👤 **Management Console**", components: [row], flags: [MessageFlags.Ephemeral] });
    }

    if (interaction.commandName === 'setup') {
        const targetChannel = interaction.options.getChannel('channel');
        const guildId = interaction.guildId;
        const newConfig = { channelId: targetChannel.id, activeAlerts: [], alertedEventKeys: [], lastAlertedEventTime: null, messageIds: { 'Dam': null, 'Buried City': null, 'Blue Gate': null, 'Spaceport': null, 'Stella Montis': null, 'Summary': null } };
        guildConfigs.set(guildId, newConfig);
        await interaction.reply({ content: `✅ Setup complete in ${targetChannel}.`, flags: [MessageFlags.Ephemeral] });
        await updateEvents(guildId, true);
    }
    if (interaction.commandName === 'update') {
        const guildId = interaction.guildId;
        if (!guildConfigs.has(guildId)) return interaction.reply({ content: "❌ Run `/setup` first!", flags: [MessageFlags.Ephemeral] });
        await interaction.reply({ content: '🔄 Refreshing intel...', flags: [MessageFlags.Ephemeral] });
        await updateEvents(guildId, true);
    }
    if (interaction.commandName === 'arc') {
        const arc = arcCache.find(a => a.id === interaction.options.getString('unit'));
        if (!arc) return interaction.reply({ content: "❌ Missing Intel.", flags: [MessageFlags.Ephemeral] });
        const embed = new EmbedBuilder().setTitle(`🤖 Intel: ${arc.name}`).setDescription(arc.description).setColor(0x5865F2).setThumbnail(arc.icon).setImage(arc.image).setTimestamp();
        await interaction.reply({ embeds: [embed] });
    }
    if (interaction.commandName === 'item') {
        const item = itemCache.find(i => i.id === interaction.options.getString('name'));
        if (!item) return interaction.reply({ content: "❌ Unknown Item.", flags: [MessageFlags.Ephemeral] });
        const embed = new EmbedBuilder().setTitle(`📦 Item: ${item.name}`).setDescription(item.description || 'No data.').setColor(rarityColors[item.rarity] || 0x5865F2).setThumbnail(item.icon).addFields({ name: 'Rarity', value: item.rarity || 'Common', inline: true }, { name: 'Type', value: item.item_type || 'Unknown', inline: true }, { name: 'Value', value: `🪙 ${item.value?.toLocaleString() || 0}`, inline: true });
        if (item.workbench) embed.addFields({ name: 'Workbench', value: `🛠️ ${item.workbench}`, inline: true });
        if (item.loot_area) embed.addFields({ name: 'Loot Area', value: `📍 ${item.loot_area}`, inline: true });
        if (item.stat_block) {
            const stats = Object.entries(item.stat_block).filter(([_, v]) => v !== 0 && v !== null && v !== "").map(([k, v]) => `• **${k.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase())}:** ${v}`).join('\n');
            if (stats) embed.addFields({ name: '📊 Stats', value: stats });
        }
        await interaction.reply({ embeds: [embed] });
    }
    if (interaction.commandName === 'traders') {
        const selection = interaction.options.getString('name');
        if (selection.startsWith('category:')) {
            const catName = selection.split(':')[1];
            const items = traderItemsFlat.filter(i => i.item_type === catName);
            if (items.length === 0) return interaction.reply({ content: "❌ No items.", flags: [MessageFlags.Ephemeral] });
            const list = items.map(i => `• **${i.name}** (${i.traderName})`).join('\n');
            const embed = new EmbedBuilder().setTitle(`📁 ${catName}`).setDescription(list).setColor(0x3498db);
            const select = new StringSelectMenuBuilder().setCustomId('trader_item_select').setPlaceholder('Select...').addOptions(items.slice(0, 25).map(i => ({ label: i.name, value: i.id })));
            const row = new ActionRowBuilder().addComponents(select);
            await interaction.reply({ embeds: [embed], components: [row] });
        } else if (selection.startsWith('trader:')) {
            const traderName = selection.split(':')[1];
            const items = traderCache[traderName];
            if (!items) return interaction.reply({ content: "❌ Missing Trader.", flags: [MessageFlags.Ephemeral] });
            const list = items.map(i => `• **${i.name}**\n└ 🪙 ${i.trader_price.toLocaleString()}`).join('\n');
            const embed = new EmbedBuilder().setTitle(`👤 ${traderName}`).setDescription(list || 'Empty.').setColor(0x00AE86);
            const select = new StringSelectMenuBuilder().setCustomId('trader_item_select').setPlaceholder(`Select...`).addOptions(items.slice(0, 25).map(i => ({ label: i.name, value: i.id })));
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
            if (!quest) return interaction.editReply("❌ Missing quest data.");
            const embed = new EmbedBuilder().setTitle(`📜 Quest: ${quest.name}`).setColor(0x3498db).setThumbnail(quest.image).setTimestamp();
            if (quest.trader_name) embed.addFields({ name: 'Giver', value: quest.trader_name, inline: true });
            if (quest.xp > 0) embed.addFields({ name: 'XP', value: `\`${quest.xp.toLocaleString()}\``, inline: true });
            if (quest.objectives?.length > 0) embed.addFields({ name: 'Objectives', value: quest.objectives.map(o => `• ${o}`).join('\n') });
            let rewards = "";
            if (quest.granted_items?.length > 0) rewards += quest.granted_items.map(r => `✅ **${r.quantity}x** ${r.item.name}`).join('\n') + '\n';
            if (quest.rewards?.length > 0) rewards += quest.rewards.map(r => `🎁 **${r.quantity}x** ${r.item.name}`).join('\n');
            if (rewards) embed.addFields({ name: 'Rewards', value: rewards });
            if (quest.guide_links?.length > 0) embed.addFields({ name: 'Guides', value: quest.guide_links.map(l => `[${l.label}](${l.url})`).join('\n') });
            await interaction.editReply({ embeds: [embed] });
        } catch (e) { await interaction.editReply("❌ Quest Error."); }
    }
});

// --- DM MODMAIL ---
client.on('messageCreate', async message => {
    if (message.author.bot) return;
    if (!message.guild) {
        if (message.author.id === OWNER_ID) {
            if (message.content.toLowerCase() === 'ping') return message.reply('Pong! Admin Mode.');
            return; 
        }
        console.log(`Forwarding DM from ${message.author.tag}`);
        const dev = await client.users.fetch(OWNER_ID);
        const embed = new EmbedBuilder().setTitle(`📩 DM Received`).setAuthor({ name: message.author.tag, iconURL: message.author.displayAvatarURL() }).setDescription(message.content || "Empty content").addFields({ name: 'ID', value: `\`${message.author.id}\`` }).setColor(0x3498db).setTimestamp();
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`srv_dm_${message.author.id}`).setLabel(`Reply to ${message.author.username}`).setStyle(ButtonStyle.Primary));
        try { await dev.send({ embeds: [embed], components: [row] }); await message.reply("✅ Message sent to developer."); } catch (e) { console.error("DM Error:", e.message); }
    }
});

client.on('messageReactionAdd', (reaction, user) => handleReaction(reaction, user, true));
client.on('messageReactionRemove', (reaction, user) => handleReaction(reaction, user, false));
client.on('guildCreate', async guild => { if (await isGuildBlacklisted(guild.id)) await guild.leave().catch(() => {}); });

client.once(Events.ClientReady, async () => {
    console.log(`Logged in as ${client.user.tag}`);
    client.user.setActivity('metaforge.app/arc-raiders', { type: ActivityType.Listening });
    await ensureAuth();
    await loadAllConfigs();
    await refreshCaches();
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    try {
        const guilds = client.guilds.cache;
        for (const [guildId, guild] of guilds) { try { await rest.put(Routes.applicationGuildCommands(CLIENT_ID, guildId), { body: commandsData }); } catch (err) {} }
        await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commandsData });
    } catch (e) {}
    updateEvents();
    setInterval(updateEvents, CHECK_INTERVAL);
});

client.login(TOKEN).catch(console.error);
