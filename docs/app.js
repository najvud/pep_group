'use strict';

const CHANNELS_INDEX_URL = 'data/channels/index.json';
const DEFAULT_PAGE_SIZE = 16;
const AUTO_REFRESH_INTERVAL_MINUTES = 5;
const SYNC_STATUS_POLL_INTERVAL_MS = 30 * 1000;
const LONG_PRESS_COPY_DELAY_MS = 650;
const CHANNEL_CAROUSEL_TRANSITION_MS = 560;
const CHANNEL_CONTENT_FADE_OUT_MS = 180;
const CHANNEL_CONTENT_FADE_IN_DELAY_MS = 60;

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
  copyToastTimeoutId: null,
  channelAccentCache: {},
  channelCarouselTouch: null,
  channelCarouselAnimating: false,
  channelCarouselTransition: null,
  channelCarouselAutotest: null,
};

const elements = {
  channelMenu: document.getElementById('channelMenu'),
  channelCarousel: document.getElementById('channelCarousel'),
  siteShell: document.querySelector('.site-shell'),
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
  installAppButton: document.getElementById('installAppButton'),
  copyToast: document.getElementById('copyToast'),
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

function linkifyText(text) {
  const source = String(text || '');
  const pattern = /(?<![@\w])((?:https?:\/\/)?(?:www\.)?(?:[a-zа-яё0-9-]+\.)+[a-zа-яё]{2,}(?:\/[^\s<]*)?)/giu;

  let lastIndex = 0;
  let result = '';

  for (const match of source.matchAll(pattern)) {
    const matchedText = match[0];
    const startIndex = match.index ?? 0;

    result += escapeHtml(source.slice(lastIndex, startIndex));

    let visibleText = matchedText;
    let trailingPunctuation = '';

    while (/[),.!?:;]$/.test(visibleText)) {
      trailingPunctuation = visibleText.slice(-1) + trailingPunctuation;
      visibleText = visibleText.slice(0, -1);
    }

    const href = /^(?:https?:)?\/\//i.test(visibleText)
      ? visibleText
      : `https://${visibleText}`;

    result += `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(visibleText)}</a>`;
    result += escapeHtml(trailingPunctuation);
    lastIndex = startIndex + matchedText.length;
  }

  result += escapeHtml(source.slice(lastIndex));
  return result.replace(/\r?\n/g, '<br>');
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

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function componentToHex(value) {
  return clamp(Math.round(value), 0, 255).toString(16).padStart(2, '0');
}

function rgbToHex(r, g, b) {
  return `#${componentToHex(r)}${componentToHex(g)}${componentToHex(b)}`;
}

function hexToRgb(hex) {
  const value = String(hex || '').trim().replace(/^#/, '');
  if (!/^[\da-f]{6}$/i.test(value)) return null;
  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16),
  };
}

function mixHexColors(baseHex, targetHex, ratio) {
  const base = hexToRgb(baseHex);
  const target = hexToRgb(targetHex);
  if (!base || !target) return baseHex;
  const weight = clamp(ratio, 0, 1);
  return rgbToHex(
    base.r + (target.r - base.r) * weight,
    base.g + (target.g - base.g) * weight,
    base.b + (target.b - base.b) * weight,
  );
}

function hexToRgba(hex, alpha) {
  const rgb = hexToRgb(hex);
  if (!rgb) return `rgba(145, 39, 141, ${alpha})`;
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
}

function normalizeAccentHex(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return '#91278d';

  const max = Math.max(rgb.r, rgb.g, rgb.b);
  const min = Math.min(rgb.r, rgb.g, rgb.b);
  const brightness = (rgb.r + rgb.g + rgb.b) / 3;
  const chroma = max - min;

  let normalized = rgbToHex(rgb.r, rgb.g, rgb.b);

  if (chroma < 24) {
    normalized = mixHexColors(normalized, '#91278d', 0.42);
  }

  if (brightness > 214) {
    normalized = mixHexColors(normalized, '#2b233f', 0.34);
  } else if (brightness < 62) {
    normalized = mixHexColors(normalized, '#ffffff', 0.2);
  }

  return normalized;
}

function buildChannelAccentStyle(channel) {
  const accentHex = normalizeAccentHex(channel.accent_color || state.channelAccentCache[channel.key] || '#91278d');
  const strongHex = mixHexColors(accentHex, '#1f1934', 0.24);
  const borderColor = hexToRgba(accentHex, 0.34);
  const glowColor = hexToRgba(accentHex, 0.28);
  const ringColor = hexToRgba(accentHex, 0.16);

  return [
    `--channel-active:${accentHex}`,
    `--channel-active-strong:${strongHex}`,
    `--channel-active-border:${borderColor}`,
    `--channel-active-glow:${glowColor}`,
    `--channel-active-ring:${ringColor}`,
  ].join(';');
}

