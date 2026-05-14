const { 
    Client, 
    GatewayIntentBits, 
    EmbedBuilder, 
    AttachmentBuilder, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle, 
    REST, 
    Routes, 
    SlashCommandBuilder,
    MessageFlags
} = require('discord.js');
const axios = require('axios');
require('dotenv').config();

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const OWNER_ID = process.env.OWNER_ID || '0'; // Replace with your Discord ID if not in .env

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const commands = [
    new SlashCommandBuilder()
        .setName('mapdata')
        .setDescription('Analyze and retrieve raw map markers from Metaforge')
        .addStringOption(option =>
            option.setName('map')
                .setDescription('The Map ID (e.g., sector_zero)')
                .setRequired(true)),
    new SlashCommandBuilder()
        .setName('status')
        .setDescription('Check the bot and API connection status')
].map(command => command.toJSON());

async function registerCommands() {
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    try {
        console.log('Started refreshing application (/) commands.');
        await rest.put(
            Routes.applicationCommands(CLIENT_ID),
            { body: commands },
        );
        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error('Error refreshing commands:', error);
    }
}

client.once('ready', () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    registerCommands();
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    try {
        if (interaction.commandName === 'mapdata') {
            // Check ownership
            if (OWNER_ID !== '0' && interaction.user.id !== OWNER_ID) {
                return interaction.reply({ 
                    content: '❌ Access Denied: You do not have permission to use map intelligence tools.', 
                    flags: [MessageFlags.Ephemeral] 
                });
            }

            // Immediately defer to avoid "Application Not Responding" (3-second limit)
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

            const mapID = interaction.options.getString('map');
            const apiUrl = `https://metaforge.app/api/game-map-data?tableID=arc_map_data&mapID=${mapID}`;

            try {
                const res = await axios.get(apiUrl, { timeout: 15000 });
                let rawData = res.data;
                
                // Parsing logic for different API response formats
                let markers = null;
                if (Array.isArray(rawData)) markers = rawData;
                else if (rawData?.allData) markers = rawData.allData; 
                else if (rawData?.data) markers = rawData.data;

                if (!markers || !Array.isArray(markers) || markers.length === 0) {
                    return interaction.editReply(`⚠️ No data found for map \`${mapID}\`. The API returned an empty set or invalid structure.`);
                }

                const stats = {};
                markers.forEach(m => {
                    const cat = String(m.category || 'Unknown').toUpperCase();
                    const sub = String(m.subcategory || 'General').toLowerCase();
                    if (!stats[cat]) stats[cat] = {};
                    stats[cat][sub] = (stats[cat][sub] || 0) + 1;
                });

                let analysisStr = "";
                Object.entries(stats).forEach(([cat, subs]) => {
                    analysisStr += `**${cat}**\n`;
                    // Sort subcategories by frequency
                    Object.entries(subs).sort((a,b) => b[1] - a[1]).forEach(([sub, count]) => {
                        analysisStr += `> \`${sub}\`: **${count}**\n`;
                    });
                });

                const schemaEmbed = new EmbedBuilder()
                    .setTitle(`🗺️ Intelligence Report: ${mapID.toUpperCase()}`)
                    .setColor(0x3498db)
                    .setDescription(`**Total Markers Identified:** ${markers.length}\n\n${analysisStr.substring(0, 3800)}`)
                    .setFooter({ text: `Source: Metaforge API | Requested by ${interaction.user.username}` })
                    .setTimestamp();
                
                // Add a sample of the first record's fields
                const keys = Object.keys(markers[0]);
                const sample = markers[0];
                const sampleLines = Object.keys(sample).slice(0, 6).map(k => `${k}: ${String(sample[k]).substring(0, 40)}`).join('\n');
                
                schemaEmbed.addFields(
                    { name: '📊 Schema Info', value: `\`\`\`\nFields: ${keys.slice(0, 10).join(', ')}${keys.length > 10 ? '...' : ''}\n\`\`\``, inline: false },
                    { name: '📄 Record Sample', value: `\`\`\`yaml\n${sampleLines}\n\`\`\``, inline: false }
                );

                // Attach full JSON file for the user to download
                const attachment = new AttachmentBuilder(Buffer.from(JSON.stringify(markers, null, 2)), { name: `mapdata_${mapID}.json` });
                
                await interaction.editReply({ embeds: [schemaEmbed], files: [attachment] });

            } catch (apiErr) {
                console.error('API Error:', apiErr.message);
                await interaction.editReply(`❌ Failed to fetch map data. API might be down or map ID is invalid.\nError: \`${apiErr.message}\``);
            }
        }

        if (interaction.commandName === 'status') {
            const statusEmbed = new EmbedBuilder()
                .setTitle('🤖 System Status')
                .setColor(0x2ecc71)
                .addFields(
                    { name: 'Latency', value: `\`${client.ws.ping}ms\``, inline: true },
                    { name: 'Uptime', value: `\`${Math.floor(process.uptime() / 60)} minutes\``, inline: true }
                )
                .setTimestamp();
            await interaction.reply({ embeds: [statusEmbed] });
        }

    } catch (err) {
        console.error('Interaction Execution Error:', err);
        const errorContent = '🚨 There was an internal error while executing this command.';
        
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply({ content: errorContent });
        } else {
            await interaction.reply({ content: errorContent, flags: [MessageFlags.Ephemeral] });
        }
    }
});

client.login(TOKEN);
