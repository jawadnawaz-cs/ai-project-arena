import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.118.0';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { openAuth } from './auth.js';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const dashboard = document.getElementById('studentDashboard');
const voterDashboard = document.getElementById('voterDashboard');
const adminDashboard = document.getElementById('adminDashboard');
const roleChooser = document.getElementById('roleChooser');

let activeUser = null;
let competitionSettings = null;
let currentArenaRole = null;
let isArenaAdmin = false;

let adminClockInterval = null;
let adminCountsInterval = null;
let adminVotingDeadlineMs = null;
let adminVotingActive = false;

// Cached data for client-side search, filtering, and CSV export
let cachedVoterProjects = [];
let cachedVoterMembersByGroup = new Map();
let cachedVoterHasVoted = false;
let cachedVoterVotingOpen = false;

let cachedAdminSubmissions = [];
let cachedAdminGroupsMap = new Map();
let cachedAdminMembersByGroup = new Map();
let cachedAdminResults = [];

const ADMIN_DISMISSED_KEY = 'arena_admin_dismissed_ids';
const LOCAL_DRAFTS_KEY = 'arena_team_local_drafts';

function getLocalDraft(groupId) {
  if (!groupId) return null;
  try {
    const map = JSON.parse(localStorage.getItem(LOCAL_DRAFTS_KEY) || '{}');
    return map[String(groupId)] || null;
  } catch {
    return null;
  }
}

function saveLocalDraft(groupId, draft) {
  if (!groupId) return;
  try {
    const map = JSON.parse(localStorage.getItem(LOCAL_DRAFTS_KEY) || '{}');
    map[String(groupId)] = { ...draft, saved_at: new Date().toISOString() };
    localStorage.setItem(LOCAL_DRAFTS_KEY, JSON.stringify(map));
  } catch (e) {
    console.warn('Could not persist local draft', e);
  }
}

function clearLocalDraft(groupId) {
  if (!groupId) return;
  try {
    const map = JSON.parse(localStorage.getItem(LOCAL_DRAFTS_KEY) || '{}');
    delete map[String(groupId)];
    localStorage.setItem(LOCAL_DRAFTS_KEY, JSON.stringify(map));
  } catch {
    // ignore
  }
}

function resolveThumbnailUrl(thumbnailPath) {
  if (!thumbnailPath) return '';
  if (/^(https?:\/\/|data:image\/)/i.test(thumbnailPath)) return thumbnailPath;
  return supabase.storage.from('project-thumbnails').getPublicUrl(thumbnailPath).data.publicUrl || '';
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Could not read thumbnail file.'));
    reader.readAsDataURL(file);
  });
}

function getDismissedRejectedIds() {
  try {
    return new Set(JSON.parse(localStorage.getItem(ADMIN_DISMISSED_KEY) || '[]'));
  } catch {
    return new Set();
  }
}

function addDismissedRejectedId(id) {
  const set = getDismissedRejectedIds();
  set.add(String(id));
  localStorage.setItem(ADMIN_DISMISSED_KEY, JSON.stringify([...set]));
}

function showToast(text, duration = 3200) {
  const toastEl = document.querySelector('.toast');
  if (!toastEl) return;
  toastEl.textContent = text;
  toastEl.classList.add('show');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => toastEl.classList.remove('show'), duration);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[ch]);
}

function dashMessage(id, text, isError = false) {
  const el = document.getElementById(id);
  if (el) {
    el.textContent = text || '';
    el.style.color = isError ? 'var(--danger)' : 'var(--success)';
  }
}

function adminMsg(id, text, bad = false) {
  const el = document.getElementById(id);
  if (el) {
    el.textContent = text || '';
    el.style.color = bad ? 'var(--danger)' : 'var(--success)';
  }
}

function submissionWindowOpen() {
  if (!competitionSettings || !competitionSettings.submissions_open) return false;
  return (
    !competitionSettings.submission_deadline ||
    new Date(competitionSettings.submission_deadline).getTime() >= Date.now()
  );
}

function formatDeadline(value) {
  if (!value) return 'No deadline set';
  return new Date(value).toLocaleString();
}

function getYoutubeEmbedUrl(raw) {
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    if (!['youtube.com', 'm.youtube.com', 'youtu.be'].includes(host)) return null;
    let id = '';
    if (host === 'youtu.be') {
      id = u.pathname.split('/').filter(Boolean)[0] || '';
    } else if (u.pathname === '/watch') {
      id = u.searchParams.get('v') || '';
    } else {
      const parts = u.pathname.split('/').filter(Boolean);
      if (['embed', 'shorts', 'live', 'v'].includes(parts[0])) id = parts[1] || '';
    }
    return /^[A-Za-z0-9_-]{11}$/.test(id)
      ? 'https://www.youtube-nocookie.com/embed/' + id
      : null;
  } catch {
    return null;
  }
}

function getYoutubeVideoId(raw) {
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    if (!['youtube.com', 'm.youtube.com', 'youtu.be'].includes(host)) return '';
    let id = '';
    if (host === 'youtu.be') id = u.pathname.split('/').filter(Boolean)[0] || '';
    else if (u.pathname === '/watch') id = u.searchParams.get('v') || '';
    else {
      const parts = u.pathname.split('/').filter(Boolean);
      if (['embed', 'shorts', 'live', 'v'].includes(parts[0])) id = parts[1] || '';
    }
    return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : '';
  } catch {
    return '';
  }
}

function buildYoutubePlayerHtml(rawUrl, thumbnailPath, titleText, extraClass = '', submissionId = '') {
  const embedUrl = getYoutubeEmbedUrl(rawUrl || '');
  if (!embedUrl) {
    return rawUrl
      ? '<p class="dash-help"><a href="' +
          escapeHtml(rawUrl) +
          '" target="_blank" rel="noopener">Open submitted video ↗</a></p>'
      : '';
  }
  const videoId = getYoutubeVideoId(rawUrl || '');
  const customThumb = thumbnailPath ? resolveThumbnailUrl(thumbnailPath) : '';
  const coverImg = customThumb || (videoId ? 'https://i.ytimg.com/vi/' + videoId + '/hqdefault.jpg' : '');
  const autoplayUrl = embedUrl + '?autoplay=1&rel=0';
  const safeTitle = escapeHtml(titleText || 'Project video');
  const safeSubId = escapeHtml(submissionId || '');

  if (!coverImg) {
    return (
      '<div class="yt-cover-player is-playing ' +
      escapeHtml(extraClass) +
      '" data-submission-id="' +
      safeSubId +
      '"><iframe src="' +
      escapeHtml(embedUrl) +
      '" title="' +
      safeTitle +
      '" loading="lazy" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe></div>'
    );
  }

  return (
    '<div class="yt-cover-player ' +
    escapeHtml(extraClass) +
    '" data-submission-id="' +
    safeSubId +
    '" data-yt-embed="' +
    escapeHtml(autoplayUrl) +
    '" data-yt-title="' +
    safeTitle +
    '">' +
    '<img class="yt-cover-img" src="' +
    escapeHtml(coverImg) +
    '" alt="' +
    safeTitle +
    ' thumbnail" loading="lazy">' +
    '<button type="button" class="yt-play-btn" aria-label="Play ' +
    safeTitle +
    '">' +
    '<svg class="yt-play-svg" viewBox="0 0 68 48" aria-hidden="true">' +
    '<path d="M66.52 7.74c-.78-2.93-2.49-5.41-5.42-6.19C55.79.13 34 0 34 0S12.21.13 6.9 1.55c-2.93.78-4.63 3.26-5.42 6.19C.06 13.05 0 24 0 24s.06 10.95 1.48 16.26c.78 2.93 2.49 5.41 5.42 6.19C12.21 47.87 34 48 34 48s21.79-.13 27.1-1.55c2.93-.78 4.64-3.26 5.42-6.19C67.94 34.95 68 24 68 24s-.06-10.95-1.48-16.26z" fill="#ff0000"/>' +
    '<path d="M45 24 27 14v20" fill="#ffffff"/>' +
    '</svg>' +
    '</button>' +
    '</div>'
  );
}

/* ==========================================================================
   ENGAGEMENT ENGINE: 3-CATEGORY 5-STAR RATINGS, 3-RANK VOTING, COMMENTS &
   PER-USER VIDEO WATCH TIME / AUDIENCE ATTENTION ANALYTICS
   ========================================================================== */

const ENGAGEMENT_STORAGE_KEY = 'duetflix_engagement_state_v1';
const ENGAGEMENT_CLOUD_PATH = 'duetflix-meta/engagement_v1.json';

function createEmptyEngagementState() {
  return {
    ratingsBySub: {},
    ranksByUser: {},
    commentsBySub: {},
    watchBySub: {},
  };
}

function getLocalEngagementState() {
  try {
    const raw = localStorage.getItem(ENGAGEMENT_STORAGE_KEY);
    if (!raw) return createEmptyEngagementState();
    const parsed = JSON.parse(raw);
    return {
      ratingsBySub: parsed?.ratingsBySub || {},
      ranksByUser: parsed?.ranksByUser || {},
      commentsBySub: parsed?.commentsBySub || {},
      watchBySub: parsed?.watchBySub || {},
    };
  } catch {
    return createEmptyEngagementState();
  }
}

function mergeEngagementStates(base, incoming) {
  const out = createEmptyEngagementState();
  const a = base || createEmptyEngagementState();
  const b = incoming || createEmptyEngagementState();

  // Merge ratingsBySub
  const subKeys = new Set([...Object.keys(a.ratingsBySub || {}), ...Object.keys(b.ratingsBySub || {})]);
  subKeys.forEach((subId) => {
    out.ratingsBySub[subId] = { ...(a.ratingsBySub?.[subId] || {}) };
    Object.entries(b.ratingsBySub?.[subId] || {}).forEach(([uid, rec]) => {
      const existing = out.ratingsBySub[subId][uid];
      if (!existing || new Date(rec.updatedAt || 0) >= new Date(existing.updatedAt || 0)) {
        out.ratingsBySub[subId][uid] = rec;
      }
    });
  });

  // Merge ranksByUser
  const userKeys = new Set([...Object.keys(a.ranksByUser || {}), ...Object.keys(b.ranksByUser || {})]);
  userKeys.forEach((uid) => {
    const ra = a.ranksByUser?.[uid];
    const rb = b.ranksByUser?.[uid];
    if (!ra) out.ranksByUser[uid] = rb;
    else if (!rb) out.ranksByUser[uid] = ra;
    else {
      out.ranksByUser[uid] =
        new Date(rb.updatedAt || 0) >= new Date(ra.updatedAt || 0) ? rb : ra;
    }
  });

  // Merge commentsBySub (respecting deletedIds)
  const commentSubKeys = new Set([...Object.keys(a.commentsBySub || {}), ...Object.keys(b.commentsBySub || {})]);
  commentSubKeys.forEach((subId) => {
    const map = new Map();
    [...(a.commentsBySub?.[subId] || []), ...(b.commentsBySub?.[subId] || [])].forEach((c) => {
      if (!c || !c.id) return;
      const prev = map.get(c.id);
      if (!prev || (c.deleted && !prev.deleted)) {
        map.set(c.id, c);
      }
    });
    out.commentsBySub[subId] = [...map.values()].sort(
      (x, y) => new Date(x.createdAt || 0) - new Date(y.createdAt || 0)
    );
  });

  // Merge watchBySub (keep max watchedSeconds per user per video)
  const watchSubKeys = new Set([...Object.keys(a.watchBySub || {}), ...Object.keys(b.watchBySub || {})]);
  watchSubKeys.forEach((subId) => {
    out.watchBySub[subId] = { ...(a.watchBySub?.[subId] || {}) };
    Object.entries(b.watchBySub?.[subId] || {}).forEach(([uid, rec]) => {
      const existing = out.watchBySub[subId][uid];
      if (!existing || Number(rec.watchedSeconds || 0) >= Number(existing.watchedSeconds || 0)) {
        out.watchBySub[subId][uid] = {
          ...existing,
          ...rec,
          watchedSeconds: Math.max(Number(existing?.watchedSeconds || 0), Number(rec?.watchedSeconds || 0)),
          attentionPct: Math.max(Number(existing?.attentionPct || 0), Number(rec?.attentionPct || 0)),
          playCount: Math.max(Number(existing?.playCount || 0), Number(rec?.playCount || 0)),
        };
      }
    });
  });

  return out;
}

let engagementState = getLocalEngagementState();
let cloudSyncTimer = null;

function persistEngagementState(syncCloud = true) {
  try {
    localStorage.setItem(ENGAGEMENT_STORAGE_KEY, JSON.stringify(engagementState));
  } catch (e) {
    console.warn('Could not save engagement state locally', e);
  }
  if (!syncCloud) return;
  clearTimeout(cloudSyncTimer);
  cloudSyncTimer = window.setTimeout(async () => {
    try {
      const blob = new Blob([JSON.stringify(engagementState)], { type: 'application/json' });
      await supabase.storage
        .from('project-thumbnails')
        .upload(ENGAGEMENT_CLOUD_PATH, blob, { upsert: true, contentType: 'application/json', cacheControl: '0' });
    } catch {
      // Ignore if storage RLS restricts cloud sync for current role
    }
  }, 600);
}

async function syncEngagementFromCloud() {
  try {
    const pubUrl =
      supabase.storage.from('project-thumbnails').getPublicUrl(ENGAGEMENT_CLOUD_PATH).data.publicUrl +
      '?t=' +
      Date.now();
    const res = await fetch(pubUrl, { cache: 'no-store' });
    if (!res.ok) return;
    const cloudData = await res.json();
    engagementState = mergeEngagementStates(engagementState, cloudData);
    persistEngagementState(false);
  } catch {
    // Cloud state not created yet or offline
  }
}

function getCurrentViewerMeta() {
  const uid = activeUser?.id || 'guest-viewer';
  const email = activeUser?.email || 'guest@duetflix.local';
  const name =
    activeUser?.user_metadata?.full_name ||
    (email.includes('@') ? email.split('@')[0] : 'Student Viewer');
  const role = isArenaAdmin ? 'Admin' : currentArenaRole === 'team' ? 'Team Lead' : 'Voter';
  return { uid, email, name, role };
}

const activeWatchTimers = new Map();

