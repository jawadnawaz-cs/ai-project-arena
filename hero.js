import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.118.0';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

/* ==========================================================================
   HOME HERO — FEATURED PROJECT SLIDESHOW + LIVE VOTING TIMER
   - Every SLIDE_MS the current thumbnail slides out to the right while the
     next one slides in from the left; the text fades out and back in.
   - Clicking anywhere on the thumbnail (or "Watch Now") opens the video of the
     project that is on screen *right now*.
   - The right-hand card shows a live countdown while voting is open.
   The hero is only visible to signed-out visitors (signed-in users are routed
   to their workspace), so a read-only anonymous client is all we need.
   ========================================================================== */

const SLIDE_MS = 10000; // time each project stays on screen
const ANIM_MS = 1100; // thumbnail slide duration (matches --hero-anim in CSS)
const TEXT_SWAP_MS = 420; // when the text is swapped while it is faded out
const MAX_SLIDES = 12;
const SETTINGS_POLL_MS = 30000;

const stage = document.getElementById('about');

if (stage && stage.classList.contains('hero-stage')) {
  initHero();
}

function initHero() {
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  const $ = (id) => document.getElementById(id);
  const slidesEl = $('heroSlides');
  const copyEl = $('heroCopy');
  const kickerEl = $('heroKicker');
  const titleEl = $('heroTitle');
  const descEl = $('heroDesc');
  const watchBtn = $('heroWatchBtn');
  const controlsEl = $('heroControls');
  const counterEl = $('heroCounter');
  const progressEl = $('heroProgress');

  stage.style.setProperty('--hero-slide-time', SLIDE_MS + 'ms');

  /* ---------- helpers ---------- */

  function getYoutubeId(raw) {
    try {
      const u = new URL(raw);
      const host = u.hostname.toLowerCase().replace(/^www\./, '');
      if (!['youtube.com', 'm.youtube.com', 'youtu.be'].includes(host)) return null;
      let id = '';
      if (host === 'youtu.be') id = u.pathname.split('/').filter(Boolean)[0] || '';
      else if (u.pathname === '/watch') id = u.searchParams.get('v') || '';
      else {
        const parts = u.pathname.split('/').filter(Boolean);
        if (['embed', 'shorts', 'live', 'v'].includes(parts[0])) id = parts[1] || '';
      }
      return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
    } catch {
      return null;
    }
  }

  const pad = (n) => String(Math.max(0, n)).padStart(2, '0');

  /* ---------- data ---------- */

  const FALLBACK = [
    {
      id: 'sample',
      fallback: true,
      title: 'Smart Campus Assistant & Navigation',
      team: 'Computer Science · Team 04',
      description:
        'An AI-powered campus directory and laboratory scheduling assistant built for DUET students and faculty members.',
      videoId: null,
    },
  ];

  function normalise(row, teamNames) {
    const videoUrl = row.video_url || '';
    return {
      id: row.submission_id ?? row.id,
      title: row.project_title ?? row.title ?? 'Untitled project',
      description: row.project_description ?? row.description ?? '',
      team: row.team_name ?? teamNames?.get(row.group_id) ?? 'Student Team',
      videoId: getYoutubeId(videoUrl),
    };
  }

  async function loadProjects() {
    // 1) the same RPC the showcase page uses
    try {
      const rpc = await supabase.rpc('get_approved_arena_projects');
      if (!rpc.error && Array.isArray(rpc.data) && rpc.data.length) {
        const list = rpc.data.map((r) => normalise(r)).filter((p) => p.videoId);
        if (list.length) return list.slice(0, MAX_SLIDES);
      }
    } catch {
      /* fall through */
    }
    // 2) direct read of approved submissions (works when RLS allows it)
    try {
      const { data, error } = await supabase
        .from('project_submissions')
        .select('id,group_id,title,description,video_url')
        .eq('status', 'approved')
        .order('updated_at', { ascending: false })
        .limit(MAX_SLIDES);
      if (!error && data?.length) {
        const names = new Map();
        try {
          const g = await supabase.from('project_groups').select('id,name');
          (g.data || []).forEach((x) => names.set(x.id, x.name));
        } catch {
          /* team names are optional */
        }
        const list = data.map((r) => normalise(r, names)).filter((p) => p.videoId);
        if (list.length) return list;
      }
    } catch {
      /* fall through */
    }
    return [];
  }

  /* ---------- slideshow ---------- */

  let slides = [];
  const slideEls = new Map();
  const state = { index: 0, busy: false, timer: null, deadline: 0, paused: false, remaining: SLIDE_MS };

  function thumbUrl(id, quality) {
    return 'https://i.ytimg.com/vi/' + id + '/' + quality + '.jpg';
  }

  function getSlideEl(i) {
    if (slideEls.has(i)) return slideEls.get(i);
    const p = slides[i];
    const el = document.createElement('div');
    el.className = 'hero-slide' + (p.videoId ? '' : ' is-fallback');
    if (p.videoId) {
      const img = new Image();
      img.alt = '';
      img.decoding = 'async';
      img.draggable = false;
      const useFallbackQuality = () => {
        if (!img.dataset.fb) {
          img.dataset.fb = '1';
          img.src = thumbUrl(p.videoId, 'hqdefault');
        }
      };
      img.addEventListener('error', useFallbackQuality);
      img.addEventListener('load', () => {
        // YouTube serves a tiny grey placeholder when maxres is missing
        if (img.naturalWidth && img.naturalWidth <= 160) useFallbackQuality();
      });
      img.src = thumbUrl(p.videoId, 'maxresdefault');
      el.append(img);
    }
    slidesEl.append(el);
    slideEls.set(i, el);
    return el;
  }

  function renderCopy(i) {
    const p = slides[i];
    kickerEl.textContent = (p.fallback ? 'Featured Reference · ' : 'Featured Entry · ') + p.team;
    titleEl.textContent = p.title;
    descEl.textContent = p.description;
    stage.classList.toggle('has-video', true);
  }

  function updateCounter() {
    counterEl.textContent = pad(state.index + 1) + ' / ' + pad(slides.length);
  }

  function restartProgress() {
    if (slides.length < 2) return;
    progressEl.hidden = false;
    progressEl.classList.remove('run', 'paused');
    void progressEl.offsetWidth;
    progressEl.classList.add('run');
  }

  function scheduleNext(ms) {
    clearTimeout(state.timer);
    if (slides.length < 2) return;
    state.deadline = Date.now() + ms;
    state.timer = setTimeout(() => goTo((state.index + 1) % slides.length), ms);
  }

  function pauseShow() {
    if (state.paused || slides.length < 2) return;
    state.paused = true;
    state.remaining = Math.max(400, state.deadline - Date.now());
    clearTimeout(state.timer);
    progressEl.classList.add('paused');
  }

  function resumeShow() {
    if (!state.paused) return;
    state.paused = false;
    progressEl.classList.remove('paused');
    scheduleNext(state.remaining);
  }

  function preloadNext() {
    if (slides.length < 2) return;
    getSlideEl((state.index + 1) % slides.length);
  }

  function goTo(next) {
    if (state.busy || !slides.length || next === state.index) return;
    state.busy = true;

    const prevEl = getSlideEl(state.index);
    const nextEl = getSlideEl(next);
    state.index = next; // from this moment every click belongs to the NEW project

    // old text fades out, old thumbnail slides right, new thumbnail slides in from the left
    copyEl.classList.add('is-fading');
    nextEl.classList.remove('is-leaving');
    prevEl.classList.remove('is-active');
    prevEl.classList.add('is-leaving');
    void nextEl.offsetWidth;
    nextEl.classList.add('is-active');

    // new text fades in while the new thumbnail is still sliding
    setTimeout(() => {
      renderCopy(next);
      copyEl.classList.remove('is-fading');
    }, TEXT_SWAP_MS);

    setTimeout(() => {
      prevEl.classList.add('no-anim');
      prevEl.classList.remove('is-leaving');
      void prevEl.offsetWidth;
      prevEl.classList.remove('no-anim');
      state.busy = false;
      preloadNext();
    }, ANIM_MS + 40);

    updateCounter();
    restartProgress();
    state.paused = false;
    scheduleNext(SLIDE_MS);
  }

  function startShow(list) {
    slides = list;
    state.index = 0;
    const first = getSlideEl(0);
    first.classList.add('no-anim', 'is-active');
    void first.offsetWidth;
    first.classList.remove('no-anim');
    renderCopy(0);
    watchBtn.disabled = false;

    if (slides.length > 1) {
      controlsEl.hidden = false;
      updateCounter();
      restartProgress();
      scheduleNext(SLIDE_MS);
      preloadNext();
    }
    syncVoteButtons();
  }

  /* ---------- video player ---------- */

  const playerEl = $('heroPlayer');
  const playerFrame = $('heroPlayerFrame');
  let lastFocus = null;

  function openSlide(i) {
    const p = slides[i];
    if (!p) return;
    if (!p.videoId) {
      window.location.href = 'projects.html';
      return;
    }
    lastFocus = document.activeElement;
    $('heroPlayerTeam').textContent = p.team;
    $('heroPlayerTitle').textContent = p.title;
    $('heroPlayerDesc').textContent = p.description;
    playerFrame.innerHTML = '';
    const iframe = document.createElement('iframe');
    iframe.src = 'https://www.youtube-nocookie.com/embed/' + p.videoId + '?autoplay=1&rel=0&playsinline=1';
    iframe.title = p.title + ' — video demonstration';
    iframe.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
    iframe.allowFullscreen = true;
    playerFrame.append(iframe);
    playerEl.hidden = false;
    document.body.classList.add('hero-player-open');
    pauseShow();
    playerEl.querySelector('.hero-player-close')?.focus();
  }

  function closePlayer(restoreFocus = true) {
    if (playerEl.hidden) return;
    playerEl.hidden = true;
    playerFrame.innerHTML = ''; // destroys the iframe so the video stops
    document.body.classList.remove('hero-player-open');
    resumeShow();
    if (restoreFocus) lastFocus?.focus?.();
  }

  playerEl.addEventListener('click', (e) => {
    if (e.target.closest('[data-player-close]')) closePlayer();
    else if (e.target.closest('#heroPlayerVote')) closePlayer(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePlayer();
  });

  // Click anywhere on the thumbnail → open the project that is currently shown
  stage.addEventListener('click', (e) => {
    if (e.target.closest('a, button, input, .hero-vote, .hero-controls')) return;
    if (slides.length) openSlide(state.index);
  });
  watchBtn.addEventListener('click', () => openSlide(state.index));
  $('heroPrev').addEventListener('click', () => goTo((state.index - 1 + slides.length) % slides.length));
  $('heroNext').addEventListener('click', () => goTo((state.index + 1) % slides.length));

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pauseShow();
    else if (playerEl.hidden) resumeShow();
  });

  /* ---------- live voting timer ---------- */

  const voteCard = $('heroVoteCard');
  const voteBtn = $('heroVoteBtn');
  const playerVoteBtn = $('heroPlayerVote');
  let settings = null;

  function votingInfo() {
    const dl = settings?.voting_deadline ? Date.parse(settings.voting_deadline) : NaN;
    if (settings?.voting_open && Number.isFinite(dl) && dl > Date.now()) return { mode: 'open', deadline: dl };
    if (Number.isFinite(dl) && dl <= Date.now()) return { mode: 'ended' };
    return { mode: 'soon' };
  }

  function syncVoteButtons() {
    const open = votingInfo().mode === 'open';
    playerVoteBtn.disabled = !open;
  }

  function renderVoting() {
    const info = votingInfo();
    voteCard.dataset.state = info.mode;
    const label = $('heroVoteLabel');
    const note = $('heroVoteNote');
    const cd = { d: $('cdDays'), h: $('cdHours'), m: $('cdMins'), s: $('cdSecs') };

    if (info.mode === 'open') {
      const left = Math.max(0, info.deadline - Date.now());
      const total = Math.floor(left / 1000);
      cd.d.textContent = pad(Math.floor(total / 86400));
      cd.h.textContent = pad(Math.floor((total % 86400) / 3600));
      cd.m.textContent = pad(Math.floor((total % 3600) / 60));
      cd.s.textContent = pad(total % 60);
      label.textContent = 'Voting is live';
      note.textContent =
        'Watch the entries, then cast your single verified vote before ' +
        new Date(info.deadline).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) +
        '.';
      voteBtn.disabled = false;
      voteBtn.textContent = 'Vote Now';
      if (left <= 0) refreshSettings();
    } else {
      [cd.d, cd.h, cd.m, cd.s].forEach((n) => (n.textContent = '--'));
      if (info.mode === 'ended') {
        label.textContent = 'Voting ended';
        note.textContent = 'The voting window has closed. Browse every entry in the showcase.';
        voteBtn.textContent = 'Voting Ended';
      } else {
        label.textContent = 'Voting opens soon';
        note.textContent = 'The countdown starts the moment faculty open the voting window.';
        voteBtn.textContent = 'Voting Not Open';
      }
      voteBtn.disabled = true;
    }
    syncVoteButtons();
  }

  async function refreshSettings() {
    try {
      const { data } = await supabase
        .from('competition_settings')
        .select('title,voting_open,voting_deadline')
        .eq('id', true)
        .maybeSingle();
      if (data) {
        settings = data;
        const badge = $('heroCompetitionBadge');
        if (badge && data.title) badge.textContent = data.title;
      }
    } catch {
      /* keep last known state */
    }
    renderVoting();
  }

  /* ---------- boot ---------- */

  watchBtn.disabled = true;
  renderVoting();
  refreshSettings();
  setInterval(renderVoting, 1000);
  setInterval(refreshSettings, SETTINGS_POLL_MS);

  loadProjects().then((list) => startShow(list.length ? list : FALLBACK));
}
