'use strict';

const CHANNELS_INDEX_URL = 'data/channels/index.json';
const DEFAULT_PAGE_SIZE = 16;
const AUTO_REFRESH_INTERVAL_MINUTES = 5;
const SYNC_STATUS_POLL_INTERVAL_MS = 30 * 1000;
const INSTALL_PROMPT_STORAGE_KEY = 'pep-group-install-dismissed-v1';

const state = {
  catalog: null,
  activeChannelKey: null,
  feed: null,
  posts: [],
  rendered: 0,
  loadedPages: new Set(),
  totalPages: 1,
  totalPosts: 0,
  pageSize: DEFAULT_PAGE_SIZE,
  viewerItems: [],
  viewerIndex: 0,
  mediaRegistry: {},
  syncStatusPollId: null,
  deferredInstallPrompt: null,
};

const elements = {
  channelMenu: document.getElementById('channelMenu'),
  siteTitle: document.getElementById('siteTitle'),
  siteDescription: document.getElementById('siteDescription'),
  channelAvatarWrap: document.getElementById('channelAvatarWrap'),
  channelAvatar: document.getElementById('channelAvatar'),
  channelLink: document.getElementById('channelLink'),
  updatedText: document.getElementById('updatedText'),
  refreshButton: document.getElementById('refreshButton'),
  themeToggle: document.getElementById('themeToggle'),
  feedView: document.getElementById('feedView'),
  postFeed: document.getElementById('postFeed'),
  loadingState: document.getElementById('loadingState'),
  emptyState: document.getElementById('emptyState'),
  errorState: document.getElementById('errorState'),
  errorMessage: document.getElementById('errorMessage'),
  loadMoreWrap: document.getElementById('loadMoreWrap'),
  loadMoreButton: document.getElementById('loadMoreButton'),
  commentsView: document.getElementById('commentsView'),
  commentsTitle: document.getElementById('commentsTitle'),
  commentsStatus: document.getElementById('commentsStatus'),
  commentsList: document.getElementById('commentsList'),
  commentsLoading: document.getElementById('commentsLoading'),
  commentsEmpty: document.getElementById('commentsEmpty'),
  backButton: document.getElementById('backButton'),
  viewer: document.getElementById('viewer'),
  viewerClose: document.getElementById('viewerClose'),
  viewerPrev: document.getElementById('viewerPrev'),
  viewerNext: document.getElementById('viewerNext'),
  viewerContent: document.getElementById('viewerContent'),
  installPrompt: document.getElementById('installPrompt'),
  installButton: document.getElementById('installButton'),
  installDismiss: document.getElementById('installDismiss'),
};

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function timeAgo(iso) {
  if (!iso) return '—';
  const deltaMinutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (deltaMinutes < 2) return 'только что';
  if (deltaMinutes < 60) return `${deltaMinutes} мин назад`;
  const deltaHours = Math.floor(deltaMinutes / 60);
  if (deltaHours < 24) return `${deltaHours} ч назад`;
  const deltaDays = Math.floor(deltaHours / 24);
  return `${deltaDays} дн назад`;
}

function compactNumber(value) {
  const number = Number(value || 0);
  if (!number) return '0';
  if (number >= 1000000) return `${(number / 1000000).toFixed(1)}M`;
  if (number >= 1000) return `${(number / 1000).toFixed(1)}K`;
  return String(number);
}

function linkifyEscaped(text) {
  return escapeHtml(text || '').replace(
    /(https?:\/\/[^\s<]+)/g,
    '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>',
  );
}

function normalizePhoto(photo) {
  if (!photo) return null;
  if (typeof photo === 'string') {
    return { thumb_url: photo, full_url: photo };
  }

  const thumbUrl = photo.thumb_url || photo.thumb || photo.url || photo.full_url || photo.full;
  const fullUrl = photo.full_url || photo.full || photo.url || photo.thumb_url || photo.thumb;
  if (!thumbUrl && !fullUrl) return null;

  return {
    thumb_url: thumbUrl || fullUrl,
    full_url: fullUrl || thumbUrl,
  };
}

