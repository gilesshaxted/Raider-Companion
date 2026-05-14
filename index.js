const { 
    Client, 
    GatewayIntentBits, 
    EmbedBuilder, 
    AttachmentBuilder, 
    REST, 
    Routes, 
    SlashCommandBuilder,
    MessageFlags,
    Events
} = require('discord.js');
const axios = require('axios');
const { createCanvas, loadImage } = require('canvas');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const OWNER_ID = process.env.OWNER_ID || '0';

// World-to-Pixel scaling configuration
// Note: maxLat/maxLng define the 'virtual' size of the game world for scaling
const MAP_CONFIG = {
    'dam': {
        file: 'dam_battlegrounds.png',
        name: 'Dam Battlegrounds',
        bounds: { minLat: 0, maxLat: 6000, minLng: 0, maxLng: 6000 }
    },
    'sector_zero': {
        file: 'buried_city.png',
        name: 'Buried City',
        bounds: { minLat: 0, maxLat: 5000, minLng: 0, maxLng: 5000 }
    },
    'stella_montis': {
        file: 'stella_montis.png',
        name: 'Stella Montis',
        bounds: { minLat: 0, maxLat: 8000, minLng: 0, maxLng: 8000 }
    },
    'spaceport': {
        file: 'spaceport.png',
        name: 'Spaceport',
        bounds: { minLat: 0, maxLat: 4000, minLng: 0, maxLng: 4000 }
    },
    'blue_gate': {
        file: 'blue_gate.png',
        name: 'Blue Gate',
        bounds: { minLat: 0, maxLat: 5000, minLng: 0, maxLng: 5000 }
    },
    'riven_tides': {
        file: 'riven_tides.png',
        name: 'Riven Tides',
        bounds: { minLat: 0, maxLat: 6000, minLng: 0, maxLng: 6000 }
    }
};

const client = new Client({
    intents: [GatewayIntentBits.Guilds]
});

// We define /mapview as the primary command for the overlay
const commands = [
    new SlashCommandBuilder()
        .setName('mapview')
        .setDescription('Generate a visual overlay of tactical map markers')
        .addStringOption(option =>
            option.setName('map')
                .setDescription('The Map ID to render')
                .setRequired(true)
                .addChoices(
                    { name: 'Dam', value: 'dam' },
                    { name: 'Stella Montis', value: 'stella_montis' },
                    { name: 'Buried City', value: 'sector_zero' },
                    { name: 'Spaceport', value: 'spaceport' },
                    { name: 'Blue Gate', value: 'blue_gate' },
                    { name: 'Riven Tides', value: 'riven_tides' }
                )),
    new SlashCommandBuilder()
        .setName('status')
        .setDescription('Check bot heartbeat and system health')
].map(command => command.toJSON());

