const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const axios = require('axios');

// --- CONFIGURATION ---
const TOKEN = 'YOUR_DISCORD_BOT_TOKEN';
const CHANNEL_ID = 'YOUR_CHANNEL_ID'; // Channel for alerts and live status
const LIVE_MESSAGE_ID = null; // Set this after the first run to keep updating ONE message
const API_URL = 'https://metaforge.app/api/arc-raiders/events-schedule';
const CHECK_INTERVAL = 60000; // Check every 60 seconds

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

// Memory to prevent duplicate alerts
let lastAlertedEventTime = null;

async function updateEvents() {
    try {
        const response = await axios.get(API_URL);
        const events = response.data.response.data;
        const now = Date.now();
        const fifteenMinsFromNow = now + (15 * 60 * 1000);

        // 1. Find Current and Next Rotation
        const currentEvents = events.filter(e => e.startTime <= now && e.endTime > now);
        const nextRotation = events.find(e => e.startTime > now);

        // 2. Alert Logic: If the next event starts within 15 mins and we haven't alerted yet
        if (nextRotation && nextRotation.startTime <= fifteenMinsFromNow) {
            if (lastAlertedEventTime !== nextRotation.startTime) {
                const alertChannel = await client.channels.fetch(CHANNEL_ID);
                await alertChannel.send({
                    content: `⚠️ **Upcoming Event:** ${nextRotation.name} starts <t:${Math.floor(nextRotation.startTime / 1000)}:R>!`
                });
                lastAlertedEventTime = nextRotation.startTime;
            }
        }

        // 3. Update the Live Status Embed
        const embed = new EmbedBuilder()
            .setTitle('🛸 ARC Raiders - Live Rotations')
            .setColor(0x00AE86)
            .setTimestamp()
            .setFooter({ text: 'Auto-updating every minute' });

        if (currentEvents.length > 0) {
            const list = currentEvents.map(e => `• **${e.name}** (${e.map})`).join('\n');
            embed.addFields({ name: '✅ Currently Active', value: list });
        }

        if (nextRotation) {
            embed.addFields({ 
                name: '🔜 Next Rotation', 
                value: `${nextRotation.name} on ${nextRotation.map} starting <t:${Math.floor(nextRotation.startTime / 1000)}:R>` 
            });
        }

        const channel = await client.channels.fetch(CHANNEL_ID);
        
        // If you have a LIVE_MESSAGE_ID, edit it. Otherwise, post a new one.
        if (LIVE_MESSAGE_ID) {
            const msg = await channel.messages.fetch(LIVE_MESSAGE_ID);
            await msg.edit({ embeds: [embed] });
        } else {
            const sent = await channel.send({ embeds: [embed] });
            console.log(`Initial message sent! Save this ID to LIVE_MESSAGE_ID: ${sent.id}`);
        }

    } catch (error) {
        console.error('Error fetching API:', error.message);
    }
}

client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}`);
    // Run immediately, then interval
    updateEvents();
    setInterval(updateEvents, CHECK_INTERVAL);
});

client.login(TOKEN);