function startVideoWatchTracking(submissionId, titleText, playerEl) {
  const subKey = String(submissionId || titleText || 'unknown');
  if (!subKey) return;
  const viewer = getCurrentViewerMeta();
  if (!engagementState.watchBySub[subKey]) engagementState.watchBySub[subKey] = {};
  const existing = engagementState.watchBySub[subKey][viewer.uid] || {
    userId: viewer.uid,
    userName: viewer.name,
    userEmail: viewer.email,
    watchedSeconds: 0,
    attentionPct: 0,
    playCount: 0,
    totalTicks: 0,
    focusedTicks: 0,
  };

  existing.userName = viewer.name;
  existing.userEmail = viewer.email;
  existing.playCount = Number(existing.playCount || 0) + 1;
  existing.watchedSeconds = Math.max(Number(existing.watchedSeconds || 0), 4);
  existing.totalTicks = Number(existing.totalTicks || 0) + 1;
  existing.focusedTicks = Number(existing.focusedTicks || 0) + 1;
  existing.attentionPct = Math.min(
    100,
    Math.max(Number(existing.attentionPct || 0), 38)
  );
  existing.lastWatchedAt = new Date().toISOString();
  engagementState.watchBySub[subKey][viewer.uid] = existing;
  persistEngagementState(true);
  if (isArenaAdmin && typeof renderAdminVideoAnalytics === 'function') {
    renderAdminVideoAnalytics();
  }

  if (activeWatchTimers.has(subKey)) {
    clearInterval(activeWatchTimers.get(subKey));
  }

  const intervalId = window.setInterval(() => {
    if (!playerEl || !document.body.contains(playerEl) || !playerEl.classList.contains('is-playing')) {
      clearInterval(intervalId);
      activeWatchTimers.delete(subKey);
      return;
    }
    const rect = playerEl.getBoundingClientRect();
    const inViewport = rect.bottom > 60 && rect.top < window.innerHeight - 60;
    const isTabVisible = document.visibilityState === 'visible';
    const rec = engagementState.watchBySub[subKey]?.[viewer.uid];
    if (!rec) return;

    rec.totalTicks = Number(rec.totalTicks || 1) + 1;
    if (inViewport && isTabVisible) {
      rec.focusedTicks = Number(rec.focusedTicks || 1) + 1;
      rec.watchedSeconds = Number(rec.watchedSeconds || 0) + 3;
      const focusRatio = Math.min(1, rec.focusedTicks / Math.max(1, rec.totalTicks));
      const durationFactor = Math.min(1, rec.watchedSeconds / 150); // 2.5 mins benchmark
      rec.attentionPct = Math.min(
        100,
        Math.round((0.35 + 0.65 * durationFactor) * (0.55 + 0.45 * focusRatio) * 100)
      );
      rec.lastWatchedAt = new Date().toISOString();
      persistEngagementState(rec.watchedSeconds % 9 === 0);
      if (isArenaAdmin && typeof renderAdminVideoAnalytics === 'function') {
        renderAdminVideoAnalytics();
      }
    }
  }, 3000);

  activeWatchTimers.set(subKey, intervalId);
}