function getChannelKeyFromLocation() {
  const url = new URL(window.location.href);
  return url.searchParams.get('channel');
}

function getCatalogChannels() {
  return state.catalog?.channels || [];
}

function getCatalogSite() {
  return state.catalog?.site || {};
}

function getChannelByKey(channelKey) {
  return getCatalogChannels().find((channel) => channel.key === channelKey) || null;
}

function resolveChannelKey(requestedKey) {
  const channels = getCatalogChannels();
  if (!channels.length) return null;
  if (requestedKey && getChannelByKey(requestedKey)) return requestedKey;
  return state.catalog?.default_channel_key || channels[0].key;
}

function updateChannelUrl(channelKey, { replace = false, clearHash = false } = {}) {
  const url = new URL(window.location.href);
  url.searchParams.set('channel', channelKey);
  if (clearHash) url.hash = '';

  if (replace) {
    window.history.replaceState({}, '', url);
  } else {
    window.history.pushState({}, '', url);
  }
}

function buildChannelRoot(channelKey) {
  return `data/channels/${channelKey}`;
}

function buildFeedUrl(channelKey, force = false) {
  return `${buildChannelRoot(channelKey)}/posts.json${force ? `?t=${Date.now()}` : ''}`;
}

function buildPageUrl(channelKey, pageNumber) {
  return `${buildChannelRoot(channelKey)}/pages/${pageNumber}.json`;
}

function buildCommentsUrl(channelKey, postId) {
  return `${buildChannelRoot(channelKey)}/comments/${postId}.json?t=${Date.now()}`;
}

function getActiveChannelMeta() {
  return getChannelByKey(state.activeChannelKey);
}

function resolveHeroAvatar(site) {
  const catalogSite = getCatalogSite();
  const activeChannel = getActiveChannelMeta();
  const fallbackAvatar = catalogSite.avatar_path || 'assets/channel-avatar.jpg';
  const siteAvatar = site?.avatar_path || '';
  const channelAvatar = activeChannel?.avatar_path || '';
  const usesStaticFallback = !siteAvatar || siteAvatar === fallbackAvatar || /assets\/channel-avatar\.jpg$/i.test(siteAvatar);

  if (channelAvatar && usesStaticFallback) {
    return channelAvatar;
  }

  return siteAvatar || channelAvatar || fallbackAvatar;
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('theme', theme);
  if (elements.themeToggle) {
    elements.themeToggle.checked = theme === 'dark';
  }
}

function initTheme() {
  const saved = localStorage.getItem('theme');
  const preferredDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(saved || (preferredDark ? 'dark' : 'light'));
}

function setStatus(target, message) {
  if (!message) {
    target.classList.add('hidden');
    target.textContent = '';
    return;
  }

  target.classList.remove('hidden');
  target.textContent = message;
}

function clearSyncStatusPolling() {
  if (state.syncStatusPollId) {
    window.clearInterval(state.syncStatusPollId);
    state.syncStatusPollId = null;
  }
}

function isStandaloneMode() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function isDesktopViewport() {
  return window.matchMedia('(min-width: 861px)').matches;
}

function isInstallPromptDismissed() {
  return localStorage.getItem(INSTALL_PROMPT_STORAGE_KEY) === '1';
}

function dismissInstallPrompt({ persist = false } = {}) {
  if (persist) {
    localStorage.setItem(INSTALL_PROMPT_STORAGE_KEY, '1');
  }

  if (elements.installPrompt) {
    elements.installPrompt.classList.add('hidden');
  }
}

function maybeShowInstallPrompt() {
  if (!elements.installPrompt || !state.deferredInstallPrompt) return;
  if (isStandaloneMode() || !isDesktopViewport() || isInstallPromptDismissed()) return;
  elements.installPrompt.classList.remove('hidden');
}

