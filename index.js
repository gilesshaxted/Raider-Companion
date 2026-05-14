const { 
    Client, 
    GatewayIntentBits, 
    EmbedBuilder, 
    AttachmentBuilder, 
    REST, 
    Routes, 
    SlashCommandBuilder,
    MessageFlags
} = require('discord.js');
const axios = require('axios');
const { createCanvas, loadImage } = require('canvas');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const OWNER_ID = process.env.OWNER_ID || '0';

// Update these bounds as you discover the world-to-pixel ratio for Riven Tides
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
        .setName('mapview')
        .setDescription('Generate a visual overlay of map markers')
        .addStringOption(option =>
            option.setName('map')
                .setDescription('The Map ID')
                .setRequired(true)
                .addChoices(
                    { name: 'Dam', value: 'dam' },
                    { name: 'Stella Montis', value: 'stella_montis' },
                    { name: 'Buried City', value: 'sector_zero' },
                    { name: 'Spaceport', value: 'spaceport' },
                    { name: 'Riven Tides', value: 'riven_tides' }
                )),
    new SlashCommandBuilder()
        .setName('status')
        .setDescription('Check system health')
].map(command => command.toJSON());

async function registerCommands() {
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    try {
        await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
        console.log('Successfully registered commands.');
    } catch (error) {
        console.error('Error registering commands:', error);
    }
}

async function generateMapImage(mapId, markers) {
    const config = MAP_CONFIG[mapId];
    if (!config) throw new Error("Map configuration not found.");

    const imagePath = path.join(__dirname, 'assets', config.file);
    
    // Safety check for missing image files (like Riven Tides)
    if (!fs.existsSync(imagePath)) {
        throw new Error(`The map image file "${config.file}" is missing from the /assets/ folder.`);
    }

    const baseImage = await loadImage(imagePath);
    const canvas = createCanvas(baseImage.width, baseImage.height);
    const ctx = canvas.getContext('2d');

    // Draw the satellite/base map
    ctx.drawImage(baseImage, 0, 0);

    markers.forEach(marker => {
        const { lat, lng, category } = marker;
        
        // Convert world coordinates to pixel coordinates based on bounds
        const x = ((lng - config.bounds.minLng) / (config.bounds.maxLng - config.bounds.minLng)) * baseImage.width;
        const y = ((lat - config.bounds.minLat) / (config.bounds.maxLat - config.bounds.minLat)) * baseImage.height;

        // Color coding for tactical intelligence
        let color = '#ffffff';
        switch(category?.toLowerCase()) {
            case 'arc': color = '#ff4757'; break; // Red: Enemies
            case 'containers': color = '#1e90ff'; break; // Blue: Loot
            case 'locations': color = '#2ed573'; break; // Green: POIs/Extraction
            case 'nature': color = '#ffa502'; break; // Orange: Resources
            case 'quests': color = '#eccc68'; break; // Yellow: Quest Items
            default: color = '#ffffff';
        }

        // Draw dot with outline for visibility
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

client.once('ready', () => {
    console.log(`✅ ${client.user.tag} is online and ready for deployment.`);
    registerCommands();
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'mapview') {
        // Restricted access
        if (OWNER_ID !== '0' && interaction.user.id !== OWNER_ID) {
            return interaction.reply({ content: '❌ Tactical data access restricted to authorized personnel.', flags: [MessageFlags.Ephemeral] });
        }

        await interaction.deferReply();
        const mapID = interaction.options.getString('map');
        const apiUrl = `https://metaforge.app/api/game-map-data?tableID=arc_map_data&mapID=${mapID}`;

        try {
            const res = await axios.get(apiUrl);
            const markers = Array.isArray(res.data) ? res.data : (res.data.data || res.data.allData || []);

            if (markers.length === 0) {
                return interaction.editReply(`⚠️ Intelligence report for **${MAP_CONFIG[mapID].name}** is empty. No markers found.`);
            }

            const imageBuffer = await generateMapImage(mapID, markers);
            const attachment = new AttachmentBuilder(imageBuffer, { name: `tactical_render_${mapID}.png` });

            const embed = new EmbedBuilder()
                .setTitle(`🗺️ Tactical Overlay: ${MAP_CONFIG[mapID].name}`)
                .setDescription(`Successfully rendered **${markers.length}** markers onto satellite imagery.`)
                .addFields(
                    { name: 'Red', value: 'ARC Hostiles', inline: true },
                    { name: 'Blue', value: 'Containers/Loot', inline: true },
                    { name: 'Green', value: 'POIs/Spawns', inline: true }
                )
                .setColor(0x2f3542)
                .setImage(`attachment://tactical_render_${mapID}.png`)
                .setTimestamp()
                .setFooter({ text: "Raider Companion | Intelligence Systems" });

            await interaction.editReply({ embeds: [embed], files: [attachment] });

        } catch (err) {
            console.error(err);
            const errorMessage = err.message.includes('missing') 
                ? `❌ **Missing Map Image:** Please upload \`${MAP_CONFIG[mapID].file}\` to your \`/assets/\` folder.`
                : `❌ **Deployment Error:** ${err.message}`;
                
            await interaction.editReply(errorMessage);
        }
    }

    if (interaction.commandName === 'status') {
        await interaction.reply({ 
            content: `🛰️ Uplink stable. Latency: **${client.ws.ping}ms**`, 
            flags: [MessageFlags.Ephemeral] 
        });
    }
});

client.login(TOKEN);
