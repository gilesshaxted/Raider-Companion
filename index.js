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

// ─── Map Configuration ──────────────────────────────────────────────────────
// mapFile    → full map image from /maps/ (drawn on canvas)
// thumbnail  → small preview image from /assets/ (used in Discord embed thumbnail)
// zlayers: 2147483647 = surface, 1 = underground/lower level
//
// bounds: world coordinate of pixel (0,0) top-left corner of the map image.
//   minLng = world lng at left edge of image
//   minLat = world lat at top edge of image
//   scaleX = pixels per lng unit  (calibrated from known pixel<->coord pairs)
//   scaleY = pixels per lat unit
//
// To calibrate a new map: pick 2 landmarks, note their pixel pos on the image
// and their lat/lng from the API, then solve:
//   scaleX = (px2.x - px1.x) / (lng2 - lng1)
//   scaleY = (px2.y - px1.y) / (lat2 - lat1)
//   minLng = lng1 - px1.x / scaleX
//   minLat = lat1 - px1.y / scaleY
//
// Maps not yet calibrated use calibrated:false and fall back to data-range fit.
const MAP_CONFIG = {
    dam: {
        name: 'Dam Battlegrounds',
        apiSlug: 'dam',
        thumbnail: 'dam_battlegrounds.png',
        layers: {
            2147483647: { file: 'Dam_Battlegrounds_Map.jpg', label: 'Surface' },
            1:          { file: 'Dam_Battlegrounds_Map.jpg', label: 'Underground' }
        },
        // Calibrated: South Swamp Outpost px(1046,1642)→(lat:2838.94,lng:2682.81)
        //             Spillway Hatch       px(2919,1710)→(lat:2924,lng:4916)
        calibrated: true,
        bounds: { minLat: 784.9912, minLng: 1435.6574, scaleX: 0.838711, scaleY: 0.799436 }
    },
    sector_zero: {
        name: 'Buried City',
        apiSlug: 'buried-city',
        thumbnail: 'buried_city.png',
        layers: {
            2147483647: { file: 'Buried_City_Map.jpg', label: 'Surface' }
        },
        calibrated: false,
        bounds: { minLat: 0, minLng: 0, scaleX: null, scaleY: null }
    },
    stella_montis: {
        name: 'Stella Montis',
        apiSlug: 'stella-montis',
        thumbnail: 'stella_montis.png',
        layers: {
            2147483647: { file: 'Stella_Montis_Upper_Level_Map.jpg', label: 'Upper Level' },
            1:          { file: 'Stella_Montis_Lower_Level_Map.jpg', label: 'Lower Level' }
        },
        calibrated: false,
        bounds: { minLat: 0, minLng: 0, scaleX: null, scaleY: null }
    },
    spaceport: {
        name: 'Spaceport',
        apiSlug: 'spaceport',
        thumbnail: 'spaceport.png',
        layers: {
            2147483647: { file: 'Spaceport_Map.jpg', label: 'Surface' },
            1:          { file: 'Spaceport_Underground_Map.jpg', label: 'Underground' }
        },
        calibrated: false,
        bounds: { minLat: 0, minLng: 0, scaleX: null, scaleY: null }
    },
    blue_gate: {
        name: 'Blue Gate',
        apiSlug: 'blue-gate',
        thumbnail: 'blue_gate.png',
        layers: {
            2147483647: { file: 'Blue_Gate_Map.jpg', label: 'Surface' },
            1:          { file: 'Blue_Gate_Underground_Map.jpg', label: 'Underground' }
        },
        calibrated: false,
        bounds: { minLat: 0, minLng: 0, scaleX: null, scaleY: null }
    },
    riven_tides: {
        name: 'Riven Tides',
        apiSlug: 'riven-tides',
        thumbnail: null,
        layers: {
            2147483647: { file: 'Riven_Tides_Map.jpg', label: 'Surface' }
        },
        calibrated: false,
        bounds: { minLat: 0, minLng: 0, scaleX: null, scaleY: null }
    }
};

