require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const axios = require('axios');
const http = require('http');

// --- KOYEB HEALTH CHECK SERVER ---
// Koyeb requires a web server to stay "Healthy".
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
        
        // --- UPDATED DATA PATH ---
        // The API returns an object with a "data" array at the top level.
        // Axios puts the JSON payload in response.data.
        const events = response.data?.data;
        
        if (!events || !Array.isArray(events)) {
            console.error('API did not return an array in the "data" field.');
            return;
        }

        const now = Date.now();
        const fifteenMinsFromNow = now + (15 * 60 * 1000);

        // Filter events that are happening right now
        const currentEvents = events.filter(e => e.startTime <= now && e.endTime > now);
        
        // Find the very next event starting after now
        const nextRotation = events
            .filter(e => e.startTime > now)
            .sort((a, b) => a.startTime - b.startTime)[0];

        const channel = await client.channels.fetch(CHANNEL_ID);
        if (!channel) return;

        // 1. Alert Logic: Ping if an event is starting soon (within 15 mins)
        if (nextRotation && nextRotation.startTime <= fifteenMinsFromNow) {
            if (lastAlertedEventTime !== nextRotation.startTime) {
                await channel.send({
                    content: `⚠️ **Upcoming Event:** ${nextRotation.name} starts <t:${Math.floor(nextRotation.startTime / 1000)}:R>!`
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

        // Add thumbnail of the first active event if it exists
        if (currentEvents.length > 0 && currentEvents[0].icon) {
            embed.setThumbnail(currentEvents[0].icon);
        }

        if (currentEvents.length > 0) {
            const list = currentEvents.map(e => `• **${e.name}**\n└ Map: *${e.map || 'Unknown'}*`).join('\n');
            embed.addFields({ name: '✅ Currently Active', value: list });
        } else {
            embed.addFields({ name: '✅ Currently Active', value: 'No events currently active.' });
        }

        if (nextRotation) {
            embed.addFields({ 
                name: '🔜 Next Rotation', 
                value: `**${nextRotation.name}** on *${nextRotation.map || 'Unknown'}*\nStarts <t:${Math.floor(nextRotation.startTime / 1000)}:R>` 
            });
        }

        // 3. Message Management (Edit existing or send new)
        if (LIVE_MESSAGE_ID) {
            try {
                const msg = await channel.messages.fetch(LIVE_MESSAGE_ID);
                await msg.edit({ embeds: [embed] });
            } catch (e) {
                const sent = await channel.send({ embeds: [embed] });
                LIVE_MESSAGE_ID = sent.id;
                console.log(`Live message was missing or deleted. New ID: ${sent.id}`);
            }
        } else {
            const sent = await channel.send({ embeds: [embed] });
            LIVE_MESSAGE_ID = sent.id;
            console.log(`Initial message sent! To keep this message updated, set LIVE_MESSAGE_ID to: ${sent.id}`);
        }

    } catch (error) {
        console.error('Error in updateEvents loop:', error.message);
    }
}

client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}`);
    // Initial run
    updateEvents();
    // Set periodic update
    setInterval(updateEvents, CHECK_INTERVAL);
});

client.login(TOKEN);
