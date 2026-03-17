'use strict';

const CHANNELS_INDEX_URL = 'data/channels/index.json';
const DEFAULT_PAGE_SIZE = 16;

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
  themeButton: document.getElementById('themeButton'),
  statusBanner: document.getElementById('statusBanner'),
  feedMeta: document.getElementById('feedMeta'),
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

function getPostPageUrl(post) {
  if (post?.permalink) return post.permalink;
  return `channels/${state.activeChannelKey}/posts/${post.id}/`;
}

function getActiveChannelMeta() {
  return getChannelByKey(state.activeChannelKey);
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('theme', theme);
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

function renderChannelMenu() {
  const channels = getCatalogChannels();
  elements.channelMenu.innerHTML = channels.map((channel) => {
    const isActive = channel.key === state.activeChannelKey;
    const rawLabel = channel.label || channel.channel_title || channel.channel_username || 'Channel';
    const parts = rawLabel.split('|').map((part) => part.trim()).filter(Boolean);
    const title = parts[0] || rawLabel;
    const subtitle = parts[1] || `@${channel.channel_username || 'channel'}`;
    return `
      <button
        class="channel-tab${isActive ? ' is-active' : ''}"
        type="button"
        data-channel-key="${channel.key}"
        aria-pressed="${isActive ? 'true' : 'false'}"
        aria-label="${escapeHtml(rawLabel)}"
        title="${escapeHtml(rawLabel)}"
      >
        <span class="channel-tab__meta">${isActive ? 'Сейчас открыт' : 'Перейти к каналу'}</span>
        <span class="channel-tab__title">${escapeHtml(title)}</span>
        <span class="channel-tab__subtitle">${escapeHtml(subtitle)}</span>
      </button>
    `;
  }).join('');
}

function renderHeader(site, generatedAt) {
  const catalogSite = getCatalogSite();
  const title = site.channel_title || site.site_name || catalogSite.site_name || 'Telegram Channels';
  const description = site.site_description || catalogSite.site_description || '';
  const handle = site.channel_username ? `@${site.channel_username}` : '@channel';

  elements.siteTitle.textContent = title;
  elements.siteDescription.textContent = description;
  elements.channelLink.textContent = handle;
  elements.channelLink.href = site.channel_username ? `https://t.me/${site.channel_username}` : 'https://t.me';
  elements.updatedText.textContent = `${timeAgo(generatedAt)} (${formatDate(generatedAt)})`;
  document.title = title;

  if (site.avatar_path) {
    elements.channelAvatar.src = site.avatar_path;
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
  if (ogImageMeta && site.avatar_path) ogImageMeta.setAttribute('content', site.avatar_path);
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

  const items = media.map((item, index) => {
    const content = item.type === 'video'
      ? `<video src="${item.url}" preload="metadata" muted playsinline controls></video>`
      : `<img src="${item.thumb_url}" alt="Media ${index + 1}" loading="lazy" decoding="async">`;
    return `<button class="media-trigger" type="button" data-index="${index}">${content}</button>`;
  }).join('');

  return `<div class="${galleryClass}" data-media-id="${mediaId}">${items}</div>`;
}

function renderPostCard(post) {
  const article = document.createElement('article');
  article.className = 'post-card';

  const text = post.text_html || escapeHtml(post.text || '').replace(/\n/g, '<br>');
  const commentsLabel = post.comments_count ? `Комментарии (${compactNumber(post.comments_count)})` : 'Комментарии';
  const shouldShowComments =
    Boolean(state.feed?.source?.comments_enabled) &&
    (post.comments_count > 0 || post.comments_url || post.comments_available);

  article.innerHTML = `
    ${buildMedia(post)}
    <div class="post-card__body">
      ${text ? `<div class="post-card__text">${text}</div>` : ''}
    </div>
    <div class="post-card__footer">
      <div class="post-card__stats">
        <span class="chip">${formatDate(post.date)}</span>
        <span class="chip">Просмотры: ${compactNumber(post.views)}</span>
        <span class="chip">ID: ${post.id}</span>
      </div>
      <div class="post-card__links">
        <a class="post-card__link" href="${getPostPageUrl(post)}">Открыть пост</a>
        ${shouldShowComments ? `<button class="button button--ghost comments-trigger" type="button" data-post-id="${post.id}">${commentsLabel}</button>` : ''}
        <a class="post-card__link" href="${post.tg_url}" target="_blank" rel="noopener">Открыть в Telegram</a>
      </div>
    </div>
  `;

  const mediaRoot = article.querySelector('[data-media-id]');
  if (mediaRoot) {
    const items = state.mediaRegistry[mediaRoot.dataset.mediaId] || [];
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
  if (!state.feed) {
    elements.feedMeta.classList.add('hidden');
    return;
  }

  const postsCount = state.totalPosts || state.posts.length;
  const renderedCount = Math.min(state.rendered, postsCount);
  const commentsStatus = state.feed.source.comments_enabled
    ? 'Комментарии: включены'
    : 'Комментарии: отключены';

  elements.feedMeta.innerHTML = `
    <span>Постов в ленте: <strong>${postsCount}</strong></span>
    <span>Показано: <strong>${renderedCount}</strong></span>
    <span>Страниц: <strong>${state.totalPages || 1}</strong></span>
    <span>${commentsStatus}</span>
  `;
  elements.feedMeta.classList.remove('hidden');
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
    setStatus(elements.statusBanner, `Ошибка подгрузки следующей страницы: ${error.message}`);
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
  elements.commentsTitle.textContent = post ? `Комментарии к посту #${post.id}` : 'Комментарии';
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
      setStatus(elements.commentsStatus, 'Комментарии для этого поста еще не сохранены.');
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
  setStatus(elements.statusBanner, force ? 'Принудительное обновление из браузера...' : null);

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

    setStatus(
      elements.statusBanner,
      `Последнее изменение данных: ${timeAgo(state.feed.generated_at)}. Источник: https://t.me/s/${state.feed.site.channel_username || ''}`
    );
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

elements.themeButton.addEventListener('click', () => {
  const nextTheme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  applyTheme(nextTheme);
});

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

window.addEventListener('hashchange', handleRoute);
window.addEventListener('popstate', handleLocationChange);
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