function getLastScheduledSyncTime(reference = new Date()) {
  const syncTime = new Date(reference);
  syncTime.setSeconds(0, 0);
  const alignedMinutes = Math.floor(syncTime.getMinutes() / AUTO_REFRESH_INTERVAL_MINUTES) * AUTO_REFRESH_INTERVAL_MINUTES;
  syncTime.setMinutes(alignedMinutes);
  return syncTime;
}

function updateSyncTimestamp() {
  elements.updatedText.textContent = formatDate(getLastScheduledSyncTime());
}

function startSyncStatusPolling() {
  clearSyncStatusPolling();
  updateSyncTimestamp();
  state.syncStatusPollId = window.setInterval(updateSyncTimestamp, SYNC_STATUS_POLL_INTERVAL_MS);
}

function renderChannelMenu() {
  const channels = getCatalogChannels();
  elements.channelMenu.style.setProperty('--channel-count', String(channels.length || 1));
  elements.channelMenu.innerHTML = channels.map((channel) => {
    const isActive = channel.key === state.activeChannelKey;
    const rawLabel = channel.label || channel.channel_title || channel.channel_username || 'Channel';
    const parts = rawLabel.split('|').map((part) => part.trim()).filter(Boolean);
    const title = parts[1] || channel.menu_title || channel.channel_title || rawLabel;
    const subtitle = channel.menu_subtitle || parts[0] || `@${channel.channel_username || 'channel'}`;
    return `
      <button
        class="channel-tab${isActive ? ' is-active' : ''}"
        type="button"
        data-channel-key="${channel.key}"
        aria-pressed="${isActive ? 'true' : 'false'}"
        aria-label="${escapeHtml(rawLabel)}"
        title="${escapeHtml(rawLabel)}"
      >
        <span class="channel-tab__meta">${isActive ? 'Открыт' : 'Канал'}</span>
        <span class="channel-tab__title">${formatTextWithSoftBreaks(title)}</span>
        <span class="channel-tab__subtitle">${formatTextWithSoftBreaks(subtitle)}</span>
      </button>
    `;
  }).join('');
}

function formatTextWithSoftBreaks(value) {
  return escapeHtml(String(value || '').trim()).replace(/([a-zа-яё])([A-ZА-ЯЁ])/g, '$1<wbr>$2');
}

function renderHeroTitle(title) {
  const rawTitle = String(title || '').trim();
  if (!rawTitle) return '';

  const parts = rawTitle.split('|').map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) {
    return `<span class="hero__title-line">${formatTextWithSoftBreaks(rawTitle)}</span>`;
  }

  const firstPart = parts[0] || '';
  const secondPart = parts[1] || '';
  const latinPattern = /[A-Za-z]/;
  const cyrillicPattern = /[А-Яа-яЁё]/;
  const orderedParts =
    latinPattern.test(firstPart) && cyrillicPattern.test(secondPart)
      ? [secondPart, firstPart]
      : parts;

  return orderedParts.map((part, index) => `
    <span class="hero__title-line${index === 0 ? ' hero__title-line--lead' : ''}">${formatTextWithSoftBreaks(part)}</span>
  `).join('');
}

