require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, TextChannel } = require('discord.js');
const axios = require('axios');

// --- CONFIGURATION ---
const TOKEN = process.env.DISCORD_TOKEN; 
const CHANNEL_ID = '1077242377099550863'; 
const API_URL = 'https://metaforge.app/api/arc-raiders/events-schedule';
const CHECK_INTERVAL = 60000; // 1 minute

// To keep the same message updated, paste the ID here after the first run
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
        const events = response.data.response.data;
        const now = Date.now();
        const fifteenMinsFromNow = now + (15 * 60 * 1000);

        // 1. Find Current and Next Rotation
        const currentEvents = events.filter(e => e.startTime <= now && e.endTime > now);
        const nextRotation = events.find(e => e.startTime > now);

        const channel = await client.channels.fetch(CHANNEL_ID);
        if (!(channel instanceof TextChannel)) {
            console.error("The provided Channel ID is not a text channel.");
            return;
        }

        // 2. Alert Logic
        if (nextRotation && nextRotation.startTime <= fifteenMinsFromNow) {
            if (lastAlertedEventTime !== nextRotation.startTime) {
                await channel.send({
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
        } else {
            embed.addFields({ name: '✅ Currently Active', value: 'No active events found.' });
        }

        if (nextRotation) {
            embed.addFields({ 
                name: '🔜 Next Rotation', 
                value: `${nextRotation.name} on ${nextRotation.map} starting <t:${Math.floor(nextRotation.startTime / 1000)}:R>` 
            });
        }

        // 4. Send or Edit the Message
        if (LIVE_MESSAGE_ID) {
            try {
                const msg = await channel.messages.fetch(LIVE_MESSAGE_ID);
                await msg.edit({ embeds: [embed] });
            } catch (err) {
                // If message was deleted, send a new one and update the ID
                console.log("Live message not found, sending a new one...");
                const sent = await channel.send({ embeds: [embed] });
                LIVE_MESSAGE_ID = sent.id;
                console.log(`New Message ID: ${sent.id}`);
            }
        } else {
            const sent = await channel.send({ embeds: [embed] });
            LIVE_MESSAGE_ID = sent.id;
            console.log(`Initial message sent! Save this ID to LIVE_MESSAGE_ID in your code: ${sent.id}`);
        }

    } catch (error) {
        console.error('Error fetching API or updating Discord:', error.message);
    }
}

client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}`);
    updateEvents();
    setInterval(updateEvents, CHECK_INTERVAL);
});

client.login(TOKEN);