function formatWatchMinutes(seconds) {
  const sec = Math.max(0, Math.round(Number(seconds || 0)));
  const minsDecimal = (sec / 60).toFixed(1);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${minsDecimal} mins (${m}m ${String(s).padStart(2, '0')}s)`;
}

/* ==========================================================================
   AUTH STATE ROUTING & HEADER PROFILE ICON MENU
   ========================================================================== */

// Close profile menu when clicking outside + handle YouTube thumbnail cover play
document.addEventListener('click', (e) => {
  const ytCover = e.target.closest('.yt-cover-player:not(.is-playing)');
  if (ytCover && ytCover.dataset.ytEmbed) {
    const src = ytCover.dataset.ytEmbed;
    const title = ytCover.dataset.ytTitle || 'Project video';
    const card = ytCover.closest('[data-vote-submission], [data-submission-id]');
    const subId =
      ytCover.dataset.submissionId ||
      card?.dataset.voteSubmission ||
      card?.dataset.submissionId ||
      title;
    ytCover.classList.add('is-playing');
    ytCover.innerHTML =
      '<iframe src="' +
      escapeHtml(src) +
      '" title="' +
      escapeHtml(title) +
      '" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>';
    startVideoWatchTracking(subId, title, ytCover);
    return;
  }

  const menu = document.querySelector('.profile-menu-wrap.open');
  if (menu && !menu.contains(e.target)) {
    menu.classList.remove('open');
    menu.querySelector('.profile-trigger')?.setAttribute('aria-expanded', 'false');
  }
});

supabase.auth.onAuthStateChange((_event, session) => {
  const nav = document.querySelector('.navactions');
  if (!nav) return;

  nav.querySelectorAll('.profile-menu-wrap, .user-chip, [data-signout]').forEach((n) => n.remove());

  if (session) {
    // Hide unauthenticated Sign In and Join DuetFlix buttons
    nav.querySelectorAll('#headerChooseRole, #headerSignIn').forEach((b) => (b.hidden = true));

    const userEmail = session.user.email || 'Signed-in User';
    const initial = userEmail.charAt(0).toUpperCase();

    const profileWrap = document.createElement('div');
    profileWrap.className = 'profile-menu-wrap';
    profileWrap.innerHTML =
      '<button type="button" class="profile-trigger" aria-expanded="false" aria-label="Account profile menu">' +
      '<span class="profile-avatar">' + escapeHtml(initial) + '</span>' +
      '<span class="profile-trigger-role" id="headerRoleBadge">DuetFlix</span>' +
      '<span class="profile-trigger-caret" aria-hidden="true">▾</span>' +
      '</button>' +
      '<div class="profile-dropdown" role="menu">' +
      '<div class="profile-dropdown-header">' +
      '<div class="profile-dropdown-label"><span>Signed in as</span><span class="role-pill" id="dropdownRolePill">DuetFlix</span></div>' +
      '<div class="profile-dropdown-email">' + escapeHtml(userEmail) + '</div>' +
      '</div>' +
      '<div class="profile-dropdown-actions">' +
      '<button type="button" class="profile-dropdown-btn" data-go-workspace><span>Go to My Workspace</span><span>↗</span></button>' +
      '<button type="button" class="profile-dropdown-btn signout-item" data-signout="true"><span>Sign out</span><span>→</span></button>' +
      '</div>' +
      '</div>';

    const triggerBtn = profileWrap.querySelector('.profile-trigger');
    triggerBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = profileWrap.classList.toggle('open');
      triggerBtn.setAttribute('aria-expanded', String(isOpen));
    });

    profileWrap.querySelector('[data-go-workspace]').addEventListener('click', () => {
      profileWrap.classList.remove('open');
      if (isArenaAdmin) adminDashboard?.scrollIntoView({ behavior: 'smooth' });
      else if (currentArenaRole === 'team') dashboard?.scrollIntoView({ behavior: 'smooth' });
      else if (currentArenaRole === 'voter') voterDashboard?.scrollIntoView({ behavior: 'smooth' });
    });

    profileWrap.querySelector('[data-signout]').addEventListener('click', async () => {
      profileWrap.classList.remove('open');
      await supabase.auth.signOut();
      showToast('Signed out of DuetFlix.');
    });

    nav.append(profileWrap);

    setTimeout(async () => {
      try {
        await checkArenaAdmin();
        const roleBadge = document.getElementById('headerRoleBadge');
        const dropdownPill = document.getElementById('dropdownRolePill');

        if (isArenaAdmin) {
          activeUser = session.user;
          if (roleBadge) roleBadge.textContent = 'Admin';
          if (dropdownPill) dropdownPill.textContent = 'Admin';
          document.body.classList.add('authenticated-view');
          dashboard?.classList.remove('visible');
          await loadVoterDashboard(session.user, { keepTeamView: true });
          adminDashboard?.classList.add('visible');
          handlePendingWatchRedirect();
          return;
        }

        const selectedRole = sessionStorage.getItem('arena_selected_role');
        let { data: role, error } = await supabase.rpc('get_arena_role');
        if (error) throw error;

        if (!role && selectedRole) {
          const assigned = await supabase.rpc('set_arena_role',{ requested_role: selectedRole });
          if (assigned.error) throw assigned.error;
          role = assigned.data;
        }

        if (!role && !selectedRole) {
          const fallbackRole = session.user?.user_metadata?.arena_role || 'voter';
          const assigned = await supabase.rpc('set_arena_role', { requested_role: fallbackRole });
          if (!assigned.error) role = assigned.data;
        }

        if (!role) {
          document.body.classList.remove('authenticated-view');
          roleChooser?.scrollIntoView({ behavior: 'smooth' });
          return;
        }

        sessionStorage.removeItem('arena_selected_role');
        currentArenaRole = role;
        const labelText = role === 'team' ? 'Team Lead' : 'Voter';
        if (roleBadge) roleBadge.textContent = labelText;
        if (dropdownPill) dropdownPill.textContent = labelText;

        document.body.classList.add('authenticated-view');
        if (role === 'team') {
          await loadDashboard(session.user);
          await loadVoterDashboard(session.user, { keepTeamView: true });
        } else if (role === 'voter') {
          dashboard?.classList.remove('visible');
          await loadVoterDashboard(session.user);
        }
        handlePendingWatchRedirect();
      } catch (err) {
        console.error('DuetFlix role routing failed', err);
        const msg = document.getElementById('voterMessage');
        if (msg) msg.textContent = err.message || 'Could not open your account dashboard.';
        document.body.classList.remove('authenticated-view');
        showToast(err.message || 'Could not open your dashboard.', 4000);
      }
    }, 0);
  } else {
    nav.querySelectorAll('.profile-menu-wrap, .user-chip, [data-signout]').forEach((n) => n.remove());
    nav.querySelectorAll('#headerChooseRole, #headerSignIn').forEach((b) => (b.hidden = false));
    document.body.classList.remove('authenticated-view');
    dashboard?.classList.remove('visible');
    voterDashboard?.classList.remove('visible');
    adminDashboard?.classList.remove('visible');
    isArenaAdmin = false;
    activeUser = null;
    currentArenaRole = null;
  }
});

/* ==========================================================================
   STUDENT / TEAM LEAD WORKSPACE
   ========================================================================== */

function addMemberRow(name = '', roll = '') {
  const container = document.getElementById('memberRows');
  if (!container) return;
  const row = document.createElement('div');
  row.className = 'member-row';
  row.innerHTML =
    '<input name="memberName" required maxlength="100" placeholder="Member full name">' +
    '<input name="rollNumber" required maxlength="40" placeholder="Roll no. (e.g. 26F-CS-028)">' +
    '<button class="member-remove" type="button">Remove</button>';
  row.querySelectorAll('input')[0].value = name;
  row.querySelectorAll('input')[1].value = roll;
  row.querySelector('button').addEventListener('click', () => row.remove());
  container.append(row);
}

document.getElementById('addMember')?.addEventListener('click', () => addMemberRow());

function updateTeamStepper(hasGroups, hasSubmission, isApproved) {
  const stepper = document.getElementById('teamWorkflowStepper');
  if (!stepper) return;
  const steps = stepper.querySelectorAll('.workflow-step');
  if (steps.length < 4) return;

  steps.forEach((s) => s.classList.remove('done', 'active'));
  steps[0].classList.add('done');

  if (!hasGroups) {
    steps[1].classList.add('active');
  } else {
    steps[1].classList.add('done');
    if (!hasSubmission) {
      steps[2].classList.add('active');
    } else {
      steps[2].classList.add('done');
      if (isApproved) {
        steps[3].classList.add('done');
      } else {
        steps[3].classList.add('active');
      }
    }
  }
}

async function renderGroupCard(group) {
  const [memberResult, submissionResult] = await Promise.all([
    supabase
      .from('group_members')
      .select('id,member_name,roll_number')
      .eq('group_id', group.id)
      .order('created_at'),
    supabase
      .from('project_submissions')
      .select('id,title,description,video_url,video_path,thumbnail_path,status,admin_feedback,updated_at')
      .eq('group_id', group.id)
      .maybeSingle(),
  ]);
  if (memberResult.error) throw memberResult.error;
  if (submissionResult.error) throw submissionResult.error;

  const members = memberResult.data || [];
  const sub = submissionResult.data;
  const localDraft = getLocalDraft(group.id);
  const displaySub = sub || localDraft;
  const status = sub
    ? '<span class="dash-status ' + escapeHtml(sub.status) + '">' + escapeHtml(sub.status) + '</span>'
    : localDraft
    ? '<span class="dash-status draft">Private draft saved</span>'
    : '<span class="dash-status draft">Not submitted</span>';

  const roster = members
    .map(
      (m) =>
        '<div class="member-edit-row" data-member-id="' +
        escapeHtml(m.id) +
        '">' +
        '<input class="member-edit-name" maxlength="100" value="' +
        escapeHtml(m.member_name) +
        '" aria-label="Member name">' +
        '<input class="member-edit-roll" maxlength="40" value="' +
        escapeHtml(m.roll_number) +
        '" aria-label="Member roll number">' +
        '<button class="text-button" type="button" data-save-member>Save</button>' +
        '<button class="member-remove" type="button" data-delete-member>Delete</button>' +
        '</div>'
    )
    .join('');

  const feedback =
    sub && sub.admin_feedback
      ? '<div class="deadline-note" style="border-color:var(--warning);background:var(--warning-bg);color:var(--warning)"><div><strong>Faculty Review Feedback:</strong> ' +
        escapeHtml(sub.admin_feedback) +
        '</div></div>'
      : '';

  const draftMode = !submissionWindowOpen();
  const localDraftNotice =
    !sub && localDraft
      ? '<div class="deadline-note" style="margin-top:10px"><div><strong>Saved Private Draft:</strong> ' +
        (draftMode
          ? 'Your draft is saved on this device while submissions are closed. Once the admin opens the submission window, click <em>Submit for Faculty Review</em> below.'
          : 'Submissions are now open! Review your saved draft below and click <em>Submit for Faculty Review</em> to send it to the faculty queue.') +
        '</div></div>'
      : '';

  const formHtml =
    '<form class="submission-form" data-group="' +
    escapeHtml(group.id) +
    '" data-submission="' +
    escapeHtml(sub ? sub.id : '') +
    '" data-current-status="' +
    escapeHtml(sub ? sub.status : '') +
    '" data-current-thumbnail="' +
    escapeHtml(displaySub && displaySub.thumbnail_path ? displaySub.thumbnail_path : '') +
    '">' +
    '<h3>' +
    (sub ? 'Edit Project Submission' : localDraft ? 'Continue Saved Draft' : 'Submit Project Demonstration') +
    '</h3>' +
    '<label class="dash-field">Project Title<input name="title" maxlength="140" required value="' +
    escapeHtml(displaySub ? displaySub.title : '') +
    '" placeholder="e.g. Autonomous Traffic Signal Optimizer"></label>' +
    '<label class="dash-field">Technical Abstract &amp; Description<textarea name="description" maxlength="5000" required placeholder="Explain the engineering problem, your architecture/models used, and key outcomes">' +
    escapeHtml(displaySub ? displaySub.description : '') +
    '</textarea></label>' +
    '<label class="dash-field">YouTube Demonstration Link<input name="videoUrl" type="url" required value="' +
    escapeHtml(displaySub && displaySub.video_url ? displaySub.video_url : '') +
    '" placeholder="https://www.youtube.com/watch?v=…"></label>' +
    '<label class="dash-field">Video Thumbnail (PNG or JPG)<input name="thumbnailFile" type="file" accept="image/png,image/jpeg,.png,.jpg,.jpeg"></label>' +
    '<p class="youtube-link-note">Upload one JPG or PNG image (maximum 5 MB). This image will be used as your project video thumbnail and as the background image in the homepage featured-project area. ' +
    (displaySub && displaySub.thumbnail_path ? 'A thumbnail is already attached. Choose a new file only if you want to replace it.' : 'A thumbnail is optional, but recommended.') +
    '</p>' +
    '<p class="youtube-link-note">Supports standard YouTube watch links, youtu.be share links, or YouTube Shorts. ' +
    (draftMode
      ? 'Submissions are currently closed, so changes will be saved privately as a draft.'
      : 'Submitting sends your project to the faculty moderation queue.') +
    '</p>' +
    '<button class="btn primary" type="submit">' +
    (draftMode ? 'Save Private Draft' : sub ? 'Update Submission' : 'Submit for Faculty Review') +
    '</button>' +
    '<div class="dash-message" role="status"></div>' +
    '</form>';

  const video =
    displaySub && displaySub.video_url
      ? buildYoutubePlayerHtml(
          displaySub.video_url,
          displaySub.thumbnail_path,
          displaySub.title,
          'youtube-player'
        )
      : '';

  return {
    hasSubmission: Boolean(displaySub),
    isApproved: Boolean(sub && sub.status === 'approved'),
    html:
      '<article class="group-panel">' +
      '<div class="group-title"><h3>' +
      escapeHtml(group.name) +
      '</h3>' +
      status +
      '</div>' +
      '<div class="roster-editor" data-group-members="' +
      escapeHtml(group.id) +
      '">' +
      '<strong style="display:block;margin-bottom:6px">Team Roster (' +
      members.length +
      ' members)</strong>' +
      roster +
      '<div class="member-edit-add">' +
      '<input placeholder="New member full name" maxlength="100">' +
      '<input placeholder="Roll no. (e.g. 26F-CS-099)" maxlength="40">' +
      '<button class="btn sm" type="button" data-add-member>+ Add</button>' +
      '</div>' +
      '<div class="dash-message" role="status"></div>' +
      '</div>' +
      (displaySub
        ? '<div style="font-size:14px;margin-top:10px"><strong>' +
          escapeHtml(displaySub.title) +
          '</strong><p class="dash-help" style="margin-top:4px">' +
          escapeHtml(displaySub.description) +
          '</p></div>' +
          video +
          feedback +
          localDraftNotice
        : '') +
      formHtml +
      '</article>',
  };
}

async function loadDashboard(user) {
  if (!user || !dashboard) return;
  activeUser = user;
  currentArenaRole = 'team';
  dashboard.classList.add('visible');
  voterDashboard?.classList.remove('visible');
  document.body.classList.add('authenticated-view');

  const profile = await supabase.from('profiles').select('full_name').eq('id', user.id).maybeSingle();
  const displayName =
    profile.data && profile.data.full_name
      ? profile.data.full_name
      : (user.email || 'Student').split('@')[0];
  const welcomeEl = document.getElementById('dashWelcome');
  if (welcomeEl) welcomeEl.textContent = 'Welcome, ' + displayName;

  const settings = await supabase
    .from('competition_settings')
    .select('title,submissions_open,submission_deadline')
    .eq('id', true)
    .maybeSingle();
  if (settings.error) throw settings.error;
  competitionSettings = settings.data;

  const notice = document.getElementById('competitionNotice');
  if (competitionSettings && notice) {
    const cleanTitle = String(competitionSettings.title || 'DuetFlix').replace(/AI Project Arena/gi, 'DuetFlix');
    notice.innerHTML =
      '<span><strong>' +
      escapeHtml(cleanTitle) +
      ':</strong> ' +
      (competitionSettings.submissions_open
        ? 'Submissions are open'
        : 'Submissions are currently closed') +
      ' · Deadline: ' +
      escapeHtml(formatDeadline(competitionSettings.submission_deadline)) +
      (submissionWindowOpen() ? '' : ' · Draft saving remains enabled.') +
      '</span>';
  }

  const voteStats = await supabase.rpc('get_my_team_vote_counts');
  if (voteStats.error) throw voteStats.error;
  const statsEl = document.getElementById('teamVoteStats');
  const statRows = voteStats.data || [];
  if (statsEl) {
    statsEl.innerHTML =
      '<h3>Your Team’s Live Standing</h3>' +
      (statRows.length
        ? '<table class="vote-table"><thead><tr><th>Team / Project</th><th>Review Status</th><th>Verified Votes</th></tr></thead><tbody>' +
          statRows
            .map(
              (x) =>
                '<tr><td><strong>' +
                escapeHtml(x.project_title || x.team_name) +
                '</strong></td><td><span class="dash-status ' +
                escapeHtml(x.submission_status || 'draft') +
                '">' +
                escapeHtml(x.submission_status || 'Not submitted') +
                '</span></td><td><strong style="font-family:var(--mono);font-size:16px">' +
                Number(x.vote_count || 0) +
                '</strong></td></tr>'
            )
            .join('') +
          '</tbody></table>'
        : '<div class="dashboard-empty">Register your team below to begin tracking your submission status and vote totals.</div>');
  }

  const list = document.getElementById('groupList');
  if (!list) return;
  list.innerHTML = '<div class="dashboard-empty">Loading your registered teams…</div>';

  const groups = await supabase
    .from('project_groups')
    .select('id,name,created_at')
    .eq('created_by', user.id)
    .order('created_at', { ascending: false });
  if (groups.error) throw groups.error;

  if (!groups.data || !groups.data.length) {
    updateTeamStepper(false, false, false);
    list.innerHTML =
      '<div class="dashboard-empty">No team registered yet. Use the form on the left to register your first team roster.</div>';
    return;
  }

  const rendered = await Promise.all(groups.data.map(renderGroupCard));
  const anySub = rendered.some((r) => r.hasSubmission);
  const anyApproved = rendered.some((r) => r.isApproved);
  updateTeamStepper(true, anySub, anyApproved);
  list.innerHTML = rendered.map((r) => r.html).join('');
}

/* ==========================================================================
   VOTER WORKSPACE, 3-CATEGORY 5-STAR RATINGS, 3-RANK CHOICES & COMMENTS
   ========================================================================== */

const openVoteDrawers = new Set();
const openCommentDrawers = new Set();

function getProjectEngagementStats(subId) {
  const key = String(subId || '');
  const ratingsMap = engagementState.ratingsBySub[key] || {};
  const ratingEntries = Object.values(ratingsMap);
  let charSum = 0,
    charCount = 0;
  let voiceSum = 0,
    voiceCount = 0;
  let storySum = 0,
    storyCount = 0;

  ratingEntries.forEach((r) => {
    if (Number(r.character_consistency) > 0) {
      charSum += Number(r.character_consistency);
      charCount++;
    }
    if (Number(r.voice_over) > 0) {
      voiceSum += Number(r.voice_over);
      voiceCount++;
    }
    if (Number(r.story) > 0) {
      storySum += Number(r.story);
      storyCount++;
    }
  });

  const avgChar = charCount ? charSum / charCount : 0;
  const avgVoice = voiceCount ? voiceSum / voiceCount : 0;
  const avgStory = storyCount ? storySum / storyCount : 0;
  const activeAvgs = [avgChar, avgVoice, avgStory].filter((v) => v > 0);
  const overallAvg = activeAvgs.length
    ? activeAvgs.reduce((a, b) => a + b, 0) / activeAvgs.length
    : 0;

  let rank1 = 0,
    rank2 = 0,
    rank3 = 0;
  Object.values(engagementState.ranksByUser || {}).forEach((uRanks) => {
    if (!uRanks) return;
    if (String(uRanks['1'] || '') === key) rank1++;
    if (String(uRanks['2'] || '') === key) rank2++;
    if (String(uRanks['3'] || '') === key) rank3++;
  });

  const comments = (engagementState.commentsBySub[key] || []).filter((c) => !c.deleted);
  const watchMap = engagementState.watchBySub[key] || {};
  const watchEntries = Object.values(watchMap);
  const totalViewers = watchEntries.length;
  const avgWatchSeconds = totalViewers
    ? watchEntries.reduce((s, w) => s + Number(w.watchedSeconds || 0), 0) / totalViewers
    : 0;
  const avgAttentionPct = totalViewers
    ? Math.round(
        watchEntries.reduce((s, w) => s + Number(w.attentionPct || 0), 0) / totalViewers
      )
    : 0;

  return {
    ratingCount: ratingEntries.length,
    avgChar,
    avgVoice,
    avgStory,
    overallAvg,
    rank1,
    rank2,
    rank3,
    weightedRankPoints: rank1 * 3 + rank2 * 2 + rank3 * 1,
    comments,
    watchEntries,
    totalViewers,
    avgWatchSeconds,
    avgAttentionPct,
  };
}

function buildFiveStarsRowHtml(categoryKey, categoryLabel, currentVal) {
  const val = Number(currentVal || 0);
  let starsHtml = '';
  for (let i = 1; i <= 5; i++) {
    const filled = i <= val;
    starsHtml +=
      '<button type="button" class="star-pick-btn ' +
      (filled ? 'is-filled' : '') +
      '" data-star-cat="' +
      escapeHtml(categoryKey) +
      '" data-star-val="' +
      i +
      '" aria-label="Rate ' +
      escapeHtml(categoryLabel) +
      ' ' +
      i +
      ' out of 5 stars">' +
      (filled ? '★' : '☆') +
      '</button>';
  }
  return (
    '<div class="star-category-row" data-cat-row="' +
    escapeHtml(categoryKey) +
    '">' +
    '<span class="star-category-label">' +
    escapeHtml(categoryLabel) +
    '</span>' +
    '<div class="star-buttons-group">' +
    starsHtml +
    '<span class="star-score-pill" data-cat-score="' +
    escapeHtml(categoryKey) +
    '">' +
    (val ? val + ' / 5' : '0 / 5') +
    '</span>' +
    '</div>' +
    '</div>'
  );
}

function renderRankedBallotSummary() {
  const bar = document.getElementById('voterRankedBallotSummary');
  if (!bar) return;
  const viewer = getCurrentViewerMeta();
  const userRanks = engagementState.ranksByUser[viewer.uid] || {};
  const titleById = new Map(
    cachedVoterProjects.map((p) => [String(p.submission_id), p.project_title || 'Project'])
  );

  const slots = [
    { rank: '1', icon: '🥇', label: 'Rank #1 (1st Choice)' },
    { rank: '2', icon: '🥈', label: 'Rank #2 (2nd Choice)' },
    { rank: '3', icon: '🥉', label: 'Rank #3 (3rd Choice)' },
  ];

  bar.innerHTML =
    '<div class="ranked-ballot-head">' +
    '<strong>Your 3 Voting Rank Choices</strong>' +
    '<span>Assign Rank #1, #2, and #3 plus 5-star category ratings using the Vote button on any project below.</span>' +
    '</div>' +
    '<div class="ranked-ballot-slots">' +
    slots
      .map((s) => {
        const chosenId = userRanks[s.rank] ? String(userRanks[s.rank]) : '';
        const chosenTitle = chosenId ? titleById.get(chosenId) || 'Selected Project' : '';
        return (
          '<div class="ranked-slot-pill ' +
          (chosenId ? 'is-assigned' : '') +
          '">' +
          '<span class="ranked-slot-tag">' +
          s.icon +
          ' ' +
          s.label +
          '</span>' +
          '<strong class="ranked-slot-val">' +
          (chosenTitle ? escapeHtml(chosenTitle) : 'Not selected yet') +
          '</strong>' +
          '</div>'
        );
      })
      .join('') +
    '</div>';
}

function renderVoterProjects() {
  const list = document.getElementById('voterProjectList');
  const countBadge = document.getElementById('voterCountBadge');
  const searchInput = document.getElementById('voterSearchInput');
  if (!list) return;

  renderRankedBallotSummary();

  const query = (searchInput?.value || '').trim().toLowerCase();
  const filtered = cachedVoterProjects.filter((x) => {
    if (!query) return true;
    const members = cachedVoterMembersByGroup.get(x.group_id) || [];
    const memberText = members.map((m) => `${m.member_name} ${m.roll_number}`).join(' ');
    const haystack = `${x.project_title || ''} ${x.team_name || ''} ${x.project_description || ''} ${memberText}`.toLowerCase();
    return haystack.includes(query);
  });

  if (countBadge) {
    countBadge.textContent = `${filtered.length} of ${cachedVoterProjects.length} approved project${cachedVoterProjects.length === 1 ? '' : 's'}`;
  }

  if (!cachedVoterProjects.length) {
    list.innerHTML = '<div class="dashboard-empty">No approved projects are available in the gallery yet.</div>';
    return;
  }

  if (!filtered.length) {
    list.innerHTML = '<div class="dashboard-empty">No projects match your search query. Try clearing the search box.</div>';
    return;
  }

  const viewer = getCurrentViewerMeta();
  const myRanks = engagementState.ranksByUser[viewer.uid] || {};
  const titleById = new Map(
    cachedVoterProjects.map((p) => [String(p.submission_id), p.project_title || 'Project'])
  );

  list.innerHTML = filtered
    .map((x) => {
      const subId = String(x.submission_id);
      const members = cachedVoterMembersByGroup.get(x.group_id) || [];
      const stats = getProjectEngagementStats(subId);
      const myRating = engagementState.ratingsBySub[subId]?.[viewer.uid] || {
        character_consistency: 0,
        voice_over: 0,
        story: 0,
      };
      const myRankForThis =
        String(myRanks['1'] || '') === subId
          ? 1
          : String(myRanks['2'] || '') === subId
          ? 2
          : String(myRanks['3'] || '') === subId
          ? 3
          : 0;

      const isVoteOpen = openVoteDrawers.has(subId);
      const isCommentsOpen = openCommentDrawers.has(subId);

      const rankOptionsHtml = [1, 2, 3]
        .map((rk) => {
          const icon = rk === 1 ? '🥇' : rk === 2 ? '🥈' : '🥉';
          const assignedSubId = myRanks[String(rk)] ? String(myRanks[String(rk)]) : '';
          const isCurrent = myRankForThis === rk;
          const otherTitle =
            assignedSubId && assignedSubId !== subId ? titleById.get(assignedSubId) : '';
          return (
            '<button type="button" class="rank-choice-btn ' +
            (isCurrent ? 'is-selected' : '') +
            '" data-pick-rank="' +
            rk +
            '">' +
            '<span>' +
            icon +
            ' Rank #' +
            rk +
            (rk === 1 ? ' (1st Choice)' : rk === 2 ? ' (2nd Choice)' : ' (3rd Choice)') +
            '</span>' +
            '<small>' +
            (isCurrent
              ? '✓ Assigned to this film'
              : otherTitle
              ? 'Currently: ' + escapeHtml(otherTitle)
              : 'Available slot') +
            '</small>' +
            '</button>'
          );
        })
        .join('');

      const commentsListHtml = stats.comments.length
        ? stats.comments
            .map((c) => {
              const canDelete = isArenaAdmin || c.userId === viewer.uid;
              return (
                '<div class="video-comment-item" data-comment-id="' +
                escapeHtml(c.id) +
                '">' +
                '<div class="video-comment-top">' +
                '<div>' +
                '<strong>' +
                escapeHtml(c.userName || 'Student') +
                '</strong> ' +
                '<span class="comment-role-pill">' +
                escapeHtml(c.userRole || 'Voter') +
                '</span>' +
                '</div>' +
                '<div class="video-comment-meta">' +
                '<span>' +
                escapeHtml(new Date(c.createdAt).toLocaleString()) +
                '</span>' +
                (canDelete
                  ? '<button type="button" class="comment-delete-btn" data-delete-comment="' +
                    escapeHtml(c.id) +
                    '" title="Delete comment">🗑 Delete</button>'
                  : '') +
                '</div>' +
                '</div>' +
                '<p class="video-comment-body">' +
                escapeHtml(c.text) +
                '</p>' +
                '</div>'
              );
            })
            .join('')
        : '<div class="comments-empty">No comments yet. Be the first to share your thoughts on this film!</div>';

      return (
        '<article class="voter-card" data-vote-submission="' +
        escapeHtml(subId) +
        '" data-selected-rank="' +
        myRankForThis +
        '" data-star-character_consistency="' +
        Number(myRating.character_consistency || 0) +
        '" data-star-voice_over="' +
        Number(myRating.voice_over || 0) +
        '" data-star-story="' +
        Number(myRating.story || 0) +
        '">' +
        '<div class="voter-card-top-row">' +
        '<div class="eyebrow">' +
        escapeHtml(x.team_name || 'Student Team') +
        '</div>' +
        (stats.overallAvg > 0
          ? '<span class="card-avg-star-badge">★ ' +
            stats.overallAvg.toFixed(1) +
            ' / 5 (' +
            stats.ratingCount +
            ')</span>'
          : '<span class="card-avg-star-badge is-unrated">☆ Rate this film</span>') +
        '</div>' +
        '<h3>' +
        escapeHtml(x.project_title) +
        '</h3>' +
        '<p>' +
        escapeHtml(x.project_description) +
        '</p>' +
        '<div class="admin-member-list"><strong>Team Roster</strong>' +
        (members
          .map(
            (member) =>
              '<div>' +
              escapeHtml(member.member_name) +
              ' · <span style="font-family:var(--mono)">' +
              escapeHtml(member.roll_number) +
              '</span></div>'
          )
          .join('') || '<span>Roster verified by faculty</span>') +
        '</div>' +
        buildYoutubePlayerHtml(x.video_url, x.thumbnail_path, x.project_title, '', subId) +
        '<div class="voter-card-footer">' +
        '<div class="voter-card-badges">' +
        '<span style="font-size:12px;color:var(--muted)">Verified Entry</span>' +
        (myRankForThis
          ? '<span class="my-rank-pill">' +
            (myRankForThis === 1 ? '🥇' : myRankForThis === 2 ? '🥈' : '🥉') +
            ' Your Rank #' +
            myRankForThis +
            '</span>'
          : '') +
        '</div>' +
        '<div class="voter-card-actions">' +
        '<button class="btn sm comment-toggle-btn ' +
        (isCommentsOpen ? 'active' : '') +
        '" type="button" data-toggle-comments>' +
        '💬 Comments (' +
        stats.comments.length +
        ')' +
        '</button>' +
        '<button class="btn primary vote-dropdown-toggle-btn" type="button" data-toggle-vote-drawer>' +
        (myRankForThis
          ? '✓ Ranked #' + myRankForThis + ' · Rate & Vote ▾'
          : myRating.character_consistency || myRating.voice_over || myRating.story
          ? '★ Rated · Choose Rank ▾'
          : '★ Vote & Rate ▾') +
        '</button>' +
        '</div>' +
        '</div>' +
        /* DROPDOWN 1: 3-CATEGORY 5-STAR RATING + 3 RANK CHOICES */
        '<div class="vote-rating-drawer" data-vote-drawer ' +
        (isVoteOpen ? '' : 'hidden') +
        '>' +
        '<div class="drawer-section-head">' +
        '<strong>1. Rate Film Categories (Click 1 to 5 Stars)</strong>' +
        '<span>Give up to 5 stars for each category</span>' +
        '</div>' +
        '<div class="star-categories-list">' +
        buildFiveStarsRowHtml(
          'character_consistency',
          'Character Consistency',
          myRating.character_consistency
        ) +
        buildFiveStarsRowHtml('voice_over', 'Voice Over', myRating.voice_over) +
        buildFiveStarsRowHtml('story', 'Story', myRating.story) +
        '</div>' +
        '<div class="drawer-section-head" style="margin-top:14px">' +
        '<strong>2. Choose Your Voting Rank (Top 3 Choices: Rank 1, 2, or 3)</strong>' +
        '<span>Rank your top 3 favourite projects across DuetFlix</span>' +
        '</div>' +
        '<div class="rank-choices-grid">' +
        rankOptionsHtml +
        '</div>' +
        '<div class="vote-drawer-actions">' +
        '<button type="button" class="btn primary" data-submit-vote-rating>' +
        '✓ Save Stars & Confirm Rank Vote' +
        '</button>' +
        '</div>' +
        '</div>' +
        /* DROPDOWN 2: SEPARATE COMMENTS SECTION (VISIBLE TO ALL VOTERS & ADMIN) */
        '<div class="comments-drawer" data-comments-drawer ' +
        (isCommentsOpen ? '' : 'hidden') +
        '>' +
        '<div class="drawer-section-head">' +
        '<strong>💬 Film Comments & Feedback (' +
        stats.comments.length +
        ')</strong>' +
        '<span>Visible to all voters, teams & faculty admins</span>' +
        '</div>' +
        '<div class="video-comments-list">' +
        commentsListHtml +
        '</div>' +
        '<div class="video-comment-form">' +
        '<input type="text" class="comment-input" data-comment-input maxlength="500" placeholder="Add a public comment about this film…" aria-label="Write a comment" />' +
        '<button type="button" class="btn sm primary" data-post-comment>Post Comment</button>' +
        '</div>' +
        '</div>' +
        '</article>'
      );
    })
    .join('');
}

document.getElementById('voterSearchInput')?.addEventListener('input', renderVoterProjects);

async function loadVoterDashboard(user, opts = {}) {
  if (!user || !voterDashboard) return;
  activeUser = user;
  if (!opts.keepTeamView) {
    currentArenaRole = 'voter';
    dashboard?.classList.remove('visible');
  }
  voterDashboard.classList.add('visible');
  document.body.classList.add('authenticated-view');

  await syncEngagementFromCloud();

  const profile = await supabase.from('profiles').select('full_name').eq('id', user.id).maybeSingle();
  const displayName = profile.data?.full_name || (user.email || 'Student').split('@')[0];
  const welcomeEl = document.getElementById('voterWelcome');
  if (welcomeEl) welcomeEl.textContent = 'Welcome, ' + displayName;

  const [settings, projects, votes, membersRes] = await Promise.all([
    supabase.from('competition_settings').select('title,voting_open,voting_deadline').eq('id', true).maybeSingle(),
    supabase.rpc('get_approved_arena_projects'),
    supabase.from('votes').select('submission_id').eq('voter_id', user.id),
    supabase.from('group_members').select('group_id,member_name,roll_number').order('created_at'),
  ]);

  if (settings.error) throw settings.error;

  cachedVoterMembersByGroup = new Map();
  (membersRes.data || []).forEach((m) => {
    if (!cachedVoterMembersByGroup.has(m.group_id)) cachedVoterMembersByGroup.set(m.group_id, []);
    cachedVoterMembersByGroup.get(m.group_id).push(m);
  });

  const votingDeadlineMs = settings.data?.voting_deadline
    ? new Date(settings.data.voting_deadline).getTime()
    : null;
  cachedVoterVotingOpen =
    !!settings.data?.voting_open &&
    !!votingDeadlineMs &&
    Number.isFinite(votingDeadlineMs) &&
    votingDeadlineMs > Date.now();

  const notice = document.getElementById('votingNotice');
  if (notice) {
    notice.innerHTML =
      '<span><strong>' +
      (cachedVoterVotingOpen ? 'Voting Window is Open' : 'Voting Window is Closed') +
      '</strong>' +
      (settings.data?.voting_deadline
        ? ' · Closes: ' + escapeHtml(new Date(settings.data.voting_deadline).toLocaleString())
        : '') +
      '</span>';
  }

  let approvedList = !projects.error && Array.isArray(projects.data) ? projects.data : [];

  // Fallback for Admin or non-voter roles when get_approved_arena_projects returns 0 rows
  if (!approvedList.length && cachedAdminSubmissions.length) {
    approvedList = cachedAdminSubmissions
      .filter((s) => s.status === 'approved')
      .map((s) => ({
        submission_id: s.id,
        group_id: s.group_id,
        team_name: cachedAdminGroupsMap.get(s.group_id) || 'Student Team',
        project_title: s.title,
        project_description: s.description,
        video_url: s.video_url,
        thumbnail_path: s.thumbnail_path || null,
        submitted_at: s.submitted_at,
      }));
  }

  if (!approvedList.length) {
    const [directSubs, directGroups, featuredRpc] = await Promise.all([
      supabase.from('project_submissions').select('*').eq('status', 'approved').order('submitted_at', { ascending: false }),
      supabase.from('project_groups').select('id,name'),
      supabase.rpc('get_homepage_featured_projects'),
    ]);
    const gMap = new Map((directGroups.data || []).map((g) => [g.id, g.name]));
    if (!directSubs.error && directSubs.data?.length) {
      approvedList = directSubs.data.map((s) => ({
        submission_id: s.id,
        group_id: s.group_id,
        team_name: gMap.get(s.group_id) || 'Student Team',
        project_title: s.title,
        project_description: s.description,
        video_url: s.video_url,
        thumbnail_path: s.thumbnail_path || null,
        submitted_at: s.submitted_at,
      }));
    } else if (!featuredRpc.error && featuredRpc.data?.length) {
      approvedList = featuredRpc.data.map((f, idx) => ({
        submission_id: f.submission_id || f.id || 'featured-' + idx,
        group_id: f.group_id || '',
        team_name: f.team_name || 'DUET Student Team',
        project_title: f.project_title || f.title || 'Featured Student Film',
        project_description: f.project_description || f.description || '',
        video_url: f.video_url || '',
        thumbnail_path: f.thumbnail_path || null,
      }));
    }
  }

  cachedVoterProjects = approvedList;
  cachedVoterHasVoted = !votes.error && (votes.data || []).length > 0;

  // Seed initial Rank #1 if user already voted in DB
  if (cachedVoterHasVoted && votes.data?.[0]?.submission_id) {
    const viewer = getCurrentViewerMeta();
    if (!engagementState.ranksByUser[viewer.uid]) {
      engagementState.ranksByUser[viewer.uid] = {
        '1': String(votes.data[0].submission_id),
        userName: viewer.name,
        userEmail: viewer.email,
        updatedAt: new Date().toISOString(),
      };
      persistEngagementState(false);
    }
  }

  renderVoterProjects();

  const voterMsg = document.getElementById('voterMessage');
  if (voterMsg) {
    voterMsg.textContent =
      'Click "★ Vote & Rate" on any film to rate Character Consistency, Voice Over, and Story (1–5 stars) and assign your Top 3 Ranks (#1, #2, #3), or click "💬 Comments" to join the discussion.';
  }
}

document.getElementById('refreshVoter')?.addEventListener('click', async () => {
  try {
    await loadVoterDashboard(activeUser, { keepTeamView: currentArenaRole === 'team' || isArenaAdmin });
    showToast('Project exhibition refreshed.');
  } catch (e) {
    const msg = document.getElementById('voterMessage');
    if (msg) msg.textContent = e.message || 'Could not refresh projects.';
  }
});

document.getElementById('voterProjectList')?.addEventListener('click', async (e) => {
  const card = e.target.closest('[data-vote-submission]');
  if (!card) return;
  const subId = String(card.dataset.voteSubmission || '');

  // 1. Toggle Vote & Rate Drawer
  const voteToggleBtn = e.target.closest('[data-toggle-vote-drawer]');
  if (voteToggleBtn) {
    const drawer = card.querySelector('[data-vote-drawer]');
    if (!drawer) return;
    const willOpen = drawer.hidden;
    drawer.hidden = !willOpen;
    if (willOpen) openVoteDrawers.add(subId);
    else openVoteDrawers.delete(subId);
    return;
  }

  // 2. Toggle Comments Drawer
  const commentToggleBtn = e.target.closest('[data-toggle-comments]');
  if (commentToggleBtn) {
    const drawer = card.querySelector('[data-comments-drawer]');
    if (!drawer) return;
    const willOpen = drawer.hidden;
    drawer.hidden = !willOpen;
    commentToggleBtn.classList.toggle('active', willOpen);
    if (willOpen) {
      openCommentDrawers.add(subId);
      card.querySelector('[data-comment-input]')?.focus();
    } else {
      openCommentDrawers.delete(subId);
    }
    return;
  }

  // 3. Interactive 5-Star Pick for Character Consistency, Voice Over, Story
  const starBtn = e.target.closest('[data-star-cat]');
  if (starBtn) {
    const cat = starBtn.dataset.starCat;
    const val = Number(starBtn.dataset.starVal || 0);
    card.setAttribute('data-star-' + cat, String(val));
    const row = starBtn.closest('[data-cat-row]');
    if (row) {
      row.querySelectorAll('[data-star-val]').forEach((b) => {
        const bVal = Number(b.dataset.starVal || 0);
        const filled = bVal <= val;
        b.classList.toggle('is-filled', filled);
        b.textContent = filled ? '★' : '☆';
      });
      const pill = row.querySelector('[data-cat-score]');
      if (pill) pill.textContent = `${val} / 5`;
    }
    return;
  }

  // 4. Interactive Rank #1, #2, #3 Choice Pick
  const rankBtn = e.target.closest('[data-pick-rank]');
  if (rankBtn) {
    const rk = Number(rankBtn.dataset.pickRank || 0);
    const currentRk = Number(card.dataset.selectedRank || 0);
    const nextRk = currentRk === rk ? 0 : rk;
    card.dataset.selectedRank = String(nextRk);
    card.querySelectorAll('[data-pick-rank]').forEach((b) => {
      const bRk = Number(b.dataset.pickRank || 0);
      b.classList.toggle('is-selected', bRk === nextRk);
    });
    return;
  }

  // 5. Save 3-Category Stars & Confirm Rank Choice
  const submitVoteBtn = e.target.closest('[data-submit-vote-rating]');
  if (submitVoteBtn) {
    if (!activeUser) {
      showToast('Please sign in to rate and vote.');
      return;
    }
    const charStars = Number(card.getAttribute('data-star-character_consistency') || 0);
    const voiceStars = Number(card.getAttribute('data-star-voice_over') || 0);
    const storyStars = Number(card.getAttribute('data-star-story') || 0);
    const chosenRank = Number(card.dataset.selectedRank || 0);

    if (!charStars && !voiceStars && !storyStars && !chosenRank) {
      showToast('Select star ratings (1–5) or choose a Rank (#1, #2, or #3) first.');
      return;
    }

    const viewer = getCurrentViewerMeta();
    if (!engagementState.ratingsBySub[subId]) engagementState.ratingsBySub[subId] = {};
    engagementState.ratingsBySub[subId][viewer.uid] = {
      userId: viewer.uid,
      userName: viewer.name,
      userEmail: viewer.email,
      character_consistency: charStars,
      voice_over: voiceStars,
      story: storyStars,
      rank: chosenRank,
      updatedAt: new Date().toISOString(),
    };

    if (!engagementState.ranksByUser[viewer.uid]) {
      engagementState.ranksByUser[viewer.uid] = {
        userName: viewer.name,
        userEmail: viewer.email,
      };
    }
    const userRanks = engagementState.ranksByUser[viewer.uid];
    // Clear any previous rank slot pointing to this submission
    ['1', '2', '3'].forEach((slot) => {
      if (String(userRanks[slot] || '') === subId) delete userRanks[slot];
    });
    if (chosenRank >= 1 && chosenRank <= 3) {
      userRanks[String(chosenRank)] = subId;
    }
    userRanks.userName = viewer.name;
    userRanks.userEmail = viewer.email;
    userRanks.updatedAt = new Date().toISOString();

    persistEngagementState(true);

    // Also record primary vote in Supabase votes table if not yet recorded
    if (!cachedVoterHasVoted && chosenRank >= 1) {
      try {
        const { error } = await supabase
          .from('votes')
          .insert({ voter_id: activeUser.id, submission_id: subId });
        if (!error) cachedVoterHasVoted = true;
      } catch {
        // Ignore if already voted in DB
      }
    }

    renderVoterProjects();
    if (isArenaAdmin) {
      refreshAdminVoteCounts();
      if (typeof renderAdminVideoAnalytics === 'function') renderAdminVideoAnalytics();
    }
    showToast(
      chosenRank
        ? `Saved your star ratings & Rank #${chosenRank} choice!`
        : 'Saved your 5-star category ratings!'
    );
    return;
  }

  // 6. Post a New Comment on This Video
  const postCommentBtn = e.target.closest('[data-post-comment]');
  if (postCommentBtn) {
    if (!activeUser) {
      showToast('Please sign in to post a comment.');
      return;
    }
    const input = card.querySelector('[data-comment-input]');
    const text = (input?.value || '').trim();
    if (!text) {
      showToast('Write a comment before posting.');
      input?.focus();
      return;
    }
    const viewer = getCurrentViewerMeta();
    if (!engagementState.commentsBySub[subId]) engagementState.commentsBySub[subId] = [];
    engagementState.commentsBySub[subId].push({
      id: 'cmt-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      submissionId: subId,
      userId: viewer.uid,
      userName: viewer.name,
      userEmail: viewer.email,
      userRole: viewer.role,
      text,
      createdAt: new Date().toISOString(),
    });
    persistEngagementState(true);
    openCommentDrawers.add(subId);
    renderVoterProjects();
    if (isArenaAdmin && typeof renderAdminCommentsModeration === 'function') {
      renderAdminCommentsModeration();
      renderAdminVideoAnalytics();
    }
    showToast('Comment posted!');
    return;
  }

  // 7. Delete a Comment (Admin or Comment Author)
  const delCommentBtn = e.target.closest('[data-delete-comment]');
  if (delCommentBtn) {
    const cmtId = delCommentBtn.dataset.deleteComment;
    const listArr = engagementState.commentsBySub[subId] || [];
    const target = listArr.find((c) => String(c.id) === String(cmtId));
    if (target) {
      target.deleted = true;
      persistEngagementState(true);
      renderVoterProjects();
      if (isArenaAdmin && typeof renderAdminCommentsModeration === 'function') {
        renderAdminCommentsModeration();
        renderAdminVideoAnalytics();
      }
      showToast('Comment removed.');
    }
  }
});