async function extractAccentColorFromImage(src) {
  if (!src) return null;

  return new Promise((resolve) => {
    const image = new Image();
    image.decoding = 'async';
    image.crossOrigin = 'anonymous';

    image.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 24;
        canvas.height = 24;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) {
          resolve(null);
          return;
        }

        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const data = context.getImageData(0, 0, canvas.width, canvas.height).data;

        let weightedR = 0;
        let weightedG = 0;
        let weightedB = 0;
        let weightedTotal = 0;
        let fallbackR = 0;
        let fallbackG = 0;
        let fallbackB = 0;
        let fallbackTotal = 0;

        for (let index = 0; index < data.length; index += 4) {
          const alpha = data[index + 3];
          if (alpha < 160) continue;

          const red = data[index];
          const green = data[index + 1];
          const blue = data[index + 2];

          fallbackR += red;
          fallbackG += green;
          fallbackB += blue;
          fallbackTotal += 1;

          const max = Math.max(red, green, blue);
          const min = Math.min(red, green, blue);
          const chroma = max - min;
          const brightness = (red + green + blue) / 3;

          if (brightness < 22 || brightness > 245) continue;

          const weight = Math.max(chroma, 18);
          weightedR += red * weight;
          weightedG += green * weight;
          weightedB += blue * weight;
          weightedTotal += weight;
        }

        if (weightedTotal > 0) {
          resolve(rgbToHex(weightedR / weightedTotal, weightedG / weightedTotal, weightedB / weightedTotal));
          return;
        }

        if (fallbackTotal > 0) {
          resolve(rgbToHex(fallbackR / fallbackTotal, fallbackG / fallbackTotal, fallbackB / fallbackTotal));
          return;
        }

        resolve(null);
      } catch (_) {
        resolve(null);
      }
    };

    image.onerror = () => resolve(null);
    image.src = src;
  });
}

async function ensureChannelAccent(channel) {
  const channelKey = channel?.key || state.activeChannelKey;
  const avatarPath = channel?.avatar_path;
  if (!channelKey) return;

  if (channel?.accent_color) {
    state.channelAccentCache[channelKey] = normalizeAccentHex(channel.accent_color);
    return;
  }

  if (!avatarPath || state.channelAccentCache[channelKey]) return;

  const accentHex = await extractAccentColorFromImage(avatarPath);
  if (!accentHex) return;

  state.channelAccentCache[channelKey] = accentHex;
  if (channelKey === state.activeChannelKey && !state.channelCarouselAnimating) {
    renderChannelMenu();
  }
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

function scrollPageToTop() {
  window.scrollTo({ top: 0, behavior: 'auto' });
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;
}

function nextRenderFrame() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(resolve);
    });
  });
}

