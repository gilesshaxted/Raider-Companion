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
const CLIENT_ID = process.env.CLIENT_ID;
const CHANNEL_ID = '1077242377099550863'; 
const API_URL = 'https://metaforge.app/api/arc-raiders/events-schedule';
const CHECK_INTERVAL = 60000;

// Update this with the ID logged in the console after the first run
let LIVE_MESSAGE_ID = null; 

// --- EVENT EMOJI MAPPING ---
const eventEmojis = {
    'Night Raid': '🌙',
    'Prospecting Probes': '📡',
    'Matriarch': '🕷️',
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
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMessages 
    ] 
});

let lastAlertedEventTime = null;

async function updateEvents() {
    try {
        const response = await axios.get(API_URL);
        const events = response.data?.data;
        
        if (!events || !Array.isArray(events)) {
            console.error('API did not return an array in the "data" field.');
            return;
        }

        const now = Date.now();
        const fifteenMinsFromNow = now + (15 * 60 * 1000);

        const currentEvents = events.filter(e => e.startTime <= now && e.endTime > now);
        const nextRotation = events
            .filter(e => e.startTime > now)
            .sort((a, b) => a.startTime - b.startTime)[0];

        const channel = await client.channels.fetch(CHANNEL_ID);
        if (!channel) return;

        // 1. Alert Logic
        if (nextRotation && nextRotation.startTime <= fifteenMinsFromNow) {
            if (lastAlertedEventTime !== nextRotation.startTime) {
                await channel.send({
                    content: `⚠️ **Upcoming Event:** ${getEmoji(nextRotation.name)} **${nextRotation.name}** starts <t:${Math.floor(nextRotation.startTime / 1000)}:R>!`
                });
                lastAlertedEventTime = nextRotation.startTime;
            }
        }

        // 2. Build the Live Status Embed
        const embed = new EmbedBuilder()
            .setTitle('🛸 ARC Raiders - Live Rotations')
            .setColor(0x00AE86)
            .setTimestamp()
            .setFooter({ text: 'Auto-updating status • Data via Metaforge' });

        if (currentEvents.length > 0 && currentEvents[0].icon) {
            embed.setThumbnail(currentEvents[0].icon);
        }

        if (currentEvents.length > 0) {
            // Format current events with emojis and spacers
            const list = currentEvents.map(e => {
                const emoji = getEmoji(e.name);
                return `${emoji} **${e.name}**\n└ *${e.map || 'Unknown Map'}*\n────────────────`;
            }).join('\n');
            
            embed.addFields({ name: '✅ Currently Active', value: list });
        } else {
            embed.addFields({ name: '✅ Currently Active', value: 'No events currently active.' });
        }

        if (nextRotation) {
            const nextEmoji = getEmoji(nextRotation.name);
            embed.addFields({ 
                name: '🔜 Next Rotation', 
                value: `${nextEmoji} **${nextRotation.name}** on *${nextRotation.map || 'Unknown'}*\nStarts <t:${Math.floor(nextRotation.startTime / 1000)}:R>` 
            });
        }

        // 3. Message Management
        if (LIVE_MESSAGE_ID) {
            try {
                const msg = await channel.messages.fetch(LIVE_MESSAGE_ID);
                await msg.edit({ embeds: [embed] });
            } catch (e) {
                const sent = await channel.send({ embeds: [embed] });
                LIVE_MESSAGE_ID = sent.id;
            }
        } else {
            const sent = await channel.send({ embeds: [embed] });
            LIVE_MESSAGE_ID = sent.id;
            console.log(`Initial message sent! Set LIVE_MESSAGE_ID to: ${sent.id}`);
        }

    } catch (error) {
        console.error('Error in updateEvents loop:', error.message);
    }
}

client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}`);
    updateEvents();
    setInterval(updateEvents, CHECK_INTERVAL);
});

client.login(TOKEN);