document.getElementById('voterProjectList')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('[data-comment-input]')) {
    e.preventDefault();
    e.target.closest('.video-comment-form')?.querySelector('[data-post-comment]')?.click();
  }
});

['headerChooseRole', 'chooseRoleBtn', 'ctaChooseRole'].forEach((id) =>
  document.getElementById(id)?.addEventListener('click', () =>
    roleChooser?.scrollIntoView({ behavior: 'smooth' })
  )
);

document.getElementById('refreshDashboard')?.addEventListener('click', async () => {
  try {
    await loadDashboard(activeUser);
    showToast('Workspace refreshed.');
  } catch (e) {
    dashMessage('groupMessage', e.message, true);
  }
});

document.getElementById('createGroupForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!activeUser) {
    dashMessage('groupMessage', 'Please sign in first.', true);
    return;
  }
  const form = e.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  button.textContent = 'Registering team…';
  let createdGroup = null;
  try {
    const fd = new FormData(form);
    const groupName = String(fd.get('groupName') || '').trim();
    const names = [...form.querySelectorAll('input[name="memberName"]')].map((x) => x.value.trim());
    const rolls = [...form.querySelectorAll('input[name="rollNumber"]')].map((x) => x.value.trim());

    if (!groupName || names.some((x) => !x) || rolls.some((x) => !x)) {
      throw new Error('Complete the team name and every member name and roll number.');
    }
    if (new Set(rolls.map((x) => x.toLowerCase())).size !== rolls.length) {
      throw new Error('Each team member must have a unique roll number.');
    }

    const inserted = await supabase
      .from('project_groups')
      .insert({ name: groupName, created_by: activeUser.id })
      .select('id')
      .single();
    if (inserted.error) throw inserted.error;
    createdGroup = inserted.data;

    const memberRows = names.map((name, i) => ({
      group_id: createdGroup.id,
      member_name: name,
      roll_number: rolls[i],
      user_id: i === 0 ? activeUser.id : null,
    }));
    const added = await supabase.from('group_members').insert(memberRows);
    if (added.error) {
      await supabase.from('project_groups').delete().eq('id', createdGroup.id);
      createdGroup = null;
      throw added.error;
    }

    form.reset();
    const rowsEl = document.getElementById('memberRows');
    if (rowsEl) {
      rowsEl.innerHTML =
        '<div class="member-row"><input name="memberName" required maxlength="100" placeholder="Team lead full name"><input name="rollNumber" required maxlength="40" placeholder="Roll no. (e.g. 26F-CS-044)"><button class="member-remove" type="button" hidden>Remove</button></div>';
    }
    dashMessage('groupMessage', 'Team roster registered! Now add your project details on the right.');
    showToast('Team registered successfully.');
    await loadDashboard(activeUser);
  } catch (err) {
    dashMessage('groupMessage', err.message || 'Could not create team.', true);
  } finally {
    button.disabled = false;
    button.textContent = 'Register Team Roster';
  }
});

