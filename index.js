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
// On first run, these will be populated and logged to the console.
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
        color: 0x3498db, // Blue
        image: 'https://cdn.discordapp.com/attachments/1077242377099550863/1472980650201055495/map-review-dam-battlegrounds-v0-l547kr11ki1g1.png?ex=69948ba1&is=69933a21&hm=981cef88b54110e3f9205e32ef81e03ea82df7f197b2190afe0d16ba0b392cff&'
    },
    'Buried City': {
        color: 0xe67e22, // Orange
        image: 'https://cdn.discordapp.com/attachments/1077242377099550863/1472981360565161985/1200px-Buried_City.png.png?ex=69948c4b&is=69933acb&hm=aba975a349c26806bcea9aa7af76071f48378f125eae321e07d292ba58efb36b&'
    },
    'Blue Gate': {
        color: 0x9b59b6, // Purple
        image: 'https://cdn.discordapp.com/attachments/1077242377099550863/1472981803399905361/1200px-Blue_Gate.png.png?ex=69948cb4&is=69933b34&hm=47059437e4f92496cf199d3807a69410e57305932a05743159edd21ad45b18f0&'
    },
    'Spaceport': {
        color: 0x2ecc71, // Green
        image: 'https://cdn.discordapp.com/attachments/1077242377099550863/1472981968932311152/71d06f7d82b8b3f8a96f4d8bfe388fa769ed3f5d.png?ex=69948cdc&is=69933b5c&hm=d821036e8fbb3024235dc82a241905d6b4446eac527f727ecc2a5bacacd07e87&'
    },
    'Stella Montis': {
        color: 0xf1c40f, // Yellow
        image: 'https://cdn.discordapp.com/attachments/1077242377099550863/1472982493719298281/ARC-Raiders-Stella-Montis-map-guide.png?ex=69948d59&is=69933bd9&hm=255a9ef15958741ce83e6e4700a9d8894708875e9db2df1f752fa0006dcf9a81&'
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
        for (const mapName of Object.keys(mapConfigs)) {
            const config = mapConfigs[mapName];
            
            // Normalize map names for filtering (e.g. Spaceport vs Space Port)
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
                    value: `🟢 **LIVE:** ${getEmoji(activeEvent.name)} ${activeEvent.name}\nEnds <t:${Math.floor(activeEvent.endTime / 1000)}:R>` 
                });
                if (activeEvent.icon) embed.setThumbnail(activeEvent.icon);
            } else {
                embed.addFields({ name: '📡 Status', value: '⚪ **Offline**' });
            }

            // Next Up Section
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

            // Send or Update
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

/**
 * Helper to either edit an existing message or send a new one
 */
async function syncMessage(channel, key, embed) {
    if (MESSAGE_IDS[key]) {
        try {
            const msg = await channel.messages.fetch(MESSAGE_IDS[key]);
            await msg.edit({ embeds: [embed] });
        } catch (e) {
            const sent = await channel.send({ embeds: [embed] });
            MESSAGE_IDS[key] = sent.id;
            console.log(`Updated ${key} Message ID: ${sent.id}`);
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
