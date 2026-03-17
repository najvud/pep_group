import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..');
const configPath = path.join(rootDir, 'config', 'channels.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

const failures = [];

for (const channel of config.channels) {
  const env = {
    ...process.env,
    TG_CHANNEL_KEY: channel.key,
    TG_CHANNEL_USERNAME: channel.channel_username,
    TG_CHANNEL_TITLE: channel.channel_title,
    TG_SITE_NAME: channel.channel_title,
    TG_SITE_DESCRIPTION: channel.site_description,
    TG_LANGUAGE: channel.language || config.language,
    TG_ACCENT_COLOR: channel.accent_color || config.accent_color,
    TG_BACKGROUND_COLOR: channel.background_color || config.background_color,
    TG_AVATAR_PATH: channel.avatar_path || config.avatar_path,
    TG_MESSAGES_LIMIT: String(channel.messages_limit || config.messages_limit || 250),
    TG_RECENT_POSTS_MONTHS: String(channel.recent_posts_months || config.recent_posts_months || 3),
    TG_COMMENTS_POSTS_LIMIT: String(channel.comments_posts_limit || config.comments_posts_limit || 40),
    TG_COMMENTS_MAX_AGE_DAYS: String(channel.comments_max_age_days || config.comments_max_age_days || 7),
  };

  console.log(`\n=== Syncing ${channel.channel_title} (@${channel.channel_username}) ===`);
  const result = spawnSync('python', ['scripts/sync_channel.py'], {
    cwd: rootDir,
    env,
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    failures.push(channel.key);
  }
}

if (failures.length) {
  console.error(`Failed channels: ${failures.join(', ')}`);
  process.exit(1);
}