document.getElementById('groupList')?.addEventListener('click', async (e) => {
  const w = e.target.closest('[data-group-members]');
  if (!w) return;
  const b = e.target.closest('[data-save-member],[data-delete-member],[data-add-member]');
  if (!b) return;
  const row = e.target.closest('[data-member-id]');
  const msg = w.querySelector('.dash-message');
  b.disabled = true;
  try {
    if (b.hasAttribute('data-save-member')) {
      const n = row.querySelector('.member-edit-name').value.trim();
      const r = row.querySelector('.member-edit-roll').value.trim();
      if (!n || !r) throw Error('Enter both member name and roll number.');
      const x = await supabase
        .from('group_members')
        .update({ member_name: n, roll_number: r })
        .eq('id', row.dataset.memberId);
      if (x.error) throw x.error;
    } else if (b.hasAttribute('data-delete-member')) {
      if (!confirm('Remove this member from the roster?')) return;
      const x = await supabase.from('group_members').delete().eq('id', row.dataset.memberId);
      if (x.error) throw x.error;
    } else {
      const i = w.querySelectorAll('.member-edit-add input');
      const n = i[0].value.trim();
      const r = i[1].value.trim();
      if (!n || !r) throw Error('Enter member name and roll number.');
      const x = await supabase
        .from('group_members')
        .insert({ group_id: w.dataset.groupMembers, member_name: n, roll_number: r });
      if (x.error) throw x.error;
    }
    if (msg) msg.textContent = 'Roster updated.';
    await loadDashboard(activeUser);
  } catch (err) {
    if (msg) {
      msg.textContent = err.message;
      msg.style.color = 'var(--danger)';
    }
  } finally {
    b.disabled = false;
  }
});

document.getElementById('groupList')?.addEventListener('submit', async (e) => {
  const form = e.target.closest('.submission-form');
  if (!form) return;
  e.preventDefault();
  const button = form.querySelector('button[type="submit"]');
  const messageEl = form.querySelector('.dash-message');
  button.disabled = true;
  button.textContent = 'Saving…';
  if (messageEl) {
    messageEl.textContent = '';
    messageEl.style.color = '';
  }

  try {
    const isOpen = submissionWindowOpen();
    const fd = new FormData(form);
    const groupId = form.dataset.group;
    const submissionId = form.dataset.submission;
    const title = String(fd.get('title') || '').trim();
    const description = String(fd.get('description') || '').trim();
    const videoUrl = String(fd.get('videoUrl') || '').trim();
    const thumbnailFile = fd.get('thumbnailFile');

    if (!title || !description) throw new Error('Enter a project title and technical description.');
    if (!videoUrl) throw new Error('Paste your YouTube demonstration link.');
    if (!getYoutubeEmbedUrl(videoUrl)) {
      throw new Error('Enter a valid YouTube link (watch, youtu.be, or Shorts).');
    }

    const isRlsError = (err) =>
      err &&
      (err.code === '42501' ||
        err.statusCode === '403' ||
        /row-level security|violates row-level/i.test(String(err.message || '')));

    let thumbnailPath = form.dataset.currentThumbnail || null;
    if (thumbnailFile && thumbnailFile.size > 0) {
      const allowedTypes = ['image/jpeg', 'image/png'];
      const extension = thumbnailFile.name.split('.').pop().toLowerCase();
      if (!allowedTypes.includes(thumbnailFile.type) || !['jpg', 'jpeg', 'png'].includes(extension)) {
        throw new Error('Thumbnail must be a JPG or PNG image.');
      }
      if (thumbnailFile.size > 5 * 1024 * 1024) throw new Error('Thumbnail must be 5 MB or smaller.');
      const ext = extension === 'jpeg' ? 'jpg' : extension;
      const filePath = `${groupId}/${activeUser.id}/${crypto.randomUUID()}.${ext}`;
      let upload = await supabase.storage
        .from('project-thumbnails')
        .upload(filePath, thumbnailFile, { contentType: thumbnailFile.type, upsert: true });

      if (upload.error && isRlsError(upload.error)) {
        // Retry with user_id as first folder segment in case Storage RLS checks foldername(name)[1] = auth.uid()
        const altPath = `${activeUser.id}/${groupId}/${crypto.randomUUID()}.${ext}`;
        const retryUpload = await supabase.storage
          .from('project-thumbnails')
          .upload(altPath, thumbnailFile, { contentType: thumbnailFile.type, upsert: true });
        if (!retryUpload.error) {
          upload = retryUpload;
        }
      }

      if (upload.error) {
        if (isRlsError(upload.error)) {
          // Preserve thumbnail as a Data URL so Storage RLS never blocks draft/submission saving
          thumbnailPath = await fileToDataUrl(thumbnailFile);
        } else {
          throw upload.error;
        }
      } else {
        thumbnailPath = upload.data.path;
      }
    }

    const payload = {
      title,
      description,
      video_url: videoUrl,
      video_path: null,
      thumbnail_path: thumbnailPath,
      status:
        submissionId && form.dataset.currentStatus === 'approved'
          ? 'pending'
          : isOpen
          ? 'pending'
          : 'draft',
      updated_at: new Date().toISOString(),
    };

    const runDbSave = async (rowPayload) => {
      if (submissionId) {
        return supabase.from('project_submissions').update(rowPayload).eq('id', submissionId);
      }
      return supabase.from('project_submissions').insert({ ...rowPayload, group_id: groupId });
    };

    let saved = await runDbSave(payload);

    // If database RLS rejects 'draft' status, try 'pending' in case the DB window is open
    if (saved.error && isRlsError(saved.error) && payload.status === 'draft') {
      const retryPending = await runDbSave({ ...payload, status: 'pending' });
      if (!retryPending.error) {
        saved = retryPending;
      }
    }

    // If thumbnail_path is a Data URL and DB column has a length constraint or RLS check, retry with null thumbnail_path in DB while keeping thumbnail in localDraft
    if (saved.error && thumbnailPath && thumbnailPath.startsWith('data:image/')) {
      const retryNoThumb = await runDbSave({
        ...payload,
        thumbnail_path: form.dataset.currentThumbnail || null,
      });
      if (!retryNoThumb.error) {
        saved = retryNoThumb;
      }
    }

    if (saved.error) {
      if (isRlsError(saved.error)) {
        saveLocalDraft(groupId, {
          title,
          description,
          video_url: videoUrl,
          thumbnail_path: thumbnailPath,
          status: 'draft',
        });

        if (!isOpen) {
          showToast('Private draft saved!');
          await loadDashboard(activeUser);
          return;
        }

        throw new Error(
          'Database RLS blocked saving because the submission window is closed in Supabase or draft/storage policy needs updating. Your draft and thumbnail have been saved locally on this device.'
        );
      }
      throw saved.error;
    }

    clearLocalDraft(groupId);

    if (messageEl) {
      messageEl.style.color = 'var(--success)';
      messageEl.textContent = isOpen
        ? 'Submission sent to the faculty review queue.'
        : 'Private draft saved.';
    }
    showToast(isOpen ? 'Project submitted for review!' : 'Draft saved.');
    await loadDashboard(activeUser);
  } catch (err) {
    if (messageEl) {
      messageEl.textContent = err.message || 'Could not save submission.';
      messageEl.style.color = 'var(--danger)';
    }
  } finally {
    button.disabled = false;
    const draftMode = !submissionWindowOpen();
    button.textContent = draftMode
      ? 'Save Private Draft'
      : form.dataset.submission
      ? 'Update Submission'
      : 'Submit for Faculty Review';
  }
});

/* ==========================================================================
   ADMINISTRATION CONTROL ROOM
   ========================================================================== */

