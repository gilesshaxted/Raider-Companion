require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const axios = require('axios');
const http = require('http');

// --- KOYEB HEALTH CHECK SERVER ---
const PORT = process.env.PORT || 8000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is running\n');
}).listen(PORT, () => {
    console.log(`Health check server listening on port ${PORT}`);
});

// --- CONFIGURATION ---
const TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = '1077242377099550863';
const API_URL = 'https://metaforge.app/api/arc-raiders/events-schedule';
const CHECK_INTERVAL = 60000;

// Persistent message IDs to track map-specific embeds and the summary
let MESSAGE_IDS = {
    'Dam': null,
    'Buried City': null,
    'Blue Gate': null,
    'Spaceport': null,
    'Stella Montis': null,
    'Summary': null
};

// --- MAP CONFIGURATION ---
const mapConfigs = {
    'Dam': {
        color: 0x3498db,
        image: 'https://media.discordapp.net/attachments/1397641556009156658/1472985276753121413/l547kr11ki1g1.png'
    },
    'Buried City': {
        color: 0xe67e22,
        image: 'https://media.discordapp.net/attachments/1397641556009156658/1472985571034140704/Buried_City.png'
    },
    'Blue Gate': {
        color: 0x9b59b6,
        image: 'https://cdn.discordapp.com/attachments/1397641556009156658/1472984992203149449/1200px-Blue_Gate.png.png'
    },
    'Spaceport': {
        color: 0x2ecc71,
        image: 'https://media.discordapp.net/attachments/1397641556009156658/1472985777280647319/Spaceport.png'
    },
    'Stella Montis': {
        color: 0xf1c40f,
        image: 'https://cdn.discordapp.com/attachments/1077242377099550863/1472982493719298281/ARC-Raiders-Stella-Montis-map-guide.png'
    }
};

const eventEmojis = {
    'Night Raid': '🌙',
    'Prospecting Probes': '📡',
    'Matriarch': '👑',
    'Bird City': '🐦',
    'Hidden Bunker': '🏢',
    'Cold Snap': '❄️',
    'Harvester': '🚜',
    'Electromagnetic Storm': '⚡',
    'Lush Blooms': '🌸',
    'Locked Gate': '🔒',
    'Launch Tower Loot': '🚀',
    'Uncovered Caches': '📦'
};

const getEmoji = (name) => eventEmojis[name] || '🛸';

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

async function updateEvents() {
    try {
        const response = await axios.get(API_URL);
        const events = response.data?.data;

        if (!events || !Array.isArray(events)) {
            console.error('API did not return an array in the "data" field.');
            return;
        }

        const now = Date.now();
        const channel = await client.channels.fetch(CHANNEL_ID);
        if (!channel) return;

        // --- 1. GENERATE MAP SPECIFIC EMBEDS ---
        for (const [mapName, config] of Object.entries(mapConfigs)) {
            
            // Normalize map names for filtering (handles spaces like "Space Port" vs "Spaceport")
            const mapEvents = events.filter(e => 
                e.map?.toLowerCase().replace(/\s/g, '') === mapName.toLowerCase().replace(/\s/g, '')
            );

            const activeEvent = mapEvents.find(e => e.startTime <= now && e.endTime > now);
            const upcomingEvents = mapEvents
                .filter(e => e.startTime > now)
                .sort((a, b) => a.startTime - b.startTime)
                .slice(0, 3);

            const embed = new EmbedBuilder()
                .setTitle(`📍 ${mapName}`)
                .setColor(config.color)
                .setImage(config.image)
                .setTimestamp()
                .setFooter({ text: `Last update` });

            // Status Section
            if (activeEvent) {
                embed.addFields({ 
                    name: '📡 Status', 
                    value: `🟢 **LIVE:** ${getEmoji(activeEvent.name)} **${activeEvent.name}**\nEnds <t:${Math.floor(activeEvent.endTime / 1000)}:R>` 
                });
                if (activeEvent.icon) embed.setThumbnail(activeEvent.icon);
            } else {
                embed.addFields({ name: '📡 Status', value: '⚪ **Offline**' });
            }

            // Next Up Section (3 events inline)
            if (upcomingEvents.length > 0) {
                upcomingEvents.forEach((e, index) => {
                    embed.addFields({
                        name: `Next Up #${index + 1}`,
                        value: `${getEmoji(e.name)} **${e.name}**\n<t:${Math.floor(e.startTime / 1000)}:R>`,
                        inline: true
                    });
                });
            } else {
                embed.addFields({ name: 'Next Up', value: 'No upcoming rotations found.' });
            }

            await syncMessage(channel, mapName, embed);
        }

        // --- 2. GENERATE SUMMARY EMBED ---
        const currentEvents = events.filter(e => e.startTime <= now && e.endTime > now);
        const summaryEmbed = new EmbedBuilder()
            .setTitle('🛸 ARC Raiders - Live Summary')
            .setColor(0x00AE86)
            .setTimestamp()
            .setFooter({ text: 'Auto-updating status • Data via Metaforge' });

        if (currentEvents.length > 0) {
            const list = currentEvents.map(e => {
                const emoji = getEmoji(e.name);
                return `${emoji} **${e.name}**\n└ *${e.map || 'Unknown Map'}*\n────────────────`;
            }).join('\n');
            summaryEmbed.addFields({ name: '✅ Currently Active', value: list });
        } else {
            summaryEmbed.addFields({ name: '✅ Currently Active', value: 'No events currently active.' });
        }

        await syncMessage(channel, 'Summary', summaryEmbed);

    } catch (error) {
        console.error('Error in updateEvents loop:', error.message);
    }
}

async function syncMessage(channel, key, embed) {
    if (MESSAGE_IDS[key]) {
        try {
            const msg = await channel.messages.fetch(MESSAGE_IDS[key]);
            await msg.edit({ embeds: [embed] });
        } catch (e) {
            const sent = await channel.send({ embeds: [embed] });
            MESSAGE_IDS[key] = sent.id;
        }
    } else {
        const sent = await channel.send({ embeds: [embed] });
        MESSAGE_IDS[key] = sent.id;
        console.log(`Initial ${key} Message ID: ${sent.id}`);
    }
}

client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}`);
    updateEvents();
    setInterval(updateEvents, CHECK_INTERVAL);
});

client.login(TOKEN);