function renderHeader(site, generatedAt) {
  const catalogSite = getCatalogSite();
  const activeChannel = getActiveChannelMeta();
  const title = activeChannel?.channel_title || site.channel_title || site.site_name || catalogSite.site_name || 'Telegram Channels';
  const description = activeChannel?.site_description || site.site_description || catalogSite.site_description || '';
  const handle = site.channel_username ? `@${site.channel_username}` : '@channel';
  const avatarSrc = resolveHeroAvatar(site);
  const fallbackAvatar = catalogSite.avatar_path || 'assets/channel-avatar.jpg';

  elements.siteTitle.innerHTML = renderHeroTitle(title);
  elements.siteDescription.textContent = description;
  elements.channelLink.textContent = handle;
  elements.channelLink.href = site.channel_username ? `https://t.me/${site.channel_username}` : 'https://t.me';
  startSyncStatusPolling();
  document.title = title;

  if (avatarSrc) {
    elements.channelAvatar.dataset.fallbackSrc = fallbackAvatar;
    elements.channelAvatar.dataset.fallbackApplied = 'false';
    elements.channelAvatar.src = avatarSrc;
    elements.channelAvatar.alt = title;
    elements.channelAvatarWrap.classList.remove('hidden');
  } else {
    elements.channelAvatarWrap.classList.add('hidden');
  }

  if (site.accent_color) {
    document.documentElement.style.setProperty('--accent', site.accent_color);
    const themeColorMeta = document.querySelector('meta[name="theme-color"]');
    if (themeColorMeta) themeColorMeta.setAttribute('content', site.accent_color);
  }

  if (site.background_color) {
    document.documentElement.style.setProperty('--bg', site.background_color);
  }

  const descriptionMeta = document.querySelector('meta[name="description"]');
  const ogTitleMeta = document.querySelector('meta[property="og:title"]');
  const ogDescriptionMeta = document.querySelector('meta[property="og:description"]');
  const ogImageMeta = document.querySelector('meta[property="og:image"]');

  if (descriptionMeta) descriptionMeta.setAttribute('content', description);
  if (ogTitleMeta) ogTitleMeta.setAttribute('content', title);
  if (ogDescriptionMeta) ogDescriptionMeta.setAttribute('content', description);
  if (ogImageMeta && avatarSrc) ogImageMeta.setAttribute('content', avatarSrc);
}

function buildResponsiveImageTag(item, index, isGallery) {
  const fallbackSrc = item.thumb_url || item.full_url;
  if (!fallbackSrc) return '';

  const srcSet = item.thumb_url && item.full_url && item.thumb_url !== item.full_url
    ? `${item.thumb_url} 1280w, ${item.full_url} 2400w`
    : '';
  const sizes = isGallery
    ? '(max-width: 480px) calc(100vw - 44px), (max-width: 860px) calc(50vw - 28px), 520px'
    : '(max-width: 860px) calc(100vw - 44px), 980px';

  return `
    <img
      src="${fallbackSrc}"
      ${srcSet ? `srcset="${srcSet}" sizes="${sizes}"` : ''}
      alt="Media ${index + 1}"
      loading="lazy"
      decoding="async"
    >
  `;
}

function buildMedia(post) {
  const media = [];

  (post.photos || []).forEach((photo) => {
    const entry = normalizePhoto(photo);
    if (entry) {
      media.push({ type: 'image', thumb_url: entry.thumb_url, full_url: entry.full_url });
    }
  });

  if (post.video_url) {
    media.push({ type: 'video', url: post.video_url });
  }

  if (!media.length) return '';

  const galleryClass = media.length > 1 ? 'post-card__media post-card__media--gallery' : 'post-card__media';
  const mediaId = `${state.activeChannelKey}-media-${post.id}`;
  state.mediaRegistry[mediaId] = media;
  const isGallery = media.length > 1;

  const items = media.map((item, index) => {
    const content = item.type === 'video'
      ? `<video src="${item.url}" preload="metadata" muted playsinline controls></video>`
      : buildResponsiveImageTag(item, index, isGallery);
    return `<button class="media-trigger" type="button" data-index="${index}">${content}</button>`;
  }).join('');

  return `<div class="${galleryClass}" data-media-id="${mediaId}">${items}</div>`;
}