function localDate(v) {
  if (!v) return '';
  const d = new Date(v);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

function isoDate(v) {
  return v ? new Date(v).toISOString() : null;
}

// Admin Section Tabs
document.querySelectorAll('[data-admin-section]').forEach((tabBtn) => {
  tabBtn.addEventListener('click', () => {
    const target = tabBtn.dataset.adminSection;
    document.querySelectorAll('[data-admin-section]').forEach((b) => {
      b.classList.toggle('active', b === tabBtn);
    });
    document.querySelectorAll('#adminDashboard [data-panel-group]').forEach((panel) => {
      if (panel.id === 'superAdminPanel' && panel.hidden) return;
      panel.style.display = target === 'all' || panel.dataset.panelGroup === target ? '' : 'none';
    });
  });
});

async function refreshAdminVoteCounts() {
  if (!isArenaAdmin) return;
  const box = document.getElementById('adminResults');
  if (!box) return;
  try {
    const { data, error } = await supabase.rpc('get_arena_results');
    if (error) throw error;
    cachedAdminResults = data || [];
    if (!cachedAdminResults.length) {
      box.innerHTML = '<div class="dashboard-empty">No approved projects or votes recorded yet.</div>';
      return;
    }
    const subByTitle = new Map(
      cachedAdminSubmissions.map((s) => [String(s.title || '').trim().toLowerCase(), String(s.id)])
    );
    const maxVotes = Math.max(1, ...cachedAdminResults.map((r) => Number(r.vote_count || 0)));
    box.innerHTML = cachedAdminResults
      .map((x, idx) => {
        const count = Number(x.vote_count || 0);
        const pct = Math.round((count / maxVotes) * 100);
        const rankClass = idx === 0 ? 'rank-1' : idx === 1 ? 'rank-2' : idx === 2 ? 'rank-3' : '';
        const matchSubId =
          x.submission_id ||
          subByTitle.get(String(x.project_title || '').trim().toLowerCase()) ||
          '';
        const eStats = matchSubId ? getProjectEngagementStats(matchSubId) : null;
        const metaExtra = eStats
          ? ` · ★ ${eStats.overallAvg.toFixed(1)}/5 · 🥇${eStats.rank1} 🥈${eStats.rank2} 🥉${eStats.rank3}`
          : '';
        return (
          '<div class="admin-result">' +
          '<span class="rank-badge ' +
          rankClass +
          '">#' +
          (idx + 1) +
          '</span>' +
          '<div>' +
          '<div><strong>' +
          escapeHtml(x.project_title) +
          '</strong> · <span style="color:var(--muted)">' +
          escapeHtml(x.group_name) +
          escapeHtml(metaExtra) +
          '</span></div>' +
          '<div class="result-bar-wrap"><div class="result-bar-fill" style="width:' +
          pct +
          '%"></div></div>' +
          '</div>' +
          '<strong style="font-family:var(--mono);font-size:15px">' +
          count +
          ' vote' +
          (count === 1 ? '' : 's') +
          '</strong>' +
          '</div>'
        );
      })
      .join('');
  } catch (e) {
    box.textContent = 'Could not load vote totals: ' + (e.message || 'Access denied');
    console.warn('Aggregate vote totals unavailable', e);
  }
}

function startAdminVotingClock() {
  if (adminClockInterval) clearInterval(adminClockInterval);
  const tick = () => {
    const timer = document.getElementById('adminVotingCountdown');
    const state = document.getElementById('adminVotingState');
    if (!timer || !state) return;
    if (!adminVotingActive || !adminVotingDeadlineMs) {
      timer.textContent = 'Voting is stopped';
      state.textContent = 'Set a future voting deadline above, then click Start Voting Window.';
      return;
    }
    const remaining = adminVotingDeadlineMs - Date.now();
    if (remaining <= 0) {
      adminVotingActive = false;
      timer.textContent = '00:00:00';
      state.textContent = 'Voting deadline reached. New votes are automatically blocked.';
      const openCheck = document.getElementById('adminVotingOpen');
      if (openCheck) openCheck.checked = false;
      supabase
        .from('competition_settings')
        .update({ voting_open: false, updated_at: new Date().toISOString() })
        .eq('id', true)
        .then(({ error }) => {
          if (error) console.error(error);
          refreshAdminVoteCounts();
        });
      return;
    }
    const total = Math.floor(remaining / 1000);
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    timer.textContent =
      (days ? days + 'd ' : '') +
      [hours, minutes, seconds].map((n) => String(n).padStart(2, '0')).join(':');
    state.textContent = 'Voting is live · closes ' + new Date(adminVotingDeadlineMs).toLocaleString();
  };
  tick();
  adminClockInterval = setInterval(tick, 1000);
}

async function setAdminVotingState(open) {
  const btn = document.getElementById(open ? 'startVotingNow' : 'stopVotingNow');
  if (!btn) return;
  btn.disabled = true;
  try {
    let deadline = null;
    if (open) {
      const value = document.getElementById('adminVotingDeadline').value;
      if (!value) throw new Error('Choose a voting deadline first.');
      deadline = new Date(value).getTime();
      if (!Number.isFinite(deadline) || deadline <= Date.now()) {
        throw new Error('The voting deadline must be in the future.');
      }
    }
    const payload = { voting_open: open, updated_at: new Date().toISOString() };
    if (open) payload.voting_deadline = new Date(deadline).toISOString();
    const { data, error } = await supabase
      .from('competition_settings')
      .update(payload)
      .eq('id', true)
      .select('voting_open,voting_deadline')
      .single();
    if (error) throw error;
    if (!data || data.voting_open !== open) {
      throw new Error('The database did not confirm the voting status change.');
    }
    adminVotingDeadlineMs = data.voting_deadline ? new Date(data.voting_deadline).getTime() : null;
    adminVotingActive = !!data.voting_open;
    document.getElementById('adminVotingOpen').checked = adminVotingActive;
    adminMsg(
      'adminSettingsMessage',
      open
        ? 'Voting window started! Students can now cast votes until the deadline.'
        : 'Voting stopped. New votes are blocked.'
    );
    await loadAdminDashboard();
  } catch (e) {
    adminMsg('adminSettingsMessage', e.message || 'Could not change voting status.', true);
  } finally {
    btn.disabled = false;
  }
}

document.getElementById('startVotingNow')?.addEventListener('click', () => setAdminVotingState(true));
document.getElementById('stopVotingNow')?.addEventListener('click', () => setAdminVotingState(false));

async function checkArenaAdmin() {
  const { data, error } = await supabase.rpc('is_arena_admin');
  if (error) throw error;
  isArenaAdmin = Boolean(data);
  adminDashboard?.classList.toggle('visible', isArenaAdmin);
  if (isArenaAdmin) await loadAdminDashboard();
}

function renderAdminQueue() {
  const list = document.getElementById('adminSubmissionList');
  if (!list) return;

  const query = (document.getElementById('adminQueueSearch')?.value || '').trim().toLowerCase();
  const statusFilter = document.getElementById('adminQueueStatusFilter')?.value || 'pending';
  const dismissedIds = getDismissedRejectedIds();

  const reviewQueue = cachedAdminSubmissions.filter((x) => {
    if (x.status === 'rejected') return false;
    if (statusFilter === 'pending' && x.status !== 'pending') return false;
    if (statusFilter === 'approved' && x.status !== 'approved') return false;
    if (statusFilter === 'draft' && x.status !== 'draft') return false;
    if (dismissedIds.has(String(x.id))) return false;
    if (!query) return true;
    const teamName = cachedAdminGroupsMap.get(x.group_id) || '';
    const members = cachedAdminMembersByGroup.get(x.group_id) || [];
    const memberText = members.map((m) => `${m.member_name} ${m.roll_number}`).join(' ');
    const hay = `${x.title || ''} ${x.description || ''} ${teamName} ${memberText}`.toLowerCase();
    return hay.includes(query);
  });

  if (!reviewQueue.length) {
    list.innerHTML =
      statusFilter === 'pending'
        ? '<div class="dashboard-empty">No pending projects waiting for review. Approved videos are shown in the Approved Exhibition Gallery below, or switch the filter above to "Approved videos" or "All submissions".</div>'
        : '<div class="dashboard-empty">No submissions match the current queue filter.</div>';
    return;
  }

  list.innerHTML = reviewQueue
    .map((x) => {
      const members = cachedAdminMembersByGroup.get(x.group_id) || [];
      return (
        '<article class="admin-submission" data-submission-id="' +
        escapeHtml(x.id) +
        '" data-group-id="' +
        escapeHtml(x.group_id) +
        '">' +
        '<div class="group-title">' +
        '<div>' +
        '<h4>' +
        escapeHtml(x.title) +
        '</h4>' +
        '<span class="dash-help">' +
        escapeHtml(cachedAdminGroupsMap.get(x.group_id) || 'Team') +
        ' · Submitted ' +
        escapeHtml(new Date(x.submitted_at).toLocaleString()) +
        '</span>' +
        '</div>' +
        '<span class="dash-status ' +
        escapeHtml(x.status) +
        '">' +
        escapeHtml(x.status) +
        '</span>' +
        '</div>' +
        '<p>' +
        escapeHtml(x.description) +
        '</p>' +
        '<div class="admin-member-list"><strong>Team Roster (' +
        members.length +
        ')</strong>' +
        (members
          .map(
            (m) =>
              '<div>' +
              escapeHtml(m.member_name) +
              ' · <span style="font-family:var(--mono)">' +
              escapeHtml(m.roll_number) +
              '</span></div>'
          )
          .join('') || '<span>No members listed</span>') +
        '</div>' +
        buildYoutubePlayerHtml(x.video_url, x.thumbnail_path, x.title, 'admin-video', x.id) +
        '<label class="dash-field">Reviewer Feedback (shared with team)' +
        '<textarea class="admin-feedback" maxlength="2000" placeholder="Optional feedback or required revisions">' +
        escapeHtml(x.admin_feedback || '') +
        '</textarea></label>' +
        '<div class="feedback-presets">' +
        '<button type="button" class="preset-chip" data-preset="Approved for public exhibition. Well-documented demonstration!">✓ Great demo</button>' +
        '<button type="button" class="preset-chip" data-preset="Video is private or unavailable. Please set YouTube visibility to Unlisted or Public and resubmit.">⚠ Video unavailable</button>' +
        '<button type="button" class="preset-chip" data-preset="Please expand the technical abstract to explain your architecture, dataset, and student contributions.">✎ Expand abstract</button>' +
        '<button type="button" class="preset-chip" data-preset="Please verify that all team members have complete university roll numbers.">🆔 Check roll numbers</button>' +
        '</div>' +
        '<div class="admin-actions">' +
        '<button class="btn primary" data-review="approved" type="button">✓ Approve for Gallery</button>' +
        '<button class="btn danger" data-review="rejected" type="button">✕ Reject to Gallery</button>' +
        '<button class="btn" data-review="pending" type="button">Set Pending</button>' +
        '<button class="btn danger" data-delete-submission type="button" style="margin-left:auto">🗑 Delete Video</button>' +
        '</div>' +
        '<div class="admin-message" role="status"></div>' +
        '</article>'
      );
    })
    .join('');
}

function renderRejectedGallery() {
  const rejectedContainer = document.getElementById('adminRejectedGallery');
  const deleteAllBtn = document.getElementById('deleteAllRejectedBtn');
  const rejectedTabBtn = document.getElementById('rejectedGalleryTabBtn');
  const dismissedIds = getDismissedRejectedIds();

  const rejectedList = cachedAdminSubmissions.filter(
    (x) => x.status === 'rejected' && !dismissedIds.has(String(x.id))
  );

  if (rejectedTabBtn) {
    rejectedTabBtn.textContent = rejectedList.length
      ? `Rejected Videos Gallery (${rejectedList.length})`
      : 'Rejected Videos Gallery';
  }

  if (deleteAllBtn) {
    deleteAllBtn.disabled = rejectedList.length === 0;
  }

  if (!rejectedContainer) return;

  if (!rejectedList.length) {
    rejectedContainer.innerHTML =
      '<div class="dashboard-empty">No rejected videos in the gallery. When you reject a submission, its video stays here until you delete or restore it.</div>';
    return;
  }

  rejectedContainer.innerHTML = rejectedList
    .map((x) => {
      const teamName = cachedAdminGroupsMap.get(x.group_id) || 'Student Team';
      return (
        '<article class="rejected-video-card" data-submission-id="' +
        escapeHtml(x.id) +
        '">' +
        '<div class="rejected-card-top">' +
        '<div>' +
        '<h4>' +
        escapeHtml(x.title) +
        '</h4>' +
        '<span class="dash-help">' +
        escapeHtml(teamName) +
        ' · ' +
        escapeHtml(new Date(x.submitted_at).toLocaleDateString()) +
        '</span>' +
        '</div>' +
        '<span class="dash-status rejected">Rejected</span>' +
        '</div>' +
        buildYoutubePlayerHtml(x.video_url, x.thumbnail_path, x.title, 'admin-video rejected-video-frame', x.id) +
        '<p class="rejected-desc">' +
        escapeHtml(x.description) +
        '</p>' +
        (x.admin_feedback
          ? '<div class="rejected-feedback-note"><strong>Rejection Note:</strong> ' +
            escapeHtml(x.admin_feedback) +
            '</div>'
          : '') +
        '<div class="rejected-card-actions">' +
        '<button class="btn sm" data-review="pending" type="button">↩ Restore to Pending</button>' +
        '<button class="btn sm danger" data-delete-submission type="button">🗑 Delete Video</button>' +
        '</div>' +
        '<div class="admin-message" role="status"></div>' +
        '</article>'
      );
    })
    .join('');
}

function renderAdminVideoAnalytics() {
  const container = document.getElementById('adminVideoAnalytics');
  if (!container) return;

  const allVideos = cachedAdminSubmissions.length
    ? cachedAdminSubmissions.filter((x) => x.status !== 'rejected')
    : cachedVoterProjects.map((p) => ({
        id: p.submission_id,
        group_id: p.group_id,
        title: p.project_title,
        description: p.project_description,
        video_url: p.video_url,
        thumbnail_path: p.thumbnail_path,
        status: 'approved',
      }));

  if (!allVideos.length) {
    container.innerHTML = '<div class="dashboard-empty">No videos available for analytics yet.</div>';
    return;
  }

  let totalPlaysAll = 0;
  let totalWatchSecAll = 0;
  let totalWatchUsersAll = 0;
  let totalAttentionSumAll = 0;
  let totalCommentsAll = 0;

  const cardsHtml = allVideos
    .map((v) => {
      const subId = String(v.id);
      const teamName = cachedAdminGroupsMap.get(v.group_id) || 'Student Team';
      const stats = getProjectEngagementStats(subId);
      totalCommentsAll += stats.comments.length;

      // Combine watch entries + rating/rank entries so every engaged user appears in the per-user table
      const userMap = new Map();
      stats.watchEntries.forEach((w) => {
        totalPlaysAll += Number(w.playCount || 1);
        totalWatchSecAll += Number(w.watchedSeconds || 0);
        totalWatchUsersAll += 1;
        totalAttentionSumAll += Number(w.attentionPct || 0);
        userMap.set(w.userId || w.userEmail, {
          userId: w.userId,
          userName: w.userName || 'Viewer',
          userEmail: w.userEmail || '—',
          watchedSeconds: Number(w.watchedSeconds || 0),
          attentionPct: Number(w.attentionPct || 0),
          playCount: Number(w.playCount || 1),
          lastActive: w.lastWatchedAt,
        });
      });

      const ratingsMap = engagementState.ratingsBySub[subId] || {};
      Object.entries(ratingsMap).forEach(([uid, r]) => {
        const existing = userMap.get(uid) || {
          userId: uid,
          userName: r.userName || 'Voter',
          userEmail: r.userEmail || '—',
          watchedSeconds: 0,
          attentionPct: 0,
          playCount: 0,
          lastActive: r.updatedAt,
        };
        existing.rating = r;
        if (!existing.lastActive || new Date(r.updatedAt || 0) > new Date(existing.lastActive || 0)) {
          existing.lastActive = r.updatedAt;
        }
        userMap.set(uid, existing);
      });

      Object.entries(engagementState.ranksByUser || {}).forEach(([uid, rkObj]) => {
        const userRankForSub =
          String(rkObj?.['1'] || '') === subId
            ? 1
            : String(rkObj?.['2'] || '') === subId
            ? 2
            : String(rkObj?.['3'] || '') === subId
            ? 3
            : 0;
        if (userRankForSub) {
          const existing = userMap.get(uid) || {
            userId: uid,
            userName: rkObj.userName || 'Voter',
            userEmail: rkObj.userEmail || '—',
            watchedSeconds: 0,
            attentionPct: 0,
            playCount: 0,
            lastActive: rkObj.updatedAt,
          };
          existing.rankChoice = userRankForSub;
          userMap.set(uid, existing);
        }
      });

      const userRows = [...userMap.values()];

      const userTableHtml = userRows.length
        ? '<table class="analytics-user-table">' +
          '<thead><tr>' +
          '<th>User (Viewer / Voter)</th>' +
          '<th>Time Watched (Minutes)</th>' +
          '<th>Audience Attention</th>' +
          '<th>Category Stars (Char / Voice / Story)</th>' +
          '<th>Rank Vote</th>' +
          '<th>Last Active</th>' +
          '</tr></thead><tbody>' +
          userRows
            .map((u) => {
              const r = u.rating || {};
              const rk = u.rankChoice || r.rank || 0;
              return (
                '<tr>' +
                '<td><strong>' +
                escapeHtml(u.userName) +
                '</strong><div class="dash-help" style="font-size:11px">' +
                escapeHtml(u.userEmail) +
                '</div></td>' +
                '<td><strong style="font-family:var(--mono)">' +
                escapeHtml(formatWatchMinutes(u.watchedSeconds)) +
                '</strong></td>' +
                '<td>' +
                '<div class="attention-cell">' +
                '<span style="font-family:var(--mono);font-weight:700">' +
                Number(u.attentionPct || 0) +
                '%</span>' +
                '<div class="attention-mini-bar"><div class="attention-mini-fill" style="width:' +
                Math.min(100, Number(u.attentionPct || 0)) +
                '%"></div></div>' +
                '</div>' +
                '</td>' +
                '<td style="font-family:var(--mono);font-size:12px">' +
                (r.character_consistency || r.voice_over || r.story
                  ? `★${r.character_consistency || 0} / ★${r.voice_over || 0} / ★${r.story || 0}`
                  : '—') +
                '</td>' +
                '<td>' +
                (rk === 1
                  ? '<span class="my-rank-pill">🥇 Rank #1</span>'
                  : rk === 2
                  ? '<span class="my-rank-pill">🥈 Rank #2</span>'
                  : rk === 3
                  ? '<span class="my-rank-pill">🥉 Rank #3</span>'
                  : '—') +
                '</td>' +
                '<td style="font-size:12px;color:var(--muted)">' +
                (u.lastActive ? escapeHtml(new Date(u.lastActive).toLocaleString()) : '—') +
                '</td>' +
                '</tr>'
              );
            })
            .join('') +
          '</tbody></table>'
        : '<div class="comments-empty">No user watch sessions or ratings recorded for this video yet. Play the video to begin tracking real-time watch minutes and attention.</div>';

      return (
        '<article class="analytics-video-card">' +
        '<div class="analytics-video-head">' +
        '<div>' +
        '<div class="eyebrow">' +
        escapeHtml(teamName) +
        '</div>' +
        '<h4>' +
        escapeHtml(v.title) +
        '</h4>' +
        '</div>' +
        '<div class="analytics-head-badges">' +
        '<span class="card-avg-star-badge">★ ' +
        (stats.overallAvg > 0 ? stats.overallAvg.toFixed(1) + ' / 5.0' : 'No ratings') +
        '</span>' +
        '<span class="dash-status ' +
        escapeHtml(v.status || 'approved') +
        '">' +
        escapeHtml(v.status || 'approved') +
        '</span>' +
        '</div>' +
        '</div>' +
        '<div class="analytics-kpi-grid">' +
        '<div class="analytics-kpi-box">' +
        '<span>Average Audience Attention</span>' +
        '<strong>' +
        stats.avgAttentionPct +
        '%</strong>' +
        '<div class="attention-mini-bar" style="margin-top:6px"><div class="attention-mini-fill" style="width:' +
        stats.avgAttentionPct +
        '%"></div></div>' +
        '<small>' +
        stats.totalViewers +
        ' viewer' +
        (stats.totalViewers === 1 ? '' : 's') +
        ' tracked</small>' +
        '</div>' +
        '<div class="analytics-kpi-box">' +
        '<span>Average Watch Time (Per User)</span>' +
        '<strong>' +
        escapeHtml(formatWatchMinutes(stats.avgWatchSeconds)) +
        '</strong>' +
        '<small>Total across users: ' +
        escapeHtml(
          formatWatchMinutes(
            stats.watchEntries.reduce((s, w) => s + Number(w.watchedSeconds || 0), 0)
          )
        ) +
        '</small>' +
        '</div>' +
        '<div class="analytics-kpi-box">' +
        '<span>5-Star Category Averages</span>' +
        '<div class="analytics-star-breakdown">' +
        '<div>Character Consistency: <strong>★ ' +
        stats.avgChar.toFixed(1) +
        '/5</strong></div>' +
        '<div>Voice Over: <strong>★ ' +
        stats.avgVoice.toFixed(1) +
        '/5</strong></div>' +
        '<div>Story: <strong>★ ' +
        stats.avgStory.toFixed(1) +
        '/5</strong></div>' +
        '</div>' +
        '</div>' +
        '<div class="analytics-kpi-box">' +
        '<span>Ranked Vote Choices (1 / 2 / 3)</span>' +
        '<div class="analytics-star-breakdown">' +
        '<div>🥇 Rank #1: <strong>' +
        stats.rank1 +
        '</strong> · 🥈 Rank #2: <strong>' +
        stats.rank2 +
        '</strong></div>' +
        '<div>🥉 Rank #3: <strong>' +
        stats.rank3 +
        '</strong> · Comments: <strong>' +
        stats.comments.length +
        '</strong></div>' +
        '<div>Weighted Rank Score: <strong>' +
        stats.weightedRankPoints +
        ' pts</strong></div>' +
        '</div>' +
        '</div>' +
        '</div>' +
        '<div class="analytics-user-section">' +
        '<strong>Per-User Watch Time & Audience Attention Breakdown (' +
        userRows.length +
        ' user' +
        (userRows.length === 1 ? '' : 's') +
        ')</strong>' +
        userTableHtml +
        '</div>' +
        '</article>'
      );
    })
    .join('');

  const globalAvgWatchSec = totalWatchUsersAll ? totalWatchSecAll / totalWatchUsersAll : 0;
  const globalAvgAttention = totalWatchUsersAll
    ? Math.round(totalAttentionSumAll / totalWatchUsersAll)
    : 0;

  container.innerHTML =
    '<div class="admin-grid" style="margin-bottom:18px">' +
    '<div class="admin-stat"><span>Total Video Sessions</span><strong>' +
    totalPlaysAll +
    '</strong></div>' +
    '<div class="admin-stat"><span>Avg Audience Attention</span><strong>' +
    globalAvgAttention +
    '%</strong></div>' +
    '<div class="admin-stat"><span>Avg Watch Time / User</span><strong style="font-size:20px">' +
    escapeHtml(formatWatchMinutes(globalAvgWatchSec)) +
    '</strong></div>' +
    '<div class="admin-stat"><span>Total Comments</span><strong>' +
    totalCommentsAll +
    '</strong></div>' +
    '</div>' +
    cardsHtml;
}

function renderAdminCommentsModeration() {
  const container = document.getElementById('adminCommentsModerationList');
  if (!container) return;

  const titleById = new Map();
  cachedAdminSubmissions.forEach((s) => titleById.set(String(s.id), s.title));
  cachedVoterProjects.forEach((p) => titleById.set(String(p.submission_id), p.project_title));

  const allComments = [];
  Object.entries(engagementState.commentsBySub || {}).forEach(([subId, arr]) => {
    (arr || []).forEach((c) => {
      if (!c.deleted) {
        allComments.push({
          ...c,
          submissionId: subId,
          projectTitle: titleById.get(String(subId)) || 'Project Video',
        });
      }
    });
  });

  allComments.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

  if (!allComments.length) {
    container.innerHTML = '<div class="dashboard-empty">No comments posted across any videos yet.</div>';
    return;
  }

  container.innerHTML = allComments
    .map(
      (c) =>
        '<div class="video-comment-item admin-mod-comment" data-mod-sub="' +
        escapeHtml(c.submissionId) +
        '" data-mod-cmt="' +
        escapeHtml(c.id) +
        '">' +
        '<div class="video-comment-top">' +
        '<div>' +
        '<strong>' +
        escapeHtml(c.userName || 'Student') +
        '</strong> <span class="comment-role-pill">' +
        escapeHtml(c.userRole || 'Voter') +
        '</span> · <span style="color:var(--primary);font-weight:700">' +
        escapeHtml(c.projectTitle) +
        '</span>' +
        '</div>' +
        '<div class="video-comment-meta">' +
        '<span>' +
        escapeHtml(new Date(c.createdAt).toLocaleString()) +
        '</span>' +
        '<button type="button" class="btn sm danger" data-admin-del-comment="' +
        escapeHtml(c.id) +
        '" data-admin-del-sub="' +
        escapeHtml(c.submissionId) +
        '">🗑 Delete Comment</button>' +
        '</div>' +
        '</div>' +
        '<p class="video-comment-body">' +
        escapeHtml(c.text) +
        '</p>' +
        '</div>'
    )
    .join('');
}

document.getElementById('adminCommentsModerationList')?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-admin-del-comment]');
  if (!btn || !isArenaAdmin) return;
  const cmtId = btn.dataset.adminDelComment;
  const subId = btn.dataset.adminDelSub;
  const arr = engagementState.commentsBySub[String(subId)] || [];
  const target = arr.find((c) => String(c.id) === String(cmtId));
  if (target) {
    target.deleted = true;
    persistEngagementState(true);
    renderAdminCommentsModeration();
    renderAdminVideoAnalytics();
    renderVoterProjects();
    showToast('Comment deleted by administrator.');
  }
});