function wait(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function setChannelContentSwitching(active) {
  elements.siteShell?.classList.toggle('is-channel-switching', Boolean(active));
}

function getChannelByKey(channelKey) {
  return getCatalogChannels().find((channel) => channel.key === channelKey) || null;
}

function getChannelIndex(channelKey) {
  return getCatalogChannels().findIndex((channel) => channel.key === channelKey);
}

function getRelativeChannelKey(offset) {
  const channels = getCatalogChannels();
  if (!channels.length) return null;

  const currentIndex = getChannelIndex(state.activeChannelKey);
  const safeIndex = currentIndex >= 0 ? currentIndex : 0;
  const nextIndex = (safeIndex + offset + channels.length) % channels.length;
  return channels[nextIndex]?.key || null;
}

function getChannelMenuLabels(channel) {
  const rawLabel = channel?.label || channel?.channel_title || channel?.channel_username || 'Channel';
  const parts = rawLabel.split('|').map((part) => part.trim()).filter(Boolean);
  return {
    rawLabel,
    title: parts[1] || channel?.menu_title || channel?.channel_title || rawLabel,
    subtitle: channel?.menu_subtitle || parts[0] || `@${channel?.channel_username || 'channel'}`,
  };
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

function showCopyToast(message = 'Скопировано') {
  if (!elements.copyToast) return;

  if (state.copyToastTimeoutId) {
    window.clearTimeout(state.copyToastTimeoutId);
  }

  elements.copyToast.textContent = message;
  elements.copyToast.classList.remove('hidden');
  elements.copyToast.classList.add('is-visible');

  state.copyToastTimeoutId = window.setTimeout(() => {
    elements.copyToast.classList.remove('is-visible');
    state.copyToastTimeoutId = window.setTimeout(() => {
      elements.copyToast.classList.add('hidden');
    }, 180);
  }, 1800);
}

async function copyTextToClipboard(text) {
  const value = String(text || '').trim();
  if (!value) return false;

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch (_) {
    // Fallback below.
  }

  const helper = document.createElement('textarea');
  helper.value = value;
  helper.setAttribute('readonly', '');
  helper.style.position = 'fixed';
  helper.style.opacity = '0';
  helper.style.pointerEvents = 'none';
  document.body.appendChild(helper);
  helper.select();

  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch (_) {
    copied = false;
  }

  helper.remove();
  return copied;
}

function attachCopyInteractions() {
  document.querySelectorAll('[data-copy-text]').forEach((target) => {
    let longPressTimerId = null;

    const clearLongPress = () => {
      if (longPressTimerId) {
        window.clearTimeout(longPressTimerId);
        longPressTimerId = null;
      }
    };

    const copyTargetValue = async () => {
      const copied = await copyTextToClipboard(target.dataset.copyText || target.textContent || '');
      showCopyToast(copied ? 'Скопировано' : 'Не удалось скопировать');
    };

    target.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      void copyTargetValue();
    });

    target.addEventListener('touchstart', () => {
      target.dataset.copySuppressClick = '0';
      clearLongPress();
      longPressTimerId = window.setTimeout(() => {
        target.dataset.copySuppressClick = '1';
        void copyTargetValue();
      }, LONG_PRESS_COPY_DELAY_MS);
    }, { passive: true });

    target.addEventListener('touchend', clearLongPress, { passive: true });
    target.addEventListener('touchcancel', clearLongPress, { passive: true });
    target.addEventListener('touchmove', clearLongPress, { passive: true });

    target.addEventListener('click', (event) => {
      if (target.dataset.copySuppressClick === '1') {
        event.preventDefault();
        target.dataset.copySuppressClick = '0';
      }
    });
  });
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

function isIosDevice() {
  const userAgent = window.navigator.userAgent || '';
  return /iphone|ipad|ipod/i.test(userAgent) || (window.navigator.platform === 'MacIntel' && window.navigator.maxTouchPoints > 1);
}

function isChromiumLikeBrowser() {
  const userAgent = window.navigator.userAgent || '';
  return /chrome|chromium|edg/i.test(userAgent) && !/opr|opera|yaBrowser/i.test(userAgent);
}

function updateInstallButtonState() {
  if (!elements.installAppButton) return;

  const installed = isStandaloneMode();
  elements.installAppButton.classList.toggle('is-installed', installed);
  elements.installAppButton.setAttribute('aria-label', installed ? 'Приложение уже установлено' : 'Установить приложение');
  elements.installAppButton.setAttribute('title', installed ? 'Приложение уже установлено' : 'Установить приложение');
}

function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function isMobileCarouselViewport() {
  return window.matchMedia('(max-width: 860px)').matches;
}

function getChannelCarouselTransitionDuration() {
  const url = new URL(window.location.href);
  return url.searchParams.get('autotest') === 'carousel' ? 980 : CHANNEL_CAROUSEL_TRANSITION_MS;
}

function finishChannelCarouselTransition() {
  if (state.channelCarouselTransition?.timeoutId) {
    window.clearTimeout(state.channelCarouselTransition.timeoutId);
  }
  state.channelCarouselTransition = null;
  state.channelCarouselAnimating = false;
}

function getChannelCarouselStage() {
  return elements.channelCarousel?.querySelector('.channel-carousel__stage') || null;
}

function getChannelCarouselTrack() {
  return elements.channelCarousel?.querySelector('[data-channel-carousel-track]') || null;
}

function getChannelCarouselWidth(stage = getChannelCarouselStage()) {
  return Math.max(
    stage?.getBoundingClientRect?.().width || 0,
    stage?.clientWidth || 0,
    window.matchMedia('(max-width: 480px)').matches ? 280 : 340,
  );
}

function setChannelCarouselShift(track, shift, stageOrWidth = getChannelCarouselStage()) {
  if (!track) return;
  const width = typeof stageOrWidth === 'number'
    ? stageOrWidth
    : getChannelCarouselWidth(stageOrWidth);
  const baseOffset = -width;
  track.style.transform = `translate3d(${Math.round(baseOffset + shift)}px, 0, 0)`;
}

function getRelativeChannel(offset) {
  const key = getRelativeChannelKey(offset);
  return key ? getChannelByKey(key) : null;
}

function buildMobileChannelCarouselSurface(channel, index, total, { current = false } = {}) {
  const safeChannel = channel || getActiveChannelMeta() || {};
  const { title, subtitle, rawLabel } = getChannelMenuLabels(safeChannel);
  const hasMultiple = total > 1;

  return `
    <article
      class="channel-carousel__surface${current ? ' channel-carousel__surface--current' : ''}"
      style="${escapeHtml(buildChannelAccentStyle(safeChannel))}"
      data-channel-carousel-surface="true"
      data-channel-key="${escapeHtml(safeChannel.key || '')}"
      aria-label="${escapeHtml(rawLabel)}"
      ${current ? 'aria-current="true"' : 'aria-hidden="true"'}
    >
      <button
        class="channel-carousel__nav channel-carousel__nav--prev"
        type="button"
        data-channel-shift="-1"
        aria-label="РџСЂРµРґС‹РґСѓС‰РёР№ РєР°РЅР°Р»"
        ${hasMultiple ? '' : 'disabled'}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="m14.5 6.5-5.5 5.5 5.5 5.5" />
        </svg>
      </button>
      <div class="channel-carousel__content">
        <span class="channel-carousel__meta">РљР°РЅР°Р» ${index + 1} РёР· ${total}</span>
        <span class="channel-carousel__title">${formatTextWithSoftBreaks(title)}</span>
        <span class="channel-carousel__subtitle">${formatTextWithSoftBreaks(subtitle)}</span>
      </div>
      <button
        class="channel-carousel__nav channel-carousel__nav--next"
        type="button"
        data-channel-shift="1"
        aria-label="РЎР»РµРґСѓСЋС‰РёР№ РєР°РЅР°Р»"
        ${hasMultiple ? '' : 'disabled'}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="m9.5 6.5 5.5 5.5-5.5 5.5" />
        </svg>
      </button>
    </article>
  `;
}

function buildMobileChannelCarouselSlide(channel, index, total, options = {}) {
  return `
    <div class="channel-carousel__slide" data-channel-carousel-slide="true">
      ${buildMobileChannelCarouselSurface(channel, index, total, options)}
    </div>
  `;
}

function scheduleChannelCarouselAutotest() {
  const url = new URL(window.location.href);
  if (url.searchParams.get('autotest') !== 'carousel' || state.channelCarouselAutotest?.running) {
    return;
  }

  const channels = getCatalogChannels();
  if (channels.length < 2 || !isMobileCarouselViewport()) {
    document.body.dataset.carouselTestResult = 'skipped';
    return;
  }

  state.channelCarouselAutotest = {
    running: true,
    observedMotion: false,
  };

  window.setTimeout(() => {
    void moveChannelCarousel(1);
  }, 250);

  window.setTimeout(() => {
    const track = getChannelCarouselTrack();
    const currentSurface = elements.channelCarousel?.querySelector('.channel-carousel__surface--current');
    const passed =
      Boolean(track) &&
      Boolean(currentSurface) &&
      Boolean(state.channelCarouselAutotest?.observedMotion) &&
      !state.channelCarouselAnimating;

    document.body.dataset.carouselTestResult = passed ? 'pass' : 'fail';
    document.body.dataset.carouselTestDetails = [
      `motion:${Boolean(state.channelCarouselAutotest?.observedMotion)}`,
      `current:${Boolean(currentSurface)}`,
      `animating:${Boolean(state.channelCarouselAnimating)}`,
    ].join('|');
    state.channelCarouselAutotest.running = false;
  }, 2600);
}

function animateChannelCarouselShift(track, targetShift, { duration = getChannelCarouselTransitionDuration() } = {}) {
  if (!track || prefersReducedMotion()) {
    setChannelCarouselShift(track, targetShift);
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const easing = 'cubic-bezier(0.2, 0.9, 0.24, 1)';
    const transitionState = { timeoutId: null };
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      track.style.removeProperty('transition');
      if (state.channelCarouselTransition === transitionState) {
        state.channelCarouselTransition = null;
      }
      resolve();
    };

    transitionState.timeoutId = window.setTimeout(finish, duration + 120);
    state.channelCarouselTransition = transitionState;

    track.style.transition = `transform ${duration}ms ${easing}`;
    requestAnimationFrame(() => {
      setChannelCarouselShift(track, targetShift);
      if (state.channelCarouselAutotest) {
        state.channelCarouselAutotest.observedMotion = true;
      }
    });

    track.addEventListener('transitionend', (event) => {
      if (event.propertyName === 'transform') {
        finish();
      }
    }, { once: true });
  });
}