async function registerCommands() {
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    try {
        console.log('🔄 Started refreshing application (/) commands.');
        // Global registration
        await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
        console.log('✅ Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error('❌ Error registering commands:', error);
    }
}

async function generateMapImage(mapId, markers) {
    const config = MAP_CONFIG[mapId];
    const imagePath = path.join(__dirname, 'assets', config.file);
    
    // Safety check for asset existence
    if (!fs.existsSync(imagePath)) {
        throw new Error(`MISSING_IMAGE:${config.file}`);
    }

    const baseImage = await loadImage(imagePath);
    const canvas = createCanvas(baseImage.width, baseImage.height);
    const ctx = canvas.getContext('2d');

    // Draw base satellite imagery
    ctx.drawImage(baseImage, 0, 0);

    markers.forEach(marker => {
        const { lat, lng, category } = marker;
        
        // Linear scale logic: (WorldPos / WorldRange) * PixelSize
        const x = ((lng - config.bounds.minLng) / (config.bounds.maxLng - config.bounds.minLng)) * baseImage.width;
        const y = ((lat - config.bounds.minLat) / (config.bounds.maxLat - config.bounds.minLat)) * baseImage.height;

        // Categorical color coding
        let color = '#ffffff';
        switch(category?.toLowerCase()) {
            case 'arc': color = '#ff4757'; break; // Red for hostiles
            case 'containers': color = '#1e90ff'; break; // Blue for loot
            case 'locations': color = '#2ed573'; break; // Green for POIs
            case 'nature': color = '#ffa502'; break; // Orange for resources
            case 'quests': color = '#eccc68'; break; // Yellow for objectives
            default: color = '#ffffff';
        }

        // Draw tactical dot
        ctx.beginPath();
        ctx.arc(x, y, 6, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        // Add shadow/stroke for visibility on complex terrain
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
        ctx.lineWidth = 2;
        ctx.stroke();
    });

    return canvas.toBuffer('image/png');
}

client.once(Events.ClientReady, (c) => {
    console.log(`📡 Uplink established. Logged in as ${c.user.tag}`);
    registerCommands();
});

client.on(Events.InteractionCreate, async interaction => {
    if (!interaction.isChatInputCommand()) return;

    console.log(`📥 Received command: /${interaction.commandName} from ${interaction.user.tag}`);

    // Security Guard: Check if user is authorized administrator
    if (OWNER_ID !== '0' && interaction.user.id !== OWNER_ID) {
        console.log(`🚫 Unauthorized access attempt by ${interaction.user.id}`);
        return interaction.reply({ 
            content: '⚠️ **Unauthorized Access:** This command is restricted to the administrator.', 
            flags: [MessageFlags.Ephemeral] 
        });
    }

    if (interaction.commandName === 'mapview') {
        try {
            // CRITICAL: Call defer immediately to prevent "Not Responding" timeout
            await interaction.deferReply(); 

            const mapID = interaction.options.getString('map');
            const apiUrl = `https://metaforge.app/api/game-map-data?tableID=arc_map_data&mapID=${mapID}`;

            console.log(`🛰️ Fetching intelligence for map: ${mapID}`);
            const res = await axios.get(apiUrl);
            
            // Validate API data structure
            const markers = Array.isArray(res.data) ? res.data : (res.data.data || []);

            if (markers.length === 0) {
                return interaction.editReply(`⚠️ No marker data found for **${MAP_CONFIG[mapID].name}**.`);
            }

            console.log(`🎨 Rendering ${markers.length} markers...`);
            const imageBuffer = await generateMapImage(mapID, markers);
            const attachment = new AttachmentBuilder(imageBuffer, { name: `tactical_map.png` });

            const embed = new EmbedBuilder()
                .setTitle(`🗺️ Tactical Overlay: ${MAP_CONFIG[mapID].name}`)
                .setDescription(`Rendered **${markers.length}** points of interest onto satellite imagery.`)
                .addFields(
                    { name: '🔴 ARC', value: 'Hostiles', inline: true },
                    { name: '🔵 Loot', value: 'Containers', inline: true },
                    { name: '🟢 POIs', value: 'Spawns/Exfil', inline: true }
                )
                .setColor(0x2f3542)
                .setImage(`attachment://tactical_map.png`)
                .setFooter({ text: "Raider Companion Bot | Operational Intelligence" })
                .setTimestamp();

            await interaction.editReply({ embeds: [embed], files: [attachment] });
            console.log(`✅ Map delivered successfully.`);

        } catch (err) {
            console.error('❌ Interaction Error:', err);
            
            let userError = "❌ **Operation Failed:** An internal error occurred.";
            if (err.message.startsWith('MISSING_IMAGE')) {
                const fileName = err.message.split(':')[1];
                userError = `❌ **Asset Missing:** Map image \`${fileName}\` not found in \`/assets/\` folder.`;
            }

            // Fallback response handling
            if (interaction.deferred) {
                await interaction.editReply(userError);
            } else {
                await interaction.reply({ content: userError, flags: [MessageFlags.Ephemeral] });
            }
        }
    }

    if (interaction.commandName === 'status') {
        await interaction.reply({ 
            content: `✅ **Uplink Stable:** Heartbeat latency is ${client.ws.ping}ms.`, 
            flags: [MessageFlags.Ephemeral] 
        });
    }
});

client.login(TOKEN);