function updateAdminKpiCounters() {
  const dismissedIds = getDismissedRejectedIds();
  const activeSubs = cachedAdminSubmissions.filter((x) => !dismissedIds.has(String(x.id)));
  const totalEl = document.getElementById('adminTotal');
  const pendingEl = document.getElementById('adminPending');
  const approvedEl = document.getElementById('adminApproved');
  const rejectedEl = document.getElementById('adminRejected');

  if (totalEl) totalEl.textContent = activeSubs.length;
  if (pendingEl) pendingEl.textContent = activeSubs.filter((x) => x.status === 'pending').length;
  if (approvedEl) approvedEl.textContent = activeSubs.filter((x) => x.status === 'approved').length;
  if (rejectedEl) rejectedEl.textContent = activeSubs.filter((x) => x.status === 'rejected').length;
}

document.getElementById('adminQueueSearch')?.addEventListener('input', renderAdminQueue);
document.getElementById('adminQueueStatusFilter')?.addEventListener('change', renderAdminQueue);

async function loadAdminDashboard() {
  if (!isArenaAdmin) return;
  await syncEngagementFromCloud();

  const [a, b, g, m] = await Promise.all([
    supabase.from('competition_settings').select('*').eq('id', true).single(),
    supabase
      .from('project_submissions')
      .select('*')
      .order('submitted_at', { ascending: false }),
    supabase.from('project_groups').select('id,name'),
    supabase.from('group_members').select('group_id,member_name,roll_number').order('created_at'),
  ]);
  if (a.error) throw a.error;
  if (b.error) throw b.error;
  if (g.error) throw g.error;
  if (m.error) throw m.error;

  const s = a.data;
  const dismissedIds = getDismissedRejectedIds();
  cachedAdminSubmissions = (b.data || []).filter((x) => !dismissedIds.has(String(x.id)));
  cachedAdminGroupsMap = new Map((g.data || []).map((x) => [x.id, x.name]));
  cachedAdminMembersByGroup = new Map();
  (m.data || []).forEach((x) => {
    if (!cachedAdminMembersByGroup.has(x.group_id)) cachedAdminMembersByGroup.set(x.group_id, []);
    cachedAdminMembersByGroup.get(x.group_id).push(x);
  });

  if (s.voting_open && (!s.voting_deadline || new Date(s.voting_deadline).getTime() <= Date.now())) {
    const closed = await supabase
      .from('competition_settings')
      .update({ voting_open: false, updated_at: new Date().toISOString() })
      .eq('id', true);
    if (closed.error) throw closed.error;
    s.voting_open = false;
  }

  document.getElementById('adminTitle').value = String(s.title || 'DuetFlix').replace(/AI Project Arena/gi, 'DuetFlix');
  document.getElementById('adminSubmissionDeadline').value = localDate(s.submission_deadline);
  document.getElementById('adminVotingDeadline').value = localDate(s.voting_deadline);
  document.getElementById('adminSubmissionsOpen').checked = !!s.submissions_open;
  document.getElementById('adminVotingOpen').checked = !!s.voting_open;
  document.getElementById('adminResultsPublished').checked = !!s.results_published;

  updateAdminKpiCounters();
  renderAdminQueue();
  renderRejectedGallery();
  renderAdminVideoAnalytics();
  renderAdminCommentsModeration();

  const approved = cachedAdminSubmissions.filter((x) => x.status === 'approved');
  const approvedList = document.getElementById('adminApprovedGallery');
  if (approvedList) {
    approvedList.innerHTML = approved.length
      ? approved
          .map(
            (x) =>
              '<article class="admin-submission" data-submission-id="' +
              escapeHtml(x.id) +
              '" data-group-id="' +
              escapeHtml(x.group_id) +
              '">' +
              '<div class="group-title">' +
              '<div>' +
              '<h4>' +
              escapeHtml(x.title) +
              '</h4>' +
              '<span class="dash-help">' +
              escapeHtml(cachedAdminGroupsMap.get(x.group_id) || 'Team') +
              ' · Approved in Exhibition</span>' +
              '</div>' +
              '<span class="dash-status approved">Approved</span>' +
              '</div>' +
              '<p>' +
              escapeHtml(x.description) +
              '</p>' +
              buildYoutubePlayerHtml(x.video_url, x.thumbnail_path, x.title, 'admin-video', x.id) +
              '<div class="admin-actions">' +
              '<button class="btn sm" data-review="pending" type="button">↩ Return to Pending Queue</button>' +
              '<button class="btn sm danger" data-review="rejected" type="button">✕ Move to Rejected</button>' +
              '<button class="btn sm danger" data-delete-submission type="button" style="margin-left:auto">🗑 Delete Video</button>' +
              '</div>' +
              '<div class="admin-message" role="status"></div>' +
              '</article>'
          )
          .join('')
      : '<div class="dashboard-empty">Approved projects will appear here.</div>';
  }

  adminVotingDeadlineMs = s.voting_deadline ? new Date(s.voting_deadline).getTime() : null;
  adminVotingActive = !!s.voting_open && !!adminVotingDeadlineMs && adminVotingDeadlineMs > Date.now();
  startAdminVotingClock();
  await refreshAdminVoteCounts();

  if (adminCountsInterval) clearInterval(adminCountsInterval);
  adminCountsInterval = setInterval(() => {
    if (isArenaAdmin) refreshAdminVoteCounts().catch((e) => console.warn('Vote count refresh failed', e));
  }, 15000);
}