function getAverageEdgeColor(image) {
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  if (!width || !height) return null;

  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;

  canvas.width = 12;
  canvas.height = 12;

  try {
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let red = 0;
    let green = 0;
    let blue = 0;
    let alpha = 0;
    let samples = 0;

    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        const isEdge = x === 0 || y === 0 || x === canvas.width - 1 || y === canvas.height - 1;
        if (!isEdge) continue;

        const offset = (y * canvas.width + x) * 4;
        const currentAlpha = data[offset + 3] / 255;
        if (currentAlpha <= 0.02) continue;

        red += data[offset];
        green += data[offset + 1];
        blue += data[offset + 2];
        alpha += currentAlpha;
        samples += 1;
      }
    }

    if (!samples) return null;

    const soften = (value) => Math.round(value / samples * 0.9 + 255 * 0.1);
    const normalizedAlpha = Math.min(0.92, Math.max(0.42, alpha / samples));

    return `rgba(${soften(red)}, ${soften(green)}, ${soften(blue)}, ${normalizedAlpha.toFixed(3)})`;
  } catch {
    return null;
  }
}

function applyMediaFill(image) {
  const trigger = image.closest('.media-trigger');
  if (!trigger || trigger.dataset.fillReady === 'true') return;

  const fillColor = getAverageEdgeColor(image);
  if (!fillColor) return;

  trigger.style.setProperty('--media-fill', fillColor);
  trigger.dataset.fillReady = 'true';
}

function bindMediaFill(root) {
  root.querySelectorAll('.media-trigger img').forEach((image) => {
    if (image.complete) {
      applyMediaFill(image);
      return;
    }

    image.addEventListener('load', () => applyMediaFill(image), { once: true });
  });
}

function resolveForwardedSource(post) {
  const forwarded = post.forwarded_from;
  if (!forwarded) return null;

  const username = forwarded.channel_username || '';
  const localChannel = username
    ? getCatalogChannels().find((channel) => String(channel.channel_username || '').toLowerCase() === String(username).toLowerCase())
    : null;
  const label = forwarded.channel_title || localChannel?.channel_title || (username ? `@${username}` : 'источника');

  if (localChannel) {
    return {
      label,
      href: `?channel=${localChannel.key}`,
      external: false,
    };
  }

  return {
    label,
    href: forwarded.channel_url || forwarded.source_url || (username ? `https://t.me/s/${username}` : '#'),
    external: true,
  };
}

function renderPostCard(post) {
  const article = document.createElement('article');
  article.className = 'post-card';

  const text = post.text_html || escapeHtml(post.text || '').replace(/\n/g, '<br>');
  const forwarded = resolveForwardedSource(post);
  const commentsLabel = post.comments_count ? `Комментарии (${compactNumber(post.comments_count)})` : 'Комментарии';
  const shouldShowComments =
    Boolean(state.feed?.source?.comments_enabled) &&
    (post.comments_count > 0 || post.comments_url || post.comments_available);

  article.innerHTML = `
    ${buildMedia(post)}
    <div class="post-card__body">
      ${forwarded ? `<div class="post-card__forwarded">Переслано из канала <a href="${forwarded.href}"${forwarded.external ? ' target="_blank" rel="noopener"' : ''}>${escapeHtml(forwarded.label)}</a></div>` : ''}
      ${text ? `<div class="post-card__text">${text}</div>` : ''}
    </div>
    <div class="post-card__footer">
      <div class="post-card__stats">
        <span class="chip">${formatDate(post.date)}</span>
      </div>
      <div class="post-card__links">
        ${shouldShowComments ? `<button class="button button--ghost comments-trigger" type="button" data-post-id="${post.id}">${commentsLabel}</button>` : ''}
        <a class="post-card__link" href="${post.tg_url}" target="_blank" rel="noopener">Открыть в Telegram</a>
      </div>
    </div>
  `;

  const mediaRoot = article.querySelector('[data-media-id]');
  if (mediaRoot) {
    const items = state.mediaRegistry[mediaRoot.dataset.mediaId] || [];
    bindMediaFill(mediaRoot);
    mediaRoot.querySelectorAll('.media-trigger').forEach((button) => {
      button.addEventListener('click', () => openViewer(items, Number(button.dataset.index)));
    });
  }

  const commentsButton = article.querySelector('.comments-trigger');
  if (commentsButton) {
    commentsButton.addEventListener('click', () => {
      window.location.hash = `comments-${post.id}`;
    });
  }

  return article;
}

