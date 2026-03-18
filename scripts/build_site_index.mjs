import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..');
const docsDir = path.join(rootDir, 'docs');
const dataDir = path.join(docsDir, 'data');
const channelsDataDir = path.join(dataDir, 'channels');
const configPath = path.join(rootDir, 'config', 'channels.json');
const manifestPath = path.join(docsDir, 'manifest.webmanifest');
const indexPath = path.join(channelsDataDir, 'index.json');
const pageSize = 16;

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const generatedAt = new Date().toISOString();

function ensureDir(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function writeJson(filePath, payload) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function buildTelegramAvatarUrl(channelUsername) {
  if (!channelUsername) {
    return null;
  }

  return `https://t.me/i/userpic/320/${channelUsername}.jpg`;
}

function resolveChannelAvatarPath(channel) {
  const mirroredAvatarPath = path.join(channelsDataDir, channel.key, 'media', 'channel-avatar.jpg');
  if (fs.existsSync(mirroredAvatarPath)) {
    return `data/channels/${channel.key}/media/channel-avatar.jpg`;
  }

  return buildTelegramAvatarUrl(channel.channel_username) || channel.avatar_path || config.avatar_path;
}

function buildChannelSite(channel) {
  return {
    channel_username: channel.channel_username,
    channel_title: channel.channel_title,
    site_name: channel.channel_title,
    site_description: channel.site_description,
    language: channel.language || config.language,
    accent_color: channel.accent_color || config.accent_color,
    background_color: channel.background_color || config.background_color,
    avatar_path: resolveChannelAvatarPath(channel),
  };
}

function buildEmptyFeed(channel) {
  return {
    generated_at: generatedAt,
    site: buildChannelSite(channel),
    source: {
      channel_key: channel.key,
      channel_url: `https://t.me/s/${channel.channel_username}`,
      comments_enabled: false,
    },
    pagination: {
      page: 1,
      page_size: pageSize,
      total_posts: 0,
      total_pages: 1,
    },
    posts: [],
  };
}

ensureDir(channelsDataDir);

const manifest = {
  name: config.site_name,
  short_name: config.short_name || config.site_name.slice(0, 12),
  description: config.site_description,
  start_url: './',
  display: 'standalone',
  background_color: config.background_color,
  theme_color: config.accent_color,
  lang: config.language,
  icons: [
    {
      src: 'assets/icon.svg',
      sizes: 'any',
      type: 'image/svg+xml',
      purpose: 'any maskable'
    },
    {
      src: 'assets/icon-192.png',
      sizes: '192x192',
      type: 'image/png',
      purpose: 'any maskable'
    },
    {
      src: 'assets/icon-512.png',
      sizes: '512x512',
      type: 'image/png',
      purpose: 'any maskable'
    }
  ]
};

fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

const catalog = {
  generated_at: generatedAt,
  site: {
    site_name: config.site_name,
    site_description: config.site_description,
    language: config.language,
    accent_color: config.accent_color,
    background_color: config.background_color,
    avatar_path: config.avatar_path,
  },
  default_channel_key: config.default_channel_key || config.channels[0]?.key || null,
  channels: config.channels.map((channel) => ({
    key: channel.key,
    label: channel.label || channel.channel_title,
    menu_subtitle: channel.menu_subtitle || null,
    channel_username: channel.channel_username,
    channel_title: channel.channel_title,
    site_description: channel.site_description,
    language: channel.language || config.language,
    accent_color: channel.accent_color || config.accent_color,
    background_color: channel.background_color || config.background_color,
    avatar_path: resolveChannelAvatarPath(channel),
    channel_url: `https://t.me/${channel.channel_username}`,
    feed_path: `data/channels/${channel.key}/posts.json`,
  })),
};

writeJson(indexPath, catalog);

for (const channel of config.channels) {
  const channelDir = path.join(channelsDataDir, channel.key);
  ensureDir(channelDir);
  ensureDir(path.join(channelDir, 'comments'));

  const feedPath = path.join(channelDir, 'posts.json');
  if (!fs.existsSync(feedPath)) {
    writeJson(feedPath, buildEmptyFeed(channel));
  }
}
