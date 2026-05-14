// ... existing code ...
        /* FIXED: Updated mapdata parser to specifically look for "allData" key */
        if (interaction.commandName === 'mapdata') {
            if (interaction.user.id !== OWNER_ID) return interaction.reply({ content: '❌ Owner only.', flags: [MessageFlags.Ephemeral] });
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

            const mapID = interaction.options.getString('map');
            try {
                const res = await axios.get(`https://metaforge.app/api/game-map-data?tableID=arc_map_data&mapID=${mapID}`, { timeout: 15000 });
                let rawData = res.data;
                
                // Handle various response shapes (object with data, allData, or direct array)
                let markers = null;
                if (Array.isArray(rawData)) markers = rawData;
                else if (rawData?.allData) markers = rawData.allData; 
                else if (rawData?.data) markers = rawData.data;

                if (!markers || !Array.isArray(markers) || markers.length === 0) {
                    return interaction.editReply(`⚠️ No data found for \`${mapID}\`. Structure check failed.`);
                }

                const stats = {};
                markers.forEach(m => {
                    const cat = String(m.category || 'unknown').toLowerCase();
                    const sub = String(m.subcategory || 'none').toLowerCase();
                    if (!stats[cat]) stats[cat] = {};
                    stats[cat][sub] = (stats[cat][sub] || 0) + 1;
                });

                let analysisStr = "";
                Object.entries(stats).forEach(([cat, subs]) => {
                    analysisStr += `**${cat.toUpperCase()}**\n`;
                    Object.entries(subs).sort((a,b) => b[1] - a[1]).forEach(([sub, count]) => {
                        analysisStr += `> \`${sub}\`: **${count}**\n`;
                    });
                });

                const keys = Object.keys(markers[0]);
                const schemaEmbed = new EmbedBuilder()
                    .setTitle(`🗺️ Map Intelligence: ${mapID.toUpperCase()}`)
                    .setColor(0x2ecc71)
                    .setDescription(`**Total Markers Identified:** ${markers.length}\n\n${analysisStr.substring(0, 3900)}`)
                    .setFooter({ text: `Fields: ${keys.join(', ')}` })
                    .setTimestamp();
                
                const sampleRecords = markers.slice(0, 1);
                sampleRecords.forEach((record, i) => {
                    const lines = Object.keys(record).slice(0, 8).map(k => `${k}: ${String(record[k]).substring(0, 45)}`).join('\n');
                    schemaEmbed.addFields({ name: `📄 Raw Sample`, value: `\`\`\`yaml\n${lines}\`\`\`` });
                });

                const attachment = new AttachmentBuilder(Buffer.from(JSON.stringify(markers, null, 2)), { name: `mapdata_${mapID}.json` });
                await interaction.editReply({ embeds: [schemaEmbed], files: [attachment] });
            } catch (err) { 
// ... existing code ...
```

### Changes Summary:
*   **Aggregated Analysis:** The bot now iterates through the full marker list to build a statistical breakdown of every item type found in your JSON.
*   **Visual Formatting:** Uses blockquotes and bold text to make categories (like `ARC`, `CONTAINERS`, `LOCATIONS`) stand out in the Discord embed.
*   **Sample Optimization:** Reduced the raw sample to one entry to ensure the category list has enough character space in the embed (Discord has a 4096 character limit).
*   **Automatic Array Detection:** It correctly identifies the plain array format you provided while maintaining compatibility with API wrappers that use keys like `allData`.