function updateFeedMeta() {
  return;
}

function resetFeed() {
  state.rendered = 0;
  elements.postFeed.innerHTML = '';
  void appendNextPage();
}

function updateLoadMoreVisibility() {
  const hasMoreLoadedPosts = state.rendered < state.posts.length;
  const hasMoreRemotePages = state.loadedPages.size < state.totalPages;
  elements.loadMoreWrap.classList.toggle('hidden', !(hasMoreLoadedPosts || hasMoreRemotePages));
}

async function loadPage(pageNumber) {
  if (state.loadedPages.has(pageNumber) || pageNumber < 2 || pageNumber > state.totalPages) {
    return;
  }

  const response = await fetch(buildPageUrl(state.activeChannelKey, pageNumber), { cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const payload = await response.json();
  state.posts.push(...(payload.posts || []));
  state.loadedPages.add(pageNumber);
}

async function appendNextPage() {
  try {
    if (state.rendered >= state.posts.length && state.loadedPages.size < state.totalPages) {
      elements.loadMoreButton.disabled = true;
      await loadPage(state.loadedPages.size + 1);
    }
  } catch (error) {
    elements.loadMoreButton.disabled = false;
    return;
  }

  const nextPosts = state.posts.slice(state.rendered, state.rendered + state.pageSize);
  const fragment = document.createDocumentFragment();
  nextPosts.forEach((post) => fragment.appendChild(renderPostCard(post)));
  elements.postFeed.appendChild(fragment);
  state.rendered += nextPosts.length;
  elements.loadMoreButton.disabled = false;
  updateLoadMoreVisibility();
  updateFeedMeta();
}

function openViewer(items, index) {
  state.viewerItems = items;
  state.viewerIndex = index;
  renderViewer();
  elements.viewer.classList.remove('hidden');
  elements.viewer.setAttribute('aria-hidden', 'false');
}

function closeViewer() {
  elements.viewer.classList.add('hidden');
  elements.viewer.setAttribute('aria-hidden', 'true');
  elements.viewerContent.innerHTML = '';
}

function renderViewer() {
  const item = state.viewerItems[state.viewerIndex];
  if (!item) return;

  elements.viewerContent.innerHTML = item.type === 'video'
    ? `<video src="${item.url}" controls autoplay></video>`
    : `<img src="${item.full_url || item.thumb_url}" alt="Media preview">`;

  const hasMultiple = state.viewerItems.length > 1;
  elements.viewerPrev.classList.toggle('hidden', !hasMultiple);
  elements.viewerNext.classList.toggle('hidden', !hasMultiple);
}

function showFeedView() {
  elements.commentsView.classList.add('hidden');
  elements.feedView.classList.remove('hidden');
}

function sanitizeCommentText(text) {
  return linkifyEscaped(text || '').replace(/\n/g, '<br>');
}

function renderComment(comment) {
  const node = document.createElement('article');
  node.className = 'comment-card';
  node.innerHTML = `
    <div class="comment-card__header">
      <strong class="comment-card__author">${escapeHtml(comment.author || 'Telegram user')}</strong>
      <span class="comment-card__date">${formatDate(comment.date)}</span>
    </div>
    <div class="comment-card__text">${sanitizeCommentText(comment.text)}</div>
  `;
  return node;
}

async function showComments(postId) {
  const post = state.posts.find((entry) => String(entry.id) === String(postId));
  elements.commentsTitle.textContent = post ? 'Комментарии к посту' : 'Комментарии';
  elements.commentsList.innerHTML = '';
  elements.commentsEmpty.classList.add('hidden');
  elements.commentsLoading.classList.remove('hidden');
  setStatus(elements.commentsStatus, null);
  elements.feedView.classList.add('hidden');
  elements.commentsView.classList.remove('hidden');

  try {
    const response = await fetch(buildCommentsUrl(state.activeChannelKey, postId), { cache: 'no-store' });
    if (response.status === 404) {
      elements.commentsLoading.classList.add('hidden');
      elements.commentsEmpty.classList.remove('hidden');
      setStatus(elements.commentsStatus, null);
      return;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const payload = await response.json();
    const comments = payload.comments || [];
    elements.commentsLoading.classList.add('hidden');

    if (!comments.length) {
      elements.commentsEmpty.classList.remove('hidden');
      setStatus(elements.commentsStatus, `Обновлено ${timeAgo(payload.generated_at)}`);
      return;
    }

    const fragment = document.createDocumentFragment();
    comments.forEach((comment) => fragment.appendChild(renderComment(comment)));
    elements.commentsList.appendChild(fragment);
    setStatus(
      elements.commentsStatus,
      `Комментариев: ${comments.length}. Последний sync: ${timeAgo(payload.generated_at)}`
    );
  } catch (error) {
    elements.commentsLoading.classList.add('hidden');
    elements.commentsEmpty.classList.remove('hidden');
    setStatus(elements.commentsStatus, `Ошибка загрузки комментариев: ${error.message}`);
  }
}

function handleRoute() {
  const match = window.location.hash.match(/^#comments-(\d+)$/);
  if (match) {
    void showComments(match[1]);
    return;
  }

  showFeedView();
}

async function loadFeed(channelKey, force = false) {
  state.activeChannelKey = channelKey;
  state.mediaRegistry = {};
  renderChannelMenu();

  elements.loadingState.classList.remove('hidden');
  elements.emptyState.classList.add('hidden');
  elements.errorState.classList.add('hidden');
  elements.postFeed.innerHTML = '';
  showFeedView();

  try {
    const response = await fetch(buildFeedUrl(channelKey, force), { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    state.feed = await response.json();
    const pagination = state.feed.pagination || {};
    state.posts = state.feed.posts || [];
    state.totalPosts = Number(pagination.total_posts) || state.posts.length;
    state.totalPages = Number(pagination.total_pages) || 1;
    state.pageSize = Number(pagination.page_size) || DEFAULT_PAGE_SIZE;
    state.loadedPages = new Set(state.posts.length ? [1] : []);

    renderHeader(state.feed.site || getActiveChannelMeta() || getCatalogSite(), state.feed.generated_at);
    elements.loadingState.classList.add('hidden');

    if (!state.posts.length) {
      elements.emptyState.classList.remove('hidden');
      updateFeedMeta();
      updateLoadMoreVisibility();
      handleRoute();
      return;
    }

    resetFeed();
    handleRoute();
  } catch (error) {
    elements.loadingState.classList.add('hidden');
    elements.errorState.classList.remove('hidden');
    elements.errorMessage.textContent = `Ошибка: ${error.message}`;
  }
}

async function switchChannel(channelKey, { replace = false, force = false } = {}) {
  const resolvedChannelKey = resolveChannelKey(channelKey);
  if (!resolvedChannelKey) return;

  const shouldClearHash = window.location.hash.startsWith('#comments-');
  const shouldUpdateUrl = getChannelKeyFromLocation() !== resolvedChannelKey || shouldClearHash;
  if (shouldUpdateUrl) {
    updateChannelUrl(resolvedChannelKey, { replace, clearHash: shouldClearHash });
  }

  await loadFeed(resolvedChannelKey, force);
}

async function loadCatalog() {
  elements.loadingState.classList.remove('hidden');
  elements.emptyState.classList.add('hidden');
  elements.errorState.classList.add('hidden');

  try {
    const response = await fetch(`${CHANNELS_INDEX_URL}?t=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    state.catalog = await response.json();
    const initialChannelKey = resolveChannelKey(getChannelKeyFromLocation());

    if (!initialChannelKey) {
      throw new Error('Каталог каналов пуст.');
    }

    renderChannelMenu();

    if (getChannelKeyFromLocation() !== initialChannelKey) {
      updateChannelUrl(initialChannelKey, { replace: true });
    }

    await loadFeed(initialChannelKey);
  } catch (error) {
    elements.loadingState.classList.add('hidden');
    elements.errorState.classList.remove('hidden');
    elements.errorMessage.textContent = `Ошибка: ${error.message}`;
  }
}

function handleLocationChange() {
  if (!state.catalog) return;

  const nextChannelKey = resolveChannelKey(getChannelKeyFromLocation());
  if (nextChannelKey && nextChannelKey !== state.activeChannelKey) {
    void loadFeed(nextChannelKey);
    return;
  }

  handleRoute();
}

initTheme();

if (elements.themeToggle) {
  elements.themeToggle.addEventListener('change', (event) => {
    applyTheme(event.target.checked ? 'dark' : 'light');
  });
}

elements.channelMenu.addEventListener('click', (event) => {
  const button = event.target.closest('[data-channel-key]');
  if (!button) return;

  const nextChannelKey = button.dataset.channelKey;
  if (!nextChannelKey || nextChannelKey === state.activeChannelKey) return;

  void switchChannel(nextChannelKey);
});

elements.refreshButton.addEventListener('click', () => {
  if (state.activeChannelKey) {
    void loadFeed(state.activeChannelKey, true);
  }
});

elements.loadMoreButton.addEventListener('click', appendNextPage);
elements.backButton.addEventListener('click', () => {
  if (window.location.hash.startsWith('#comments-')) {
    window.location.hash = '';
  } else {
    showFeedView();
  }
});

elements.viewerClose.addEventListener('click', closeViewer);
elements.viewer.addEventListener('click', (event) => {
  if (event.target === elements.viewer) closeViewer();
});
elements.viewerPrev.addEventListener('click', () => {
  state.viewerIndex = (state.viewerIndex - 1 + state.viewerItems.length) % state.viewerItems.length;
  renderViewer();
});
elements.viewerNext.addEventListener('click', () => {
  state.viewerIndex = (state.viewerIndex + 1) % state.viewerItems.length;
  renderViewer();
});

elements.channelAvatar.addEventListener('error', () => {
  const fallbackSrc = elements.channelAvatar.dataset.fallbackSrc || 'assets/channel-avatar.jpg';
  if (elements.channelAvatar.dataset.fallbackApplied === 'true') {
    return;
  }

  elements.channelAvatar.dataset.fallbackApplied = 'true';
  elements.channelAvatar.src = fallbackSrc;
});

if (elements.installButton) {
  elements.installButton.addEventListener('click', async () => {
    if (!state.deferredInstallPrompt) return;

    const promptEvent = state.deferredInstallPrompt;
    state.deferredInstallPrompt = null;
    elements.installPrompt.classList.add('hidden');

    await promptEvent.prompt();
    const choice = await promptEvent.userChoice;

    if (choice.outcome !== 'accepted') {
      dismissInstallPrompt({ persist: true });
    }
  });
}

if (elements.installDismiss) {
  elements.installDismiss.addEventListener('click', () => {
    dismissInstallPrompt({ persist: true });
  });
}

window.addEventListener('hashchange', handleRoute);
window.addEventListener('popstate', handleLocationChange);
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  state.deferredInstallPrompt = event;
  maybeShowInstallPrompt();
});
window.addEventListener('appinstalled', () => {
  state.deferredInstallPrompt = null;
  dismissInstallPrompt({ persist: true });
});
window.addEventListener('resize', maybeShowInstallPrompt);
window.addEventListener('keydown', (event) => {
  if (elements.viewer.classList.contains('hidden')) return;
  if (event.key === 'Escape') closeViewer();
  if (event.key === 'ArrowLeft' && state.viewerItems.length > 1) elements.viewerPrev.click();
  if (event.key === 'ArrowRight' && state.viewerItems.length > 1) elements.viewerNext.click();
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js')
    .then((registration) => registration.update())
    .catch(() => {});
}

loadCatalog();
maybeShowInstallPrompt();
