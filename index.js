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

// World coordinate boundaries to map pixel space
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

const commands = [
    new SlashCommandBuilder()
        .setName('mapdata')
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
        await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
        console.log('✅ Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error('❌ Error registering commands:', error);
    }
}

async function generateMapImage(mapId, markers) {
    const config = MAP_CONFIG[mapId];
    const imagePath = path.join(__dirname, 'assets', config.file);
    
    // Check if asset exists
    if (!fs.existsSync(imagePath)) {
        throw new Error(`MISSING_IMAGE:${config.file}`);
    }

    const baseImage = await loadImage(imagePath);
    const canvas = createCanvas(baseImage.width, baseImage.height);
    const ctx = canvas.getContext('2d');

    // Draw the base map image
    ctx.drawImage(baseImage, 0, 0);

    // Render each tactical marker based on its category
    markers.forEach(marker => {
        const { lat, lng, category } = marker;
        
        // Scale world coordinates to pixel coordinates
        const x = ((lng - config.bounds.minLng) / (config.bounds.maxLng - config.bounds.minLng)) * baseImage.width;
        const y = ((lat - config.bounds.minLat) / (config.bounds.maxLat - config.bounds.minLat)) * baseImage.height;

        // Categorical color coding logic
        let color = '#ffffff';
        switch(category?.toLowerCase()) {
            case 'arc': color = '#ff4757'; break;      // Red
            case 'containers': color = '#1e90ff'; break; // Blue
            case 'locations': color = '#2ed573'; break;  // Green
            case 'nature': color = '#ffa502'; break;    // Orange
            case 'quests': color = '#eccc68'; break;    // Gold
            default: color = '#ffffff';                 // White
        }

        // Draw marker dot
        ctx.beginPath();
        ctx.arc(x, y, 6, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
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

    // Command Router logic
    const handledCommands = ['mapdata', 'mapview', 'status'];
    if (!handledCommands.includes(interaction.commandName)) {
        return interaction.reply({ 
            content: `❌ Command \`/${interaction.commandName}\` is not implemented in this version.`, 
            flags: [MessageFlags.Ephemeral] 
        });
    }

    // Security check for administrator access
    if (OWNER_ID !== '0' && interaction.user.id !== OWNER_ID) {
        return interaction.reply({ 
            content: '⚠️ **Unauthorized Access:** Access restricted to administrator.', 
            flags: [MessageFlags.Ephemeral] 
        });
    }

    // Execution block for map generation
    if (interaction.commandName === 'mapdata' || interaction.commandName === 'mapview') {
        try {
            // CRITICAL: Immediately defer to prevent "Application Not Responding"
            await interaction.deferReply(); 

            const mapID = interaction.options.getString('map');
            const apiUrl = `https://metaforge.app/api/game-map-data?tableID=arc_map_data&mapID=${mapID}`;

            console.log(`🛰️ Fetching tactical data for: ${mapID}`);
            const res = await axios.get(apiUrl);
            
            // Robust data extraction: checking for raw array or nested data property
            let markers = [];
            if (Array.isArray(res.data)) {
                markers = res.data;
            } else if (res.data && Array.isArray(res.data.data)) {
                markers = res.data.data;
            } else if (res.data && typeof res.data === 'object') {
                // Fallback: search for any array property in the root object
                const foundArray = Object.values(res.data).find(val => Array.isArray(val));
                markers = foundArray || [];
            }

            if (markers.length === 0) {
                return interaction.editReply(`⚠️ No marker data found for **${MAP_CONFIG[mapID].name}**. (API returned empty)`);
            }

            console.log(`🎨 Rendering ${markers.length} markers onto ${MAP_CONFIG[mapID].file}...`);
            const imageBuffer = await generateMapImage(mapID, markers);
            const attachment = new AttachmentBuilder(imageBuffer, { name: `tactical_map.png` });

            // Build rich embed for response
            const embed = new EmbedBuilder()
                .setTitle(`🗺️ Tactical Overlay: ${MAP_CONFIG[mapID].name}`)
                .setDescription(`Visualizing intelligence for **${markers.length}** map points.`)
                .addFields(
                    { name: '🔴 ARC', value: 'Hostiles/Units', inline: true },
                    { name: '🔵 Loot', value: 'Containers', inline: true },
                    { name: '🟢 POIs', value: 'Spawns/Exits', inline: true }
                )
                .setColor(0x2f3542)
                .setImage(`attachment://tactical_map.png`)
                .setTimestamp()
                .setFooter({ text: 'Raider Companion Intelligence System' });

            await interaction.editReply({ embeds: [embed], files: [attachment] });
            console.log(`✅ Success: Visual report for ${mapID} delivered.`);

        } catch (err) {
            console.error('❌ Interaction Error:', err);
            
            let userError = "❌ An internal error occurred during map generation.";
            if (err.message.startsWith('MISSING_IMAGE')) {
                const missingFile = err.message.split(':')[1];
                userError = `❌ Map asset \`${missingFile}\` was not found in the \`/assets/\` folder. Please upload the map image.`;
            }
            
            if (interaction.deferred) {
                await interaction.editReply(userError);
            } else {
                await interaction.reply({ content: userError, flags: [MessageFlags.Ephemeral] });
            }
        }
    }

    // Health check command
    if (interaction.commandName === 'status') {
        await interaction.reply({ 
            content: `✅ **Uplink Stable:** Heartbeat is ${client.ws.ping}ms. System operational.`, 
            flags: [MessageFlags.Ephemeral] 
        });
    }
});

client.login(TOKEN);