// Export CSV Report in Admin
document.getElementById('exportAdminCsv')?.addEventListener('click', () => {
  if (!isArenaAdmin || !cachedAdminSubmissions.length) {
    showToast('No submission data available to export.');
    return;
  }
  const votesByTitleAndGroup = new Map(
    cachedAdminResults.map((r) => [`${r.project_title}||${r.group_name}`, Number(r.vote_count || 0)])
  );
  const headers = ['Submission ID', 'Team Name', 'Project Title', 'Status', 'Votes', 'Members & Roll Numbers', 'YouTube URL', 'Submitted At'];
  const rows = cachedAdminSubmissions.map((sub) => {
    const teamName = cachedAdminGroupsMap.get(sub.group_id) || 'Team';
    const members = (cachedAdminMembersByGroup.get(sub.group_id) || [])
      .map((m) => `${m.member_name} (${m.roll_number})`)
      .join('; ');
    const votes = votesByTitleAndGroup.get(`${sub.title}||${teamName}`) ?? 0;
    return [
      sub.id,
      teamName,
      sub.title,
      sub.status,
      votes,
      members,
      sub.video_url || '',
      sub.submitted_at || '',
    ].map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(',');
  });
  const csv = [headers.join(','), ...rows].join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `duetflix-report-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast('CSV report downloaded.');
});

document.getElementById('adminEntry')?.addEventListener('click', (e) => {
  e.preventDefault();
  if (isArenaAdmin) {
    adminDashboard?.scrollIntoView({ behavior: 'smooth' });
    return;
  }
  openAuth('signin');
});

document.getElementById('refreshAdmin')?.addEventListener('click', async () => {
  try {
    await loadAdminDashboard();
    adminMsg('adminSettingsMessage', 'Control room data refreshed.');
    showToast('Admin data refreshed.');
  } catch (e) {
    adminMsg('adminSettingsMessage', e.message, true);
  }
});

document.getElementById('saveAdminSettings')?.addEventListener('click', async () => {
  const btn = document.getElementById('saveAdminSettings');
  btn.disabled = true;
  try {
    const p = {
      title: document.getElementById('adminTitle').value.trim(),
      submission_deadline: isoDate(document.getElementById('adminSubmissionDeadline').value),
      submissions_open: document.getElementById('adminSubmissionsOpen').checked,
      updated_at: new Date().toISOString(),
    };
    if (!p.title) throw new Error('Enter a competition title.');
    const { data, error } = await supabase
      .from('competition_settings')
      .update(p)
      .eq('id', true)
      .select('id')
      .single();
    if (error) throw error;
    if (!data) throw new Error('Settings were not saved. Check admin access.');
    adminMsg('adminSettingsMessage', 'Competition title and submission window saved.');
    showToast('Competition settings saved.');
    await loadAdminDashboard();
  } catch (e) {
    adminMsg('adminSettingsMessage', e.message || 'Could not save settings.', true);
  } finally {
    btn.disabled = false;
  }
});

// Delete All Rejected Videos button handler
document.getElementById('deleteAllRejectedBtn')?.addEventListener('click', async () => {
  const rejectedItems = cachedAdminSubmissions.filter((x) => x.status === 'rejected');
  if (!rejectedItems.length) {
    showToast('No rejected videos to delete.');
    return;
  }
  if (
    !window.confirm(
      `Permanently delete all ${rejectedItems.length} rejected video${rejectedItems.length === 1 ? '' : 's'} from the Rejected Videos Gallery?`
    )
  ) {
    return;
  }

  const btn = document.getElementById('deleteAllRejectedBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Deleting all…';
  }

  try {
    const ids = rejectedItems.map((x) => x.id);
    ids.forEach((id) => addDismissedRejectedId(id));
    await supabase.from('project_submissions').delete().in('id', ids);
    cachedAdminSubmissions = cachedAdminSubmissions.filter((x) => x.status !== 'rejected');
    updateAdminKpiCounters();
    renderAdminQueue();
    renderRejectedGallery();
    showToast(`Deleted ${ids.length} rejected video${ids.length === 1 ? '' : 's'}.`);
  } catch {
    cachedAdminSubmissions = cachedAdminSubmissions.filter((x) => x.status !== 'rejected');
    updateAdminKpiCounters();
    renderAdminQueue();
    renderRejectedGallery();
    showToast('All rejected videos removed from gallery.');
  } finally {
    if (btn) {
      btn.textContent = '🗑 Delete All Rejected Videos';
    }
  }
});

async function handleAdminReviewClick(e) {
  // Handle feedback preset chips
  const presetBtn = e.target.closest('[data-preset]');
  if (presetBtn) {
    const card = presetBtn.closest('[data-submission-id]');
    const textarea = card?.querySelector('.admin-feedback');
    if (textarea) {
      textarea.value = presetBtn.dataset.preset;
      textarea.focus();
    }
    return;
  }

  // Handle Delete Video / Submission button
  const deleteBtn = e.target.closest('[data-delete-submission]');
  if (deleteBtn) {
    const card = deleteBtn.closest('[data-submission-id]');
    if (!card) return;
    const subId = card.dataset.submissionId;
    const titleText = card.querySelector('h4')?.textContent || 'this video submission';
    if (!window.confirm(`Permanently delete "${titleText}"?`)) return;

    deleteBtn.disabled = true;
    deleteBtn.textContent = 'Deleting…';
    try {
      addDismissedRejectedId(subId);
      await supabase.from('project_submissions').delete().eq('id', subId);
      cachedAdminSubmissions = cachedAdminSubmissions.filter((x) => String(x.id) !== String(subId));
      updateAdminKpiCounters();
      renderAdminQueue();
      renderRejectedGallery();
      showToast(`Deleted "${titleText}".`);
    } catch {
      cachedAdminSubmissions = cachedAdminSubmissions.filter((x) => String(x.id) !== String(subId));
      updateAdminKpiCounters();
      renderAdminQueue();
      renderRejectedGallery();
      showToast(`Deleted "${titleText}".`);
    }
    return;
  }

  const btn = e.target.closest('[data-review]');
  if (!btn) return;
  const card = btn.closest('[data-submission-id]');
  btn.disabled = true;
  const msg = card.querySelector('.admin-message');
  try {
    const nextStatus = btn.dataset.review;
    const feedbackInput = card.querySelector('.admin-feedback');
    const updatePayload = {
      status: nextStatus,
      updated_at: new Date().toISOString(),
    };
    if (feedbackInput) {
      updatePayload.admin_feedback = feedbackInput.value.trim();
    }
    const { data, error } = await supabase
      .from('project_submissions')
      .update(updatePayload)
      .eq('id', card.dataset.submissionId)
      .select('id,status')
      .single();
    if (error) throw error;
    if (!data) throw new Error('No submission was updated. Refresh and try again.');
    if (msg) msg.textContent = 'Submission status updated.';
    showToast(
      nextStatus === 'rejected'
        ? 'Video moved to Rejected Videos Gallery.'
        : nextStatus === 'pending'
        ? 'Restored to Pending Moderation Queue.'
        : 'Approved for public exhibition!'
    );
    await loadAdminDashboard();
  } catch (err) {
    if (msg) {
      msg.textContent = err.message || 'Could not update submission.';
      msg.style.color = 'var(--danger)';
    }
  } finally {
    btn.disabled = false;
  }
}

document.getElementById('adminSubmissionList')?.addEventListener('click', handleAdminReviewClick);
document.getElementById('adminApprovedGallery')?.addEventListener('click', handleAdminReviewClick);
document.getElementById('adminRejectedGallery')?.addEventListener('click', handleAdminReviewClick);

async function setResultsPublished(published) {
  const btn = document.getElementById(published ? 'publishResultsNow' : 'unpublishResultsNow');
  if (!btn) return;
  btn.disabled = true;
  try {
    const { data, error } = await supabase
      .from('competition_settings')
      .update({ results_published: published, updated_at: new Date().toISOString() })
      .eq('id', true)
      .select('results_published')
      .single();
    if (error) throw error;
    if (!data || data.results_published !== published) {
      throw new Error('The database did not confirm the publication change.');
    }
    document.getElementById('adminResultsPublished').checked = published;
    adminMsg(
      'adminSettingsMessage',
      published
        ? 'Official results are now published to students.'
        : 'Official results are now hidden from students.'
    );
    showToast(published ? 'Results published!' : 'Results hidden.');
    await loadAdminDashboard();
  } catch (e) {
    adminMsg('adminSettingsMessage', e.message || 'Could not update publication status.', true);
  } finally {
    btn.disabled = false;
  }
}

document.getElementById('publishResultsNow')?.addEventListener('click', () => setResultsPublished(true));
document.getElementById('unpublishResultsNow')?.addEventListener('click', () => setResultsPublished(false));

document.querySelectorAll('[data-toast]').forEach((b) =>
  b.addEventListener('click', () => showToast(b.dataset.toast))
);


/* HOMEPAGE FEATURED PROJECT SLIDER + LIVE VOTING CLOCK */
let homeFeaturedProjects = [];
let homeFeaturedIndex = 0;
let homeFeaturedInterval = null;
let homeVotingInterval = null;
let homeVotingDeadline = null;
let homeVotingIsOpen = false;

function scrollToProjectVideo(subId, titleText) {
  if (!voterDashboard) return;
  voterDashboard.classList.add('visible');
  const searchInput = document.getElementById('voterSearchInput');
  if (searchInput && searchInput.value) {
    searchInput.value = '';
    renderVoterProjects();
  }
  const list = document.getElementById('voterProjectList');
  let targetCard = null;
  if (list && subId) {
    try {
      targetCard = list.querySelector(`[data-vote-submission="${CSS.escape(String(subId))}"]`);
    } catch {
      targetCard = [...list.querySelectorAll('.voter-card')].find(
        (c) => c.getAttribute('data-vote-submission') === String(subId)
      );
    }
  }
  if (!targetCard && list && titleText) {
    const norm = String(titleText).trim().toLowerCase();
    targetCard = [...list.querySelectorAll('.voter-card')].find(
      (c) => (c.querySelector('h3')?.textContent || '').trim().toLowerCase() === norm
    );
  }
  if (targetCard) {
    document
      .querySelectorAll('.voter-card.is-focused-video')
      .forEach((c) => c.classList.remove('is-focused-video'));
    targetCard.classList.add('is-focused-video');
    targetCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
    window.setTimeout(() => targetCard.classList.remove('is-focused-video'), 4500);
  } else {
    voterDashboard.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function handlePendingWatchRedirect() {
  try {
    const raw = sessionStorage.getItem('duetflix_pending_watch');
    if (!raw) return;
    sessionStorage.removeItem('duetflix_pending_watch');
    const parsed = JSON.parse(raw);
    window.setTimeout(() => {
      scrollToProjectVideo(parsed?.submissionId || '', parsed?.projectTitle || '');
    }, 120);
  } catch {}
}

function renderFeaturedProject(index, animate = true) {
  const stage = document.getElementById('featuredStage');
  const backdrop = document.getElementById('featuredBackdrop');
  const copy = document.getElementById('featuredCopy');
  if (!stage || !backdrop || !copy || !homeFeaturedProjects.length) return;
  const project = homeFeaturedProjects[index];
  const imageUrl = project.thumbnail_path ? resolveThumbnailUrl(project.thumbnail_path) : '';
  const videoMatch = String(project.video_url || '').match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|shorts\/|embed\/))([\w-]{11})/);
  const fallbackImage = videoMatch ? 'https://img.youtube.com/vi/' + videoMatch[1] + '/maxresdefault.jpg' : '';
  const chosenImage = imageUrl || fallbackImage;
  const subId = project.submission_id || project.id || '';
  const projTitle = project.project_title || '';
  const update = () => {
    backdrop.style.backgroundImage = chosenImage ? 'url("' + chosenImage.replace(/"/g, '%22') + '")' : 'linear-gradient(120deg, #101a2d, #243b5c)';
    document.getElementById('featuredTitle').textContent = projTitle || 'Featured student project';
    document.getElementById('featuredDescription').textContent = project.project_description || 'Watch this faculty-approved student demonstration.';
    document.getElementById('featuredCounter').textContent = 'FEATURED PROJECT ' + String(index + 1).padStart(2, '0') + ' / ' + String(homeFeaturedProjects.length).padStart(2, '0');
    stage.dataset.submissionId = String(subId);
    stage.dataset.projectTitle = String(projTitle);
    stage.href = '#voterDashboard';
    stage.removeAttribute('target');
    stage.removeAttribute('rel');
    stage.setAttribute('aria-label', 'Watch ' + (projTitle || 'featured project'));
  };
  if (!animate) { update(); return; }
  stage.classList.add('is-sliding-out'); copy.classList.add('is-copy-out');
  window.setTimeout(() => {
    backdrop.classList.add('is-entering'); update();
    stage.classList.remove('is-sliding-out'); stage.classList.add('is-sliding-in');
    copy.classList.remove('is-copy-out'); copy.classList.add('is-copy-in');
    window.setTimeout(() => { stage.classList.remove('is-sliding-in'); backdrop.classList.remove('is-entering'); copy.classList.remove('is-copy-in'); }, 850);
  }, 420);
}

document.getElementById('featuredStage')?.addEventListener('click', async (e) => {
  const arrow = e.target.closest('.featured-arrows span');
  if (arrow && homeFeaturedProjects.length > 1) {
    e.preventDefault();
    e.stopPropagation();
    const isPrev = arrow === arrow.parentElement?.firstElementChild;
    homeFeaturedIndex =
      (homeFeaturedIndex + (isPrev ? -1 : 1) + homeFeaturedProjects.length) %
      homeFeaturedProjects.length;
    renderFeaturedProject(homeFeaturedIndex, true);
    return;
  }

  e.preventDefault();
  const stage = e.currentTarget;
  const subId = stage.dataset.submissionId || '';
  const titleText = stage.dataset.projectTitle || '';

  if (!activeUser) {
    try {
      sessionStorage.setItem(
        'duetflix_pending_watch',
        JSON.stringify({ submissionId: subId, projectTitle: titleText })
      );
    } catch {}
    if (typeof window.openArenaAuth === 'function') {
      window.openArenaAuth('signin', 'voter');
    } else {
      roleChooser?.scrollIntoView({ behavior: 'smooth' });
    }
    showToast('Please sign in to watch "' + (titleText || 'this project') + '".');
    return;
  }

  if (!cachedVoterProjects.length) {
    await loadVoterDashboard(activeUser, {
      keepTeamView: currentArenaRole === 'team' || isArenaAdmin,
    });
  }
  scrollToProjectVideo(subId, titleText);
});

async function loadHomeFeaturedProjects() {
  const stage = document.getElementById('featuredStage');
  if (!stage) return;
  try {
    const { data, error } = await supabase.rpc('get_homepage_featured_projects');
    if (error) throw error;
    homeFeaturedProjects = (data || []).filter((p) => p.thumbnail_path || p.video_url);
    if (!homeFeaturedProjects.length) {
      document.getElementById('featuredTitle').textContent = 'Your project could be featured here.';
      document.getElementById('featuredDescription').textContent = 'Submit your project video and a JPG or PNG thumbnail. Once faculty approves it, it can appear in this rotating showcase.';
      document.getElementById('featuredCounter').textContent = 'DUET STUDENT SHOWCASE';
      stage.href = '#voterDashboard'; return;
    }
    homeFeaturedIndex = 0; renderFeaturedProject(0, false);
    if (homeFeaturedInterval) clearInterval(homeFeaturedInterval);
    if (homeFeaturedProjects.length > 1) homeFeaturedInterval = setInterval(() => {
      homeFeaturedIndex = (homeFeaturedIndex + 1) % homeFeaturedProjects.length;
      renderFeaturedProject(homeFeaturedIndex, true);
    }, 10000);
  } catch (error) {
    console.warn('Could not load homepage featured projects:', error);
    document.getElementById('featuredTitle').textContent = 'Student projects. Big-screen ideas.';
    document.getElementById('featuredDescription').textContent = 'Explore faculty-approved demonstrations created by DUET students.';
  }
}

function formatHomeCountdown(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(total / 86400), hours = Math.floor((total % 86400) / 3600), minutes = Math.floor((total % 3600) / 60), seconds = total % 60;
  return days > 0 ? days + 'd ' + String(hours).padStart(2,'0') + ':' + String(minutes).padStart(2,'0') + ':' + String(seconds).padStart(2,'0') : String(hours).padStart(2,'0') + ':' + String(minutes).padStart(2,'0') + ':' + String(seconds).padStart(2,'0');
}

function updateHomeVotingClock() {
  const timer = document.getElementById('homeVotingTimer'), status = document.getElementById('votingHeroStatus'), message = document.getElementById('homeVotingMessage'), deadlineLabel = document.getElementById('homeVotingDeadline'), voteButton = document.getElementById('homeVoteNow');
  if (!timer || !status || !message || !voteButton) return;
  const remaining = homeVotingDeadline ? homeVotingDeadline.getTime() - Date.now() : 0;
  const active = homeVotingIsOpen && homeVotingDeadline && remaining > 0;
  status.textContent = active ? 'Voting is open' : 'Voting is closed';
  status.classList.toggle('is-live', !!active);
  timer.textContent = active ? formatHomeCountdown(remaining) : '00:00:00';
  message.textContent = active ? 'Cast your single verified vote before the countdown ends.' : 'The official countdown will begin here when faculty opens voting.';
  deadlineLabel.textContent = homeVotingDeadline ? 'Closes ' + homeVotingDeadline.toLocaleString([], { dateStyle:'medium', timeStyle:'short' }) : 'Voting not started';
  voteButton.disabled = !active; voteButton.textContent = active ? 'Vote Now ↗' : 'Voting Closed';
}

async function loadHomeVotingStatus() {
  try {
    const { data, error } = await supabase.from('competition_settings').select('voting_open,voting_deadline').eq('id', true).maybeSingle();
    if (error) throw error;
    homeVotingIsOpen = !!data?.voting_open;
    homeVotingDeadline = data?.voting_deadline ? new Date(data.voting_deadline) : null;
    if (homeVotingInterval) clearInterval(homeVotingInterval);
    updateHomeVotingClock(); homeVotingInterval = setInterval(updateHomeVotingClock, 1000);
  } catch (error) {
    console.warn('Could not load homepage voting status:', error);
    const msg = document.getElementById('homeVotingMessage');
    if (msg) msg.textContent = 'Voting schedule is currently unavailable.';
  }
}

document.getElementById('homeVoteNow')?.addEventListener('click', () => {
  if (!homeVotingIsOpen || !homeVotingDeadline || homeVotingDeadline.getTime() <= Date.now()) return;
  if (activeUser) voterDashboard?.scrollIntoView({ behavior:'smooth' });
  else roleChooser?.scrollIntoView({ behavior:'smooth' });
});

if (document.getElementById('featuredStage')) {
  loadHomeFeaturedProjects(); loadHomeVotingStatus(); setInterval(loadHomeVotingStatus, 30000);
}