// ─── Marker Visual Definitions ───────────────────────────────────────────────
// Each entry defines: color, size, shape ('circle'|'square'|'diamond'|'triangle'), label
const MARKER_STYLES = {
    // ARC enemies
    'arc:tick':         { color: '#ff4757', size: 5,  shape: 'circle',   label: 'Tick' },
    'arc:pop':          { color: '#ff6b81', size: 5,  shape: 'circle',   label: 'Pop' },
    'arc:fireball':     { color: '#ff7f50', size: 5,  shape: 'circle',   label: 'Fireball' },
    'arc:rocketeer':    { color: '#ff0000', size: 7,  shape: 'diamond',  label: 'Rocketeer' },
    'arc:turret':       { color: '#c0392b', size: 8,  shape: 'square',   label: 'Turret' },
    'arc:rollbot':      { color: '#e74c3c', size: 6,  shape: 'diamond',  label: 'Rollbot' },
    'arc:wasp':         { color: '#ff6348', size: 6,  shape: 'circle',   label: 'Wasp' },
    'arc:hornet ':      { color: '#e55039', size: 7,  shape: 'triangle', label: 'Hornet' },
    'arc:bastion':      { color: '#c0392b', size: 9,  shape: 'square',   label: 'Bastion' },
    'arc:sentinel':     { color: '#96281b', size: 9,  shape: 'diamond',  label: 'Sentinel' },
    'arc:queen':        { color: '#7b241c', size: 12, shape: 'diamond',  label: '👑 Queen' },
    'arc:bison':        { color: '#b03a2e', size: 10, shape: 'triangle', label: 'Bison' },
    'arc:bombardier':   { color: '#e74c3c', size: 7,  shape: 'triangle', label: 'Bombardier' },
    'arc:snitch':       { color: '#f1948a', size: 5,  shape: 'circle',   label: 'Snitch' },
    'arc:matriarch':    { color: '#641e16', size: 13, shape: 'diamond',  label: '⚡ Matriarch' },
    'arc:comet':        { color: '#ff6b35', size: 7,  shape: 'diamond',  label: 'Comet' },
    'arc:firefly':      { color: '#ffa07a', size: 5,  shape: 'circle',   label: 'Firefly' },
    'arc:shredder':     { color: '#dc143c', size: 8,  shape: 'square',   label: 'Shredder' },
    'arc:turbine':      { color: '#b22222', size: 8,  shape: 'diamond',  label: 'Turbine' },
    'arc:vaporizer':    { color: '#8b0000', size: 9,  shape: 'triangle', label: 'Vaporizer' },

    // Containers
    'containers:base_container':      { color: '#1e90ff', size: 4,  shape: 'circle',  label: 'Container' },
    'containers:breachable_container':{ color: '#00bfff', size: 5,  shape: 'square',  label: 'Breachable' },
    'containers:ammo_crate':          { color: '#ffd700', size: 6,  shape: 'square',  label: 'Ammo' },
    'containers:med_crate':           { color: '#00ff7f', size: 6,  shape: 'square',  label: 'Med' },
    'containers:weapon_case':         { color: '#da70d6', size: 7,  shape: 'diamond', label: 'Weapon Case' },
    'containers:locker':              { color: '#87ceeb', size: 5,  shape: 'square',  label: 'Locker' },
    'containers:arc_courier':         { color: '#ff4500', size: 6,  shape: 'circle',  label: 'Arc Courier' },
    'containers:arc_probe':           { color: '#ff6347', size: 6,  shape: 'circle',  label: 'Arc Probe' },
    'containers:raider_cache':        { color: '#daa520', size: 6,  shape: 'diamond', label: 'Raider Cache' },
    'containers:utility_crate':       { color: '#20b2aa', size: 5,  shape: 'square',  label: 'Utility' },
    'containers:baron_husk':          { color: '#9370db', size: 7,  shape: 'diamond', label: 'Baron Husk' },
    'containers:wasp_husk':           { color: '#cd853f', size: 6,  shape: 'diamond', label: 'Wasp Husk' },
    'containers:rocketeer_husk':      { color: '#b8860b', size: 6,  shape: 'diamond', label: 'Rocketeer Husk' },
    'containers:security_breach':     { color: '#ff1493', size: 7,  shape: 'square',  label: 'Security Breach' },
    'containers:hurricane_cache':     { color: '#00ced1', size: 7,  shape: 'diamond', label: 'Hurricane Cache' },
    'containers:combat_supplies':     { color: '#ff8c00', size: 7,  shape: 'square',  label: 'Combat Supplies' },
    'containers:basket':              { color: '#90ee90', size: 4,  shape: 'circle',  label: 'Basket' },
    'containers:bag':                 { color: '#8fbc8f', size: 4,  shape: 'circle',  label: 'Bag' },
    'containers:car':                 { color: '#708090', size: 5,  shape: 'square',  label: 'Vehicle' },

    // Locations
    'locations:player_spawn':    { color: '#2ed573', size: 7,  shape: 'triangle', label: 'Spawn' },
    'locations:extraction':      { color: '#7bed9f', size: 9,  shape: 'triangle', label: '✈ Extract' },
    'locations:supply_station':  { color: '#5352ed', size: 7,  shape: 'square',   label: 'Supply Station' },
    'locations:field_depot':     { color: '#3742fa', size: 6,  shape: 'square',   label: 'Field Depot' },
    'locations:raider_camp':     { color: '#eccc68', size: 7,  shape: 'diamond',  label: 'Raider Camp' },
    'locations:locked_room':     { color: '#ff6b81', size: 7,  shape: 'square',   label: '🔒 Key Room' },
    'locations:field_crate':     { color: '#a4b0be', size: 5,  shape: 'square',   label: 'Field Crate' },
    'locations:hatch':           { color: '#ff4500', size: 8,  shape: 'triangle', label: 'Hatch' },
    'locations:breach_room':     { color: '#ff69b4', size: 7,  shape: 'square',   label: 'Breach Room' },
    'locations:fuel-cell':       { color: '#00ffff', size: 7,  shape: 'circle',   label: 'Fuel Cell' },
    'locations:button':          { color: '#adff2f', size: 6,  shape: 'circle',   label: 'Button' },

    // Nature
    'nature:mushroom':     { color: '#ffa502', size: 4, shape: 'circle', label: 'Mushroom' },
    'nature:prickly-pear': { color: '#a4c639', size: 4, shape: 'circle', label: 'Prickly Pear' },
    'nature:agave':        { color: '#4cbb17', size: 4, shape: 'circle', label: 'Agave' },
    'nature:great-mullein':{ color: '#9acd32', size: 4, shape: 'circle', label: 'Mullein' },
    'nature:apricot':      { color: '#ffb347', size: 4, shape: 'circle', label: 'Apricot' },
    'nature:candleberries':{ color: '#ff69b4', size: 5, shape: 'circle', label: 'Candleberries' },
    'nature:moss':         { color: '#6b8e23', size: 4, shape: 'circle', label: 'Moss' },
    'nature:roots':        { color: '#8b4513', size: 4, shape: 'circle', label: 'Roots' },
    'nature:fertilizer':   { color: '#a0522d', size: 4, shape: 'circle', label: 'Fertilizer' },

    // Quests
    'quests:untended-garden':       { color: '#eccc68', size: 7, shape: 'diamond', label: 'Quest' },
    'quests:broken-monument':       { color: '#eccc68', size: 7, shape: 'diamond', label: 'Quest' },
    'quests:straight-record':       { color: '#eccc68', size: 7, shape: 'diamond', label: 'Quest' },
    'quests:keeping-the-memory':    { color: '#eccc68', size: 7, shape: 'diamond', label: 'Quest' },
    'quests:a-symbol-of-unification':{ color: '#eccc68', size: 7, shape: 'diamond', label: 'Quest' },
    'quests:espresso':              { color: '#d4a017', size: 7, shape: 'diamond', label: 'Quest' },
    'quests:paving-the-way':        { color: '#d4a017', size: 7, shape: 'diamond', label: 'Quest' },
    'quests:the-league':            { color: '#d4a017', size: 7, shape: 'diamond', label: 'Quest' },

    // Events
    'events:harvester':     { color: '#ff6b35', size: 9, shape: 'diamond', label: '⚡ Harvester' },
    'events:snow_pile':     { color: '#b0e0e6', size: 5, shape: 'circle',  label: 'Snow Pile' },
    'events:assessor':      { color: '#ff4500', size: 8, shape: 'diamond', label: 'Assessor' },
    'events:ship_model':    { color: '#add8e6', size: 5, shape: 'circle',  label: 'Ship Model' }
};