async function moveChannelCarousel(offset) {
  const nextChannelKey = getRelativeChannelKey(offset);
  if (!nextChannelKey || nextChannelKey === state.activeChannelKey || state.channelCarouselAnimating) return;

  const stage = getChannelCarouselStage();
  const track = getChannelCarouselTrack();
  const shouldAnimate = isMobileCarouselViewport() && !prefersReducedMotion() && stage && track;

  try {
    if (shouldAnimate) {
      const width = getChannelCarouselWidth(stage);
      const targetShift = offset > 0 ? -width : width;
      state.channelCarouselAnimating = true;
      stage.classList.add('channel-carousel__stage--animating');
      await animateChannelCarouselShift(track, targetShift);
    }

    await switchChannel(nextChannelKey, { scrollToTop: true });
  } finally {
    getChannelCarouselStage()?.classList.remove('channel-carousel__stage--animating');
    finishChannelCarouselTransition();
  }
}

function isTelegramWebUrl(value) {
  try {
    const url = new URL(value, window.location.href);
    return /^(?:www\.)?(?:t|telegram)\.me$/i.test(url.hostname);
  } catch (_) {
    return false;
  }
}

function buildTelegramAppHref(value) {
  try {
    const url = new URL(value, window.location.href);
    if (!isTelegramWebUrl(url.href)) return null;

    const parts = url.pathname.split('/').filter(Boolean);
    if (!parts.length) return null;

    if (parts[0] === 's') {
      parts.shift();
    }

    const domain = parts[0];
    const post = parts[1];
    if (!domain) return null;

    return post
      ? `tg://resolve?domain=${encodeURIComponent(domain)}&post=${encodeURIComponent(post)}`
      : `tg://resolve?domain=${encodeURIComponent(domain)}`;
  } catch (_) {
    return null;
  }
}

