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

/* ==========================================================================
   AUTH STATE ROUTING & HEADER PROFILE ICON MENU
   ========================================================================== */

// Close profile menu when clicking outside
document.addEventListener('click', (e) => {
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
    // Hide unauthenticated Sign In and Join Arena buttons
    nav.querySelectorAll('#headerChooseRole, #headerSignIn').forEach((b) => (b.hidden = true));

    const userEmail = session.user.email || 'Signed-in User';
    const initial = userEmail.charAt(0).toUpperCase();

    const profileWrap = document.createElement('div');
    profileWrap.className = 'profile-menu-wrap';
    profileWrap.innerHTML =
      '<button type="button" class="profile-trigger" aria-expanded="false" aria-label="Account profile menu">' +
      '<span class="profile-avatar">' + escapeHtml(initial) + '</span>' +
      '<span class="profile-trigger-role" id="headerRoleBadge">Arena</span>' +
      '<span class="profile-trigger-caret" aria-hidden="true">▾</span>' +
      '</button>' +
      '<div class="profile-dropdown" role="menu">' +
      '<div class="profile-dropdown-header">' +
      '<div class="profile-dropdown-label"><span>Signed in as</span><span class="role-pill" id="dropdownRolePill">Arena</span></div>' +
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
      showToast('Signed out of AI Project Arena.');
    });

    nav.append(profileWrap);

    setTimeout(async () => {
      try {
        await checkArenaAdmin();
        const roleBadge = document.getElementById('headerRoleBadge');
        const dropdownPill = document.getElementById('dropdownRolePill');

        if (isArenaAdmin) {
          if (roleBadge) roleBadge.textContent = 'Admin';
          if (dropdownPill) dropdownPill.textContent = 'Admin';
          document.body.classList.add('authenticated-view');
          dashboard?.classList.remove('visible');
          voterDashboard?.classList.remove('visible');
          adminDashboard?.classList.add('visible');
          adminDashboard?.scrollIntoView({ behavior: 'auto' });
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
          voterDashboard?.classList.remove('visible');
          await loadDashboard(session.user);
          dashboard?.scrollIntoView({ behavior: 'auto' });
        } else if (role === 'voter') {
          dashboard?.classList.remove('visible');
          await loadVoterDashboard(session.user);
          voterDashboard?.scrollIntoView({ behavior: 'auto' });
        }
      } catch (err) {
        console.error('Arena role routing failed', err);
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

  const embedUrl = displaySub && displaySub.video_url ? getYoutubeEmbedUrl(displaySub.video_url) : null;
  const video = embedUrl
    ? '<div class="youtube-player"><iframe src="' +
      escapeHtml(embedUrl) +
      '" title="' +
      escapeHtml(displaySub.title) +
      ' video" loading="lazy" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe></div>'
    : displaySub && displaySub.video_url
    ? '<p class="dash-help"><a href="' +
      escapeHtml(displaySub.video_url) +
      '" target="_blank" rel="noopener">Open submitted video ↗</a></p>'
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
      (displaySub && displaySub.thumbnail_path
        ? '<img class="project-thumbnail team-submission-thumbnail" src="' + escapeHtml(resolveThumbnailUrl(displaySub.thumbnail_path)) + '" alt="' + escapeHtml(displaySub.title) + ' thumbnail" loading="lazy">'
        : '') +
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
    notice.innerHTML =
      '<span><strong>' +
      escapeHtml(competitionSettings.title || 'AI Project Arena') +
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
   VOTER WORKSPACE & LIVE SEARCH FILTERING
   ========================================================================== */

function renderVoterProjects() {
  const list = document.getElementById('voterProjectList');
  const countBadge = document.getElementById('voterCountBadge');
  const searchInput = document.getElementById('voterSearchInput');
  if (!list) return;

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

  list.innerHTML = filtered
    .map((x) => {
      const embed = getYoutubeEmbedUrl(x.video_url || '');
      const members = cachedVoterMembersByGroup.get(x.group_id) || [];
      return (
        '<article class="voter-card" data-vote-submission="' +
        escapeHtml(x.submission_id) +
        '">' +
        '<div class="eyebrow">' +
        escapeHtml(x.team_name || 'Student Team') +
        '</div>' +
        (x.thumbnail_path ? '<img class="project-thumbnail" src="' + escapeHtml(resolveThumbnailUrl(x.thumbnail_path)) + '" alt="' + escapeHtml(x.project_title) + ' thumbnail" loading="lazy">' : '') +
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
        (embed
          ? '<iframe src="' +
            escapeHtml(embed) +
            '" title="' +
            escapeHtml(x.project_title) +
            ' video" loading="lazy" allowfullscreen></iframe>'
          : '') +
        '<div class="voter-card-footer">' +
        '<span style="font-size:12px;color:var(--muted)">Verified Entry</span>' +
        '<button class="btn primary" type="button" data-cast-vote ' +
        (cachedVoterHasVoted || !cachedVoterVotingOpen ? 'disabled' : '') +
        '>' +
        (cachedVoterHasVoted
          ? '✓ Vote Recorded'
          : cachedVoterVotingOpen
          ? 'Cast Official Vote'
          : 'Voting Closed') +
        '</button>' +
        '</div>' +
        '</article>'
      );
    })
    .join('');
}

document.getElementById('voterSearchInput')?.addEventListener('input', renderVoterProjects);

async function loadVoterDashboard(user) {
  if (!user || !voterDashboard) return;
  activeUser = user;
  currentArenaRole = 'voter';
  voterDashboard.classList.add('visible');
  dashboard?.classList.remove('visible');
  document.body.classList.add('authenticated-view');

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
  if (projects.error) throw projects.error;
  if (votes.error) throw votes.error;

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

  cachedVoterProjects = projects.data || [];
  cachedVoterHasVoted = (votes.data || []).length > 0;

  renderVoterProjects();

  const voterMsg = document.getElementById('voterMessage');
  if (voterMsg) {
    voterMsg.textContent = cachedVoterHasVoted
      ? 'Your official vote has been recorded. Each student account may vote once.'
      : cachedVoterVotingOpen
      ? 'Select your favourite project below to cast your single official vote.'
      : 'You can browse approved demonstrations below while voting is closed.';
  }
}

document.getElementById('refreshVoter')?.addEventListener('click', async () => {
  try {
    await loadVoterDashboard(activeUser);
    showToast('Project exhibition refreshed.');
  } catch (e) {
    const msg = document.getElementById('voterMessage');
    if (msg) msg.textContent = e.message || 'Could not refresh projects.';
  }
});

document.getElementById('voterProjectList')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-cast-vote]');
  if (!btn) return;
  const card = btn.closest('[data-vote-submission]');
  const titleText = card?.querySelector('h3')?.textContent || 'this project';
  if (!window.confirm(`Cast your single official vote for "${titleText}"? This cannot be undone.`)) {
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Submitting vote…';
  try {
    const { error } = await supabase
      .from('votes')
      .insert({ voter_id: activeUser.id, submission_id: card.dataset.voteSubmission });
    if (error) throw error;
    showToast('Your vote has been recorded!');
    await loadVoterDashboard(activeUser);
  } catch (err) {
    const msg = document.getElementById('voterMessage');
    if (msg) msg.textContent = err.message || 'Could not submit your vote.';
    btn.disabled = false;
    btn.textContent = 'Try again';
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
    const maxVotes = Math.max(1, ...cachedAdminResults.map((r) => Number(r.vote_count || 0)));
    box.innerHTML = cachedAdminResults
      .map((x, idx) => {
        const count = Number(x.vote_count || 0);
        const pct = Math.round((count / maxVotes) * 100);
        const rankClass = idx === 0 ? 'rank-1' : idx === 1 ? 'rank-2' : idx === 2 ? 'rank-3' : '';
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
    // Approved and Rejected live in their own dedicated galleries
    if (x.status === 'approved' || x.status === 'rejected') return false;
    if (dismissedIds.has(String(x.id))) return false;
    if (statusFilter !== 'all' && x.status !== statusFilter) return false;
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
        ? '<div class="dashboard-empty">No pending projects waiting for review. Rejected videos are stored in the Rejected Videos Gallery below.</div>'
        : '<div class="dashboard-empty">No submissions match the current queue filter.</div>';
    return;
  }

  list.innerHTML = reviewQueue
    .map((x) => {
      const embed = getYoutubeEmbedUrl(x.video_url || '');
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
        (embed
          ? '<iframe class="admin-video" src="' +
            escapeHtml(embed) +
            '" title="Project demo" loading="lazy" allowfullscreen></iframe>'
          : '') +
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
      const embed = getYoutubeEmbedUrl(x.video_url || '');
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
        (embed
          ? '<iframe class="admin-video rejected-video-frame" src="' +
            escapeHtml(embed) +
            '" title="' +
            escapeHtml(x.title) +
            '" loading="lazy" allowfullscreen></iframe>'
          : x.video_url
          ? '<p class="dash-help"><a href="' +
            escapeHtml(x.video_url) +
            '" target="_blank" rel="noopener" style="color:var(--primary);text-decoration:underline">Open Video Link ↗</a></p>'
          : '') +
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
  const [a, b, g, m] = await Promise.all([
    supabase.from('competition_settings').select('*').eq('id', true).single(),
    supabase
      .from('project_submissions')
      .select('id,group_id,title,description,video_url,status,admin_feedback,submitted_at')
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

  document.getElementById('adminTitle').value = s.title || '';
  document.getElementById('adminSubmissionDeadline').value = localDate(s.submission_deadline);
  document.getElementById('adminVotingDeadline').value = localDate(s.voting_deadline);
  document.getElementById('adminSubmissionsOpen').checked = !!s.submissions_open;
  document.getElementById('adminVotingOpen').checked = !!s.voting_open;
  document.getElementById('adminResultsPublished').checked = !!s.results_published;

  updateAdminKpiCounters();
  renderAdminQueue();
  renderRejectedGallery();

  const approved = cachedAdminSubmissions.filter((x) => x.status === 'approved');
  const approvedList = document.getElementById('adminApprovedGallery');
  if (approvedList) {
    approvedList.innerHTML = approved.length
      ? approved
          .map(
            (x) =>
              '<article class="approved-mini" data-submission-id="' +
              escapeHtml(x.id) +
              '">' +
              '<div><strong>' +
              escapeHtml(x.title) +
              '</strong><span>' +
              escapeHtml(cachedAdminGroupsMap.get(x.group_id) || 'Team') +
              '</span></div>' +
              '<span class="dash-status approved">Approved</span>' +
              '<button class="text-button" data-review="pending" type="button">Return to Queue</button>' +
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
  a.download = `ai-project-arena-report-${new Date().toISOString().slice(0, 10)}.csv`;
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
  const update = () => {
    backdrop.style.backgroundImage = chosenImage ? 'linear-gradient(90deg, rgba(5,9,17,.88), rgba(5,9,17,.28)), url("' + chosenImage.replace(/"/g, '%22') + '")' : 'linear-gradient(120deg, #101a2d, #243b5c)';
    document.getElementById('featuredTitle').textContent = project.project_title || 'Featured student project';
    document.getElementById('featuredDescription').textContent = project.project_description || 'Watch this faculty-approved student demonstration.';
    document.getElementById('featuredCounter').textContent = 'FEATURED PROJECT ' + String(index + 1).padStart(2, '0') + ' / ' + String(homeFeaturedProjects.length).padStart(2, '0');
    stage.href = project.video_url || 'projects.html';
    stage.target = project.video_url ? '_blank' : '_self';
    stage.rel = project.video_url ? 'noopener noreferrer' : '';
    stage.setAttribute('aria-label', 'Watch ' + (project.project_title || 'featured project'));
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
      stage.href = 'projects.html'; return;
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
  if (activeUser && currentArenaRole === 'voter') voterDashboard?.scrollIntoView({ behavior:'smooth' });
  else roleChooser?.scrollIntoView({ behavior:'smooth' });
});

if (document.getElementById('featuredStage')) {
  loadHomeFeaturedProjects(); loadHomeVotingStatus(); setInterval(loadHomeVotingStatus, 30000);
}