// Category-level fallback styles
const CATEGORY_FALLBACK = {
    arc:        { color: '#ff4757', size: 5,  shape: 'circle'  },
    containers: { color: '#1e90ff', size: 5,  shape: 'square'  },
    locations:  { color: '#2ed573', size: 6,  shape: 'triangle'},
    nature:     { color: '#ffa502', size: 4,  shape: 'circle'  },
    quests:     { color: '#eccc68', size: 7,  shape: 'diamond' },
    events:     { color: '#ff6b35', size: 7,  shape: 'diamond' }
};

function getMarkerStyle(category, subcategory) {
    const key = `${category}:${subcategory}`;
    return MARKER_STYLES[key] || CATEGORY_FALLBACK[category] || { color: '#ffffff', size: 5, shape: 'circle' };
}

// ─── Canvas Drawing Helpers ──────────────────────────────────────────────────
function drawMarker(ctx, x, y, style, locked = false) {
    const { color, size, shape } = style;

    ctx.save();

    if (shape === 'circle') {
        ctx.beginPath();
        ctx.arc(x, y, size, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
    } else if (shape === 'square') {
        ctx.fillStyle = color;
        ctx.fillRect(x - size, y - size, size * 2, size * 2);
    } else if (shape === 'diamond') {
        ctx.beginPath();
        ctx.moveTo(x, y - size * 1.3);
        ctx.lineTo(x + size, y);
        ctx.lineTo(x, y + size * 1.3);
        ctx.lineTo(x - size, y);
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();
    } else if (shape === 'triangle') {
        ctx.beginPath();
        ctx.moveTo(x, y - size * 1.3);
        ctx.lineTo(x + size * 1.1, y + size);
        ctx.lineTo(x - size * 1.1, y + size);
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();
    }

    // Black border
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Lock indicator for behindLockedDoor
    if (locked) {
        ctx.font = `${Math.max(8, size)}px Arial`;
        ctx.fillStyle = '#ffffff';
        ctx.fillText('🔒', x + size, y - size);
    }

    ctx.restore();
}

function drawLegend(ctx, usedStyles) {
    const padding = 10;
    const itemH = 18;
    const boxW = 170;
    const boxH = padding * 2 + usedStyles.length * itemH;
    const startX = ctx.canvas.width - boxW - 10;
    const startY = 10;

    // Semi-transparent background
    ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
    ctx.fillRect(startX, startY, boxW, boxH);
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 1;
    ctx.strokeRect(startX, startY, boxW, boxH);

    usedStyles.forEach(({ label, color, shape, size }, i) => {
        const y = startY + padding + i * itemH + itemH / 2;
        const x = startX + padding + 8;

        // Mini marker
        ctx.save();
        const miniSize = 5;
        if (shape === 'circle') {
            ctx.beginPath();
            ctx.arc(x, y, miniSize, 0, Math.PI * 2);
            ctx.fillStyle = color;
            ctx.fill();
        } else if (shape === 'square') {
            ctx.fillStyle = color;
            ctx.fillRect(x - miniSize, y - miniSize, miniSize * 2, miniSize * 2);
        } else if (shape === 'diamond') {
            ctx.beginPath();
            ctx.moveTo(x, y - miniSize * 1.3);
            ctx.lineTo(x + miniSize, y);
            ctx.lineTo(x, y + miniSize * 1.3);
            ctx.lineTo(x - miniSize, y);
            ctx.closePath();
            ctx.fillStyle = color;
            ctx.fill();
        } else if (shape === 'triangle') {
            ctx.beginPath();
            ctx.moveTo(x, y - miniSize * 1.3);
            ctx.lineTo(x + miniSize * 1.1, y + miniSize);
            ctx.lineTo(x - miniSize * 1.1, y + miniSize);
            ctx.closePath();
            ctx.fillStyle = color;
            ctx.fill();
        }
        ctx.strokeStyle = 'rgba(0,0,0,0.8)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();

        // Label
        ctx.fillStyle = '#ffffff';
        ctx.font = '11px Arial';
        ctx.fillText(label, x + 12, y + 4);
    });
}

// ─── Core Image Generation ───────────────────────────────────────────────────
async function generateMapImage(mapId, markers, categoryFilter, layerKey) {
    const config = MAP_CONFIG[mapId];
    const layerConfig = config.layers[layerKey] || Object.values(config.layers)[0];
    const imagePath = path.join(__dirname, 'maps', layerConfig.file);

    if (!fs.existsSync(imagePath)) {
        throw new Error(`MISSING_IMAGE:${layerConfig.file}`);
    }

    const baseImage = await loadImage(imagePath);
    const canvas = createCanvas(baseImage.width, baseImage.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(baseImage, 0, 0);

    // Resolve coordinate transform
    let scaleX, scaleY, minLng, minLat;
    if (config.calibrated) {
        // Use calibrated pixel-per-unit scales and image-edge world coords
        ({ scaleX, scaleY, minLng, minLat } = config.bounds);
    } else {
        // Fallback: fit data range to image — rough but avoids blank renders
        const lats = markers.map(m => m.lat).filter(Boolean);
        const lngs = markers.map(m => m.lng).filter(Boolean);
        minLat = Math.min(...lats);
        minLng = Math.min(...lngs);
        const maxLat = Math.max(...lats);
        const maxLng = Math.max(...lngs);
        const padding = 0.05; // 5% padding
        const latSpan = (maxLat - minLat) * (1 + padding * 2);
        const lngSpan = (maxLng - minLng) * (1 + padding * 2);
        minLat -= (maxLat - minLat) * padding;
        minLng -= (maxLng - minLng) * padding;
        scaleX = baseImage.width  / lngSpan;
        scaleY = baseImage.height / latSpan;
        console.log(`⚠️  ${config.name} not calibrated — using data-range fit`);
    }

    // Filter markers by category and zlayer
    const filtered = markers.filter(m => {
        const catMatch = categoryFilter === 'all' || m.category === categoryFilter;
        // layerKey 1 = underground (zlayers === 1), surface = everything else
        const layerMatch = layerKey === 1 ? m.zlayers === 1 : m.zlayers !== 1;
        return catMatch && layerMatch;
    });

    // Track which styles are actually used for the legend
    const usedStyleMap = new Map();

    filtered.forEach(marker => {
        const { lat, lng, category, behindLockedDoor } = marker;
        const subcategory = marker.subcategory || marker.item_id || 'unknown';
        const x = (lng - minLng) * scaleX;
        const y = (lat - minLat) * scaleY;
        const style = getMarkerStyle(category, subcategory);

        drawMarker(ctx, x, y, style, behindLockedDoor);

        const key = `${category}:${subcategory}`;
        if (!usedStyleMap.has(key)) {
            usedStyleMap.set(key, { ...style, label: style.label || subcategory });
        }
    });

    // Draw legend if not too many types
    const usedStyles = [...usedStyleMap.values()];
    if (usedStyles.length <= 25) {
        drawLegend(ctx, usedStyles);
    }

    // Draw info bar at top
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(0, 0, baseImage.width, 28);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 14px Arial';
    ctx.fillText(`${config.name} — ${layerConfig.label} — ${filtered.length} markers`, 10, 19);

    // Output as JPEG — Discord's limit is 8MB. Always scale to MAX_SIDE.
    const MAX_SIDE = 1500;
    const scale = Math.min(MAX_SIDE / baseImage.width, MAX_SIDE / baseImage.height, 1);
    const w2 = Math.round(baseImage.width * scale);
    const h2 = Math.round(baseImage.height * scale);
    const scaled = createCanvas(w2, h2);
    scaled.getContext('2d').drawImage(canvas, 0, 0, w2, h2);
    const buf = scaled.toBuffer('image/jpeg', { quality: 0.75 });
    console.log(`🖼️ Output: ${w2}x${h2}px, ${(buf.length / 1024 / 1024).toFixed(2)}MB`);
    return buf;
}

// ─── Statistics Helper ───────────────────────────────────────────────────────
function buildStats(markers) {
    const counts = {};
    markers.forEach(m => {
        const key = m.category || 'unknown';
        counts[key] = (counts[key] || 0) + 1;
    });
    return counts;
}

// ─── Discord Setup ───────────────────────────────────────────────────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const commands = [
    new SlashCommandBuilder()
        .setName('mapview')
        .setDescription('Generate a visual overlay of tactical map markers')
        .addStringOption(o =>
            o.setName('map')
                .setDescription('Map to render')
                .setRequired(true)
                .addChoices(
                    { name: 'Dam Battlegrounds', value: 'dam' },
                    { name: 'Buried City',        value: 'sector_zero' },
                    { name: 'Stella Montis',      value: 'stella_montis' },
                    { name: 'Spaceport',          value: 'spaceport' },
                    { name: 'Blue Gate',          value: 'blue_gate' },
                    { name: 'Riven Tides',        value: 'riven_tides' }
                ))
        .addStringOption(o =>
            o.setName('category')
                .setDescription('Filter by marker category (default: all)')
                .setRequired(false)
                .addChoices(
                    { name: 'All',        value: 'all' },
                    { name: 'ARC Units',  value: 'arc' },
                    { name: 'Containers', value: 'containers' },
                    { name: 'Locations',  value: 'locations' },
                    { name: 'Nature',     value: 'nature' },
                    { name: 'Quests',     value: 'quests' },
                    { name: 'Events',     value: 'events' }
                ))
        .addStringOption(o =>
            o.setName('layer')
                .setDescription('Map layer (default: surface)')
                .setRequired(false)
                .addChoices(
                    { name: 'Surface / Upper', value: 'surface' },
                    { name: 'Underground / Lower', value: 'underground' }
                )),

    new SlashCommandBuilder()
        .setName('mapstats')
        .setDescription('Show marker statistics for a map without generating an image')
        .addStringOption(o =>
            o.setName('map')
                .setDescription('Map to check')
                .setRequired(true)
                .addChoices(
                    { name: 'Dam Battlegrounds', value: 'dam' },
                    { name: 'Buried City',        value: 'sector_zero' },
                    { name: 'Stella Montis',      value: 'stella_montis' },
                    { name: 'Spaceport',          value: 'spaceport' },
                    { name: 'Blue Gate',          value: 'blue_gate' },
                    { name: 'Riven Tides',        value: 'riven_tides' }
                )),

    new SlashCommandBuilder()
        .setName('status')
        .setDescription('Check bot heartbeat and system health')
].map(c => c.toJSON());

async function registerCommands() {
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    try {
        console.log('🔄 Refreshing slash commands...');
        await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
        console.log('✅ Commands registered.');
    } catch (err) {
        console.error('❌ Command registration failed:', err);
    }
}

async function fetchMarkers(mapId) {
    // Primary endpoint: full marker dataset (ARC units, containers, locations, etc.)
    const slug = MAP_CONFIG[mapId]?.apiSlug || mapId;
    const url = `https://metaforge.app/api/game-map-data?tableID=arc_map_data&mapID=${slug}`;
    const res = await axios.get(url, { timeout: 15000 });
    if (Array.isArray(res.data)) return res.data;
    if (Array.isArray(res.data?.data)) return res.data.data;
    const found = Object.values(res.data || {}).find(v => Array.isArray(v));
    return found || [];
}

async function fetchBlueprints(mapId) {
    // Secondary endpoint: community-submitted blueprint/recipe locations
    const config = MAP_CONFIG[mapId];
    const slug = config.apiSlug || mapId;
    const url = `https://metaforge.app/api/game-map-data/found-items?mapID=${slug}&gameID=arc-raiders`;
    const res = await axios.get(url, { timeout: 15000 });
    if (Array.isArray(res.data?.allData)) return res.data.allData;
    if (Array.isArray(res.data)) return res.data;
    const found = Object.values(res.data || {}).find(v => Array.isArray(v));
    return found || [];
}

// ─── Event Handlers ──────────────────────────────────────────────────────────
client.once(Events.ClientReady, c => {
    console.log(`📡 Online as ${c.user.tag}`);
    registerCommands();
});

client.on(Events.InteractionCreate, async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName, user } = interaction;
    console.log(`📥 /${commandName} from ${user.tag}`);

    // ── /status ───────────────────────────────────────────────────────────────
    if (commandName === 'status') {
        return interaction.reply({
            content: `✅ **Online** | Ping: **${client.ws.ping}ms** | Commands: \`/mapview\`, \`/mapstats\``,
            flags: [MessageFlags.Ephemeral]
        });
    }

    // ── /mapstats ─────────────────────────────────────────────────────────────
    if (commandName === 'mapstats') {
        await interaction.deferReply();
        const mapId = interaction.options.getString('map');
        const config = MAP_CONFIG[mapId];

        try {
            const markers = await fetchMarkers(mapId);
            const stats = buildStats(markers);
            const locked = markers.filter(m => m.behindLockedDoor).length;
            const underground = markers.filter(m => m.zlayers === 1).length;

            const statsLines = Object.entries(stats)
                .sort((a, b) => b[1] - a[1])
                .map(([cat, n]) => `\`${cat.padEnd(12)}\` **${n}**`)
                .join('\n');

            const embed = new EmbedBuilder()
                .setTitle(`📊 ${config.name} — Marker Statistics`)
                .setDescription(statsLines)
                .addFields(
                    { name: 'Total Markers', value: `**${markers.length}**`, inline: true },
                    { name: 'Behind Locked Doors', value: `**${locked}**`, inline: true },
                    { name: 'Underground Layer', value: `**${underground}**`, inline: true }
                )
                .setColor(0x2f3542)
                .setTimestamp();

            return interaction.editReply({ embeds: [embed] });
        } catch (err) {
            console.error(err);
            return interaction.editReply(`❌ Failed to fetch data for **${config.name}**.`);
        }
    }

    // ── /mapview ──────────────────────────────────────────────────────────────
    if (commandName === 'mapview') {
        await interaction.deferReply();

        const mapId          = interaction.options.getString('map');
        const categoryFilter = interaction.options.getString('category') || 'all';
        const layerChoice    = interaction.options.getString('layer') || 'surface';
        const layerKey       = layerChoice === 'underground' ? 1 : 2147483647;
        const config         = MAP_CONFIG[mapId];
        const layerConfig    = config.layers[layerKey] || Object.values(config.layers)[0];

        try {
            const markers = await fetchMarkers(mapId);

            if (!markers.length) {
                return interaction.editReply(`⚠️ No marker data returned for **${config.name}**.`);
            }

            console.log(`🎨 Rendering ${markers.length} raw markers → filter: ${categoryFilter}, layer: ${layerChoice}`);
            const imageBuffer = await generateMapImage(mapId, markers, categoryFilter, layerKey);

            // Always attach the rendered overlay
            const files = [new AttachmentBuilder(imageBuffer, { name: 'overlay.jpg' })];

            // Attach thumbnail from /assets/ if it exists
            const thumbnailFile = config.thumbnail
                ? path.join(__dirname, 'assets', config.thumbnail)
                : null;
            const hasThumbnail = thumbnailFile && fs.existsSync(thumbnailFile);
            if (hasThumbnail) {
                files.push(new AttachmentBuilder(thumbnailFile, { name: config.thumbnail }));
            }

            // Attach banner from /assets/ if it exists
            const bannerPath = path.join(__dirname, 'assets', 'banner.jpg');
            const hasBanner = fs.existsSync(bannerPath);
            if (hasBanner) {
                files.push(new AttachmentBuilder(bannerPath, { name: 'banner.jpg' }));
            }

            // Count what's actually shown after filters
            const shown = markers.filter(m => {
                const catOk   = categoryFilter === 'all' || m.category === categoryFilter;
                const layerOk = layerKey === 1 ? m.zlayers === 1 : m.zlayers !== 1;
                return catOk && layerOk;
            }).length;

            const stats = buildStats(markers);
            const topCategories = Object.entries(stats)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 6)
                .map(([k, v]) => ({ name: k, value: `${v}`, inline: true }));

            const embed = new EmbedBuilder()
                .setTitle(`🗺️ ${config.name} — ${layerConfig.label}`)
                .setDescription(
                    `Showing **${shown}** of **${markers.length}** total markers` +
                    (categoryFilter !== 'all' ? ` (filtered: \`${categoryFilter}\`)` : '') +
                    '\n\n**Marker Types:**\n🔴 Circle = ARC units  🔷 Diamond = High-value  🟦 Square = Containers  🔺 Triangle = Locations'
                )
                .addFields(...topCategories)
                .setColor(0x2f3542)
                .setImage('attachment://overlay.jpg')
                .setTimestamp()
                .setFooter({ text: `metaforge.app data · ${config.name}` });

            // Wire up /assets/ images to embed if they exist
            if (hasThumbnail) embed.setThumbnail(`attachment://${config.thumbnail}`);
            if (hasBanner)    embed.setAuthor({ name: 'ARC Raiders Map Intelligence', iconURL: 'attachment://banner.jpg' });

            return interaction.editReply({ embeds: [embed], files });

        } catch (err) {
            console.error('❌ Map generation error:', err);

            let msg = '❌ An error occurred generating the map overlay.';
            if (err.message?.startsWith('MISSING_IMAGE')) {
                const file = err.message.split(':')[1];
                msg = `❌ Map file \`${file}\` not found in \`/maps/\`. Check the filename matches exactly.`;
            } else if (err.code === 'ECONNABORTED') {
                msg = '❌ API request timed out. Try again in a moment.';
            }

            return interaction.editReply(msg);
        }
    }
});

client.login(TOKEN);