function openTelegramAnchor(anchor) {
  const webHref = anchor.dataset.telegramWebHref || anchor.href;
  const appHref = anchor.dataset.telegramAppHref || buildTelegramAppHref(webHref);

  if (!appHref) {
    window.location.href = webHref;
    return;
  }

  let fallbackTimerId = null;
  const cleanup = () => {
    if (fallbackTimerId) {
      window.clearTimeout(fallbackTimerId);
      fallbackTimerId = null;
    }
    window.removeEventListener('blur', cleanup);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    window.removeEventListener('pagehide', cleanup);
  };

  const handleVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      cleanup();
    }
  };

  fallbackTimerId = window.setTimeout(() => {
    const pageStillVisible = document.visibilityState === 'visible' && document.hasFocus();
    cleanup();
    if (!pageStillVisible) return;
    window.location.href = webHref;
  }, 900);

  window.addEventListener('blur', cleanup, { once: true });
  document.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener('pagehide', cleanup, { once: true });
  window.location.href = appHref;
}

function bindTelegramDeepLinks(root) {
  if (!root) return;

  root.querySelectorAll('a[href]').forEach((anchor) => {
    if (anchor.dataset.telegramBound === 'true') return;
    if (!isTelegramWebUrl(anchor.getAttribute('href') || anchor.href)) return;

    const webHref = anchor.href;
    const appHref = buildTelegramAppHref(webHref);
    if (!appHref) return;

    anchor.dataset.telegramBound = 'true';
    anchor.dataset.telegramWebHref = webHref;
    anchor.dataset.telegramAppHref = appHref;

    anchor.addEventListener('click', (event) => {
      if (event.defaultPrevented) return;
      if (event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      event.preventDefault();
      openTelegramAnchor(anchor);
    });
  });
}

function setupChannelMenuWheelScroll() {
  if (!elements.channelMenu || elements.channelMenu.dataset.wheelScrollBound === 'true') return;

  elements.channelMenu.dataset.wheelScrollBound = 'true';
  elements.channelMenu.addEventListener('wheel', (event) => {
    const isDesktopViewport = window.matchMedia('(min-width: 861px)').matches;
    const hasHorizontalOverflow = elements.channelMenu.scrollWidth > elements.channelMenu.clientWidth + 2;
    const hasVerticalIntent = Math.abs(event.deltaY) > Math.abs(event.deltaX);

    if (!isDesktopViewport || !hasHorizontalOverflow || !hasVerticalIntent) {
      return;
    }

    event.preventDefault();
    elements.channelMenu.scrollLeft += event.deltaY;
  }, { passive: false });
}

function setupChannelCarouselInteractions() {
  if (!elements.channelCarousel || elements.channelCarousel.dataset.carouselBound === 'true') return;

  elements.channelCarousel.dataset.carouselBound = 'true';

  elements.channelCarousel.addEventListener('click', (event) => {
    const button = event.target.closest('[data-channel-shift]');
    if (!button) return;

    const shift = Number(button.dataset.channelShift || '0');
    if (!shift) return;
    void moveChannelCarousel(shift);
  });

  elements.channelCarousel.addEventListener('touchstart', (event) => {
    const stage = getChannelCarouselStage();
    const track = getChannelCarouselTrack();
    const surface = event.target.closest('.channel-carousel__surface--current');
    if (!surface || !stage || !track || event.touches.length !== 1 || state.channelCarouselAnimating) return;

    const touch = event.touches[0];
    state.channelCarouselTouch = {
      x: touch.clientX,
      y: touch.clientY,
      deltaX: 0,
      deltaY: 0,
      dragging: false,
      width: getChannelCarouselWidth(stage),
      track,
    };
  }, { passive: true });

  elements.channelCarousel.addEventListener('touchmove', (event) => {
    const touchState = state.channelCarouselTouch;
    if (!touchState || !event.touches.length) return;

    const touch = event.touches[0];
    const deltaX = touch.clientX - touchState.x;
    const deltaY = touch.clientY - touchState.y;
    touchState.deltaX = deltaX;
    touchState.deltaY = deltaY;

    if (!touchState.dragging) {
      if (Math.abs(deltaX) < 10 || Math.abs(deltaX) <= Math.abs(deltaY)) {
        return;
      }
      touchState.dragging = true;
    }

    event.preventDefault();
    const maxOffset = touchState.width + 24;
    const offsetX = clamp(deltaX, -maxOffset, maxOffset);
    touchState.track.style.removeProperty('transition');
    setChannelCarouselShift(touchState.track, offsetX, touchState.width);
  }, { passive: false });

  elements.channelCarousel.addEventListener('touchend', (event) => {
    const touchState = state.channelCarouselTouch;
    state.channelCarouselTouch = null;
    if (!touchState || !event.changedTouches.length) return;

    const deltaX = touchState.deltaX;
    const deltaY = touchState.deltaY;
    const threshold = touchState.width * 0.18;

    if (!touchState.dragging || Math.abs(deltaX) < threshold || Math.abs(deltaX) <= Math.abs(deltaY)) {
      void animateChannelCarouselShift(touchState.track, 0, { duration: 240 });
      return;
    }

    void moveChannelCarousel(deltaX < 0 ? 1 : -1);
  }, { passive: true });

  elements.channelCarousel.addEventListener('touchcancel', () => {
    if (state.channelCarouselTouch?.track) {
      void animateChannelCarouselShift(state.channelCarouselTouch.track, 0, { duration: 220 });
    }
    state.channelCarouselTouch = null;
  }, { passive: true });
}

function getInstallFallbackMessage() {
  if (isStandaloneMode()) {
    return 'Приложение уже установлено';
  }

  if (isIosDevice()) {
    return 'Safari: Поделиться -> На экран «Домой»';
  }

  if (isChromiumLikeBrowser()) {
    return 'Если prompt не появился: меню браузера -> Установить приложение';
  }

  return 'Установка доступна в Chrome или Edge';
}

async function handleInstallButtonClick() {
  if (isStandaloneMode()) {
    showCopyToast('Приложение уже установлено');
    return;
  }

  if (!state.deferredInstallPrompt) {
    showCopyToast(getInstallFallbackMessage());
    return;
  }

  const promptEvent = state.deferredInstallPrompt;
  state.deferredInstallPrompt = null;

  await promptEvent.prompt();
  const choice = await promptEvent.userChoice;

  if (choice.outcome === 'accepted') {
    showCopyToast('Установка запущена');
  } else {
    showCopyToast('Установка отменена');
  }

  updateInstallButtonState();
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
    const { rawLabel, title, subtitle } = getChannelMenuLabels(channel);
    return `
        <button
          class="channel-tab${isActive ? ' is-active' : ''}"
          type="button"
          data-channel-key="${channel.key}"
          ${isActive ? `style="${escapeHtml(buildChannelAccentStyle(channel))}"` : ''}
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

  renderMobileChannelCarousel();
}

function renderMobileChannelCarousel() {
  if (!elements.channelCarousel) return;

  const channels = getCatalogChannels();
  if (!channels.length) {
    elements.channelCarousel.innerHTML = '';
    return;
  }

  const activeIndex = Math.max(0, getChannelIndex(state.activeChannelKey));
  const activeChannel = channels[activeIndex] || channels[0];
  const previousChannel = getRelativeChannel(-1) || activeChannel;
  const nextChannel = getRelativeChannel(1) || activeChannel;

  let carouselStage = elements.channelCarousel.querySelector('.channel-carousel__stage');
  if (!carouselStage) {
    elements.channelCarousel.innerHTML = '<div class="channel-carousel__stage"></div>';
    carouselStage = elements.channelCarousel.querySelector('.channel-carousel__stage');
  }

  carouselStage.classList.remove('channel-carousel__stage--animating');
  carouselStage.innerHTML = `
    <div class="channel-carousel__track" data-channel-carousel-track>
      ${buildMobileChannelCarouselSurface(previousChannel, (activeIndex - 1 + channels.length) % channels.length, channels.length)}
      ${buildMobileChannelCarouselSurface(activeChannel, activeIndex, channels.length, { current: true })}
      ${buildMobileChannelCarouselSurface(nextChannel, (activeIndex + 1) % channels.length, channels.length)}
    </div>
  `;

  const track = carouselStage.querySelector('[data-channel-carousel-track]');
  if (track) {
    track.style.removeProperty('transition');
    requestAnimationFrame(() => {
      setChannelCarouselShift(track, 0, carouselStage);
    });
  }

  finishChannelCarouselTransition();
  scheduleChannelCarouselAutotest();
  return;

  const markup = `
    <div
      class="channel-carousel__surface channel-carousel__surface--settled"
      style="${escapeHtml(buildChannelAccentStyle(activeChannel))}"
      data-channel-carousel-surface="true"
      data-channel-key="${escapeHtml(activeChannel.key)}"
      aria-label="${escapeHtml(rawLabel)}"
    >
      <button
        class="channel-carousel__nav channel-carousel__nav--prev"
        type="button"
        data-channel-shift="-1"
        aria-label="Предыдущий канал"
        ${hasMultiple ? '' : 'disabled'}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="m14.5 6.5-5.5 5.5 5.5 5.5" />
        </svg>
      </button>
      <div class="channel-carousel__content">
        <span class="channel-carousel__meta">Канал ${activeIndex + 1} из ${channels.length}</span>
        <span class="channel-carousel__title">${formatTextWithSoftBreaks(title)}</span>
        <span class="channel-carousel__subtitle">${formatTextWithSoftBreaks(subtitle)}</span>
      </div>
      <button
        class="channel-carousel__nav channel-carousel__nav--next"
        type="button"
        data-channel-shift="1"
        aria-label="Следующий канал"
        ${hasMultiple ? '' : 'disabled'}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="m9.5 6.5 5.5 5.5-5.5 5.5" />
        </svg>
      </button>
    </div>
  `;

  let stage = elements.channelCarousel.querySelector('.channel-carousel__stage');
  if (!stage) {
    elements.channelCarousel.innerHTML = '<div class="channel-carousel__stage"></div>';
    stage = elements.channelCarousel.querySelector('.channel-carousel__stage');
  }

  const previousSurface = stage.querySelector('[data-channel-carousel-surface]');
  const template = document.createElement('template');
  template.innerHTML = markup.trim();
  const nextSurface = template.content.firstElementChild;
  const shouldAnimate =
    Boolean(state.channelCarouselTransition) &&
    Boolean(previousSurface) &&
    previousSurface.dataset.channelKey !== activeChannel.key &&
    isMobileCarouselViewport() &&
    !prefersReducedMotion();

  if (!shouldAnimate) {
    stage.classList.remove('channel-carousel__stage--animating');
    stage.innerHTML = '';
    stage.appendChild(nextSurface);
    finishChannelCarouselTransition();
    scheduleChannelCarouselAutotest();
    return;
  }

  stage.appendChild(nextSurface);
  requestAnimationFrame(() => {
    animateChannelCarouselTransition(
      stage,
      previousSurface,
      nextSurface,
      state.channelCarouselTransition?.direction || 'next',
    );
  });
}

function buildMobileChannelCarouselSurface(channel, index, total, { current = false } = {}) {
  const safeChannel = channel || getActiveChannelMeta() || {};
  const { title, subtitle, rawLabel } = getChannelMenuLabels(safeChannel);
  const hasMultiple = total > 1;

  return `
    <article
      class="channel-carousel__surface${current ? ' channel-carousel__surface--current' : ''}"
      style="${escapeHtml(buildChannelAccentStyle(safeChannel))}"
      data-channel-carousel-surface="true"
      data-channel-key="${escapeHtml(safeChannel.key || '')}"
      aria-label="${escapeHtml(rawLabel)}"
      ${current ? 'aria-current="true"' : 'aria-hidden="true"'}
    >
      <button
        class="channel-carousel__nav channel-carousel__nav--prev"
        type="button"
        data-channel-shift="-1"
        aria-label="Предыдущий канал"
        ${hasMultiple ? '' : 'disabled'}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="m14.5 6.5-5.5 5.5 5.5 5.5" />
        </svg>
      </button>
      <div class="channel-carousel__content">
        <span class="channel-carousel__meta">Канал ${index + 1} из ${total}</span>
        <span class="channel-carousel__title">${formatTextWithSoftBreaks(title)}</span>
        <span class="channel-carousel__subtitle">${formatTextWithSoftBreaks(subtitle)}</span>
      </div>
      <button
        class="channel-carousel__nav channel-carousel__nav--next"
        type="button"
        data-channel-shift="1"
        aria-label="Следующий канал"
        ${hasMultiple ? '' : 'disabled'}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="m9.5 6.5 5.5 5.5-5.5 5.5" />
        </svg>
      </button>
    </article>
  `;
}

function renderMobileChannelCarousel() {
  if (!elements.channelCarousel) return;

  const channels = getCatalogChannels();
  if (!channels.length) {
    elements.channelCarousel.innerHTML = '';
    return;
  }

  const activeIndex = Math.max(0, getChannelIndex(state.activeChannelKey));
  const activeChannel = channels[activeIndex] || channels[0];
  const previousChannel = getRelativeChannel(-1) || activeChannel;
  const nextChannel = getRelativeChannel(1) || activeChannel;

  let carouselStage = elements.channelCarousel.querySelector('.channel-carousel__stage');
  if (!carouselStage) {
    elements.channelCarousel.innerHTML = '<div class="channel-carousel__stage"></div>';
    carouselStage = elements.channelCarousel.querySelector('.channel-carousel__stage');
  }

  carouselStage.classList.remove('channel-carousel__stage--animating');
  carouselStage.innerHTML = `
    <div class="channel-carousel__track" data-channel-carousel-track>
      ${buildMobileChannelCarouselSlide(previousChannel, (activeIndex - 1 + channels.length) % channels.length, channels.length)}
      ${buildMobileChannelCarouselSlide(activeChannel, activeIndex, channels.length, { current: true })}
      ${buildMobileChannelCarouselSlide(nextChannel, (activeIndex + 1) % channels.length, channels.length)}
    </div>
  `;

  const track = carouselStage.querySelector('[data-channel-carousel-track]');
  if (track) {
    track.style.removeProperty('transition');
    setChannelCarouselShift(track, 0);
  }

  finishChannelCarouselTransition();
  scheduleChannelCarouselAutotest();
}

function formatTextWithSoftBreaks(value) {
  return escapeHtml(String(value || '').trim()).replace(/([a-zа-яё])([A-ZА-ЯЁ])/g, '$1<wbr>$2');
}

function getOrderedTitleParts(title) {
  const rawTitle = String(title || '').trim();
  if (!rawTitle) return [];

  const parts = rawTitle.split('|').map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) {
    return rawTitle ? [rawTitle] : [];
  }

  const firstPart = parts[0] || '';
  const secondPart = parts[1] || '';
  const latinPattern = /[A-Za-z]/;
  const cyrillicPattern = /[А-Яа-яЁё]/;
  return (
    latinPattern.test(firstPart) && cyrillicPattern.test(secondPart)
      ? [secondPart, firstPart]
      : parts
  );
}

function renderHeroTitle(title) {
  const orderedParts = getOrderedTitleParts(title);
  if (!orderedParts.length) return '';

  return orderedParts.map((part, index) => `
      <span class="hero__title-line${index === 0 ? ' hero__title-line--lead' : ''}">${formatTextWithSoftBreaks(part)}</span>
    `).join('');
}

function renderHeader(site, generatedAt) {
  const catalogSite = getCatalogSite();
  const activeChannel = getActiveChannelMeta();
  const title = activeChannel?.channel_title || site.channel_title || site.site_name || catalogSite.site_name || 'Telegram Channels';
  const description = site.site_description || activeChannel?.site_description || catalogSite.site_description || '';
  const handle = site.channel_username ? `@${site.channel_username}` : '@channel';
  const avatarSrc = resolveHeroAvatar(site);
  const fallbackAvatar = catalogSite.avatar_path || 'assets/channel-avatar.jpg';

  elements.siteTitle.innerHTML = renderHeroTitle(title);
  elements.siteDescription.innerHTML = linkifyText(description);
  elements.channelLink.textContent = handle;
  elements.channelLink.href = site.channel_username ? `https://t.me/${site.channel_username}` : 'https://t.me';
  startSyncStatusPolling();
  document.title = getOrderedTitleParts(title).join(' | ') || title;

  if (avatarSrc) {
    elements.channelAvatar.dataset.fallbackSrc = fallbackAvatar;
    elements.channelAvatar.dataset.fallbackApplied = 'false';
    elements.channelAvatar.src = avatarSrc;
    elements.channelAvatar.alt = title;
    elements.channelAvatarWrap.classList.remove('hidden');
  } else {
    elements.channelAvatarWrap.classList.add('hidden');
  }

  const accentColor = activeChannel?.accent_color || site.accent_color || catalogSite.accent_color;
  if (accentColor) {
    document.documentElement.style.setProperty('--accent', accentColor);
    const themeColorMeta = document.querySelector('meta[name="theme-color"]');
    if (themeColorMeta) themeColorMeta.setAttribute('content', accentColor);
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

  bindTelegramDeepLinks(article);

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
  return linkifyText(text || '');
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
  bindTelegramDeepLinks(node);
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
    void ensureChannelAccent({
      ...getActiveChannelMeta(),
      ...(state.feed.site || {}),
      key: channelKey,
    });
    elements.loadingState.classList.add('hidden');

    if (!state.posts.length) {
      elements.emptyState.classList.remove('hidden');
      updateFeedMeta();
      updateLoadMoreVisibility();
      handleRoute();
      scheduleChannelCarouselAutotest();
      return;
    }

    resetFeed();
    handleRoute();
    scheduleChannelCarouselAutotest();
  } catch (error) {
    elements.loadingState.classList.add('hidden');
    elements.errorState.classList.remove('hidden');
    elements.errorMessage.textContent = `Ошибка: ${error.message}`;
  }
}

async function switchChannel(channelKey, { replace = false, force = false, scrollToTop = false } = {}) {
  const resolvedChannelKey = resolveChannelKey(channelKey);
  if (!resolvedChannelKey) return;
  const isChannelChange = Boolean(state.activeChannelKey) && resolvedChannelKey !== state.activeChannelKey;

  const shouldClearHash = window.location.hash.startsWith('#comments-');
  const shouldUpdateUrl = getChannelKeyFromLocation() !== resolvedChannelKey || shouldClearHash;
  if (shouldUpdateUrl) {
    updateChannelUrl(resolvedChannelKey, { replace, clearHash: shouldClearHash });
  }

  if (scrollToTop) {
    scrollPageToTop();
  }

  if (isChannelChange) {
    setChannelContentSwitching(true);
    await nextRenderFrame();
    await wait(CHANNEL_CONTENT_FADE_OUT_MS);
  }

  try {
    await loadFeed(resolvedChannelKey, force);
  } finally {
    if (isChannelChange) {
      await nextRenderFrame();
      await wait(CHANNEL_CONTENT_FADE_IN_DELAY_MS);
      setChannelContentSwitching(false);
    }
  }

  if (scrollToTop) {
    scrollPageToTop();
  }
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
    scheduleChannelCarouselAutotest();
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
    void switchChannel(nextChannelKey, { replace: true });
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

  void switchChannel(nextChannelKey, { scrollToTop: true });
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

if (elements.installAppButton) {
  elements.installAppButton.addEventListener('click', () => {
    void handleInstallButtonClick();
  });
}

window.addEventListener('hashchange', handleRoute);
window.addEventListener('popstate', handleLocationChange);
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  state.deferredInstallPrompt = event;
  updateInstallButtonState();
});
window.addEventListener('appinstalled', () => {
  state.deferredInstallPrompt = null;
  updateInstallButtonState();
  showCopyToast('Приложение установлено');
});
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

setupChannelMenuWheelScroll();
setupChannelCarouselInteractions();
attachCopyInteractions();
loadCatalog();
updateInstallButtonState();
