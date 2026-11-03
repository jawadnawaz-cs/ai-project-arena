import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.118.0';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const panel = document.getElementById('superAdminPanel');
const form = document.getElementById('adminAccessForm');
const emailInput = document.getElementById('adminAccessEmail');
const message = document.getElementById('adminAccessMessage');
const list = document.getElementById('adminAccessList');

function setMessage(text, isError = false) {
  message.textContent = text || '';
  message.style.color = isError ? '#a33' : 'var(--green)';
}

function escapeText(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

async function loadAdmins() {
  const { data, error } = await supabase.rpc('get_arena_admins');
  if (error) throw error;
  list.innerHTML = (data || []).length
    ? data.map((admin) => `
      <div class="admin-access-row">
        <span><strong>${escapeText(admin.email)}</strong><br><small>Admin · added ${new Date(admin.created_at).toLocaleDateString()}</small></span>
        <button class="btn danger" type="button" data-revoke-email="${escapeText(admin.email)}">Revoke access</button>
      </div>`).join('')
    : '<p class="dash-help">No additional admins have been added yet.</p>';
}

async function refreshAccess() {
  if (!panel) return;
  const { data, error } = await supabase.rpc('is_arena_super_admin');
  if (error) {
    panel.hidden = true;
    return;
  }
  panel.hidden = !data;
  if (data) {
    try { await loadAdmins(); }
    catch (err) { setMessage(err.message || 'Could not load admin access.', true); }
  }
}

form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = form.querySelector('button[type="submit"]');
  const email = emailInput.value.trim().toLowerCase();
  button.disabled = true;
  setMessage('');
  try {
    const { error } = await supabase.rpc('set_arena_admin_access', {
      target_email: email,
      grant_access: true
    });
    if (error) throw error;
    emailInput.value = '';
    setMessage('Admin access granted. They can sign in using this email.');
    await loadAdmins();
  } catch (err) {
    setMessage(err.message || 'Could not grant admin access.', true);
  } finally {
    button.disabled = false;
  }
});

list?.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-revoke-email]');
  if (!button) return;
  const email = button.dataset.revokeEmail;
  if (!window.confirm(`Revoke admin access for ${email}?`)) return;
  button.disabled = true;
  setMessage('');
  try {
    const { error } = await supabase.rpc('set_arena_admin_access', {
      target_email: email,
      grant_access: false
    });
    if (error) throw error;
    setMessage('Admin access revoked.');
    await loadAdmins();
  } catch (err) {
    setMessage(err.message || 'Could not revoke admin access.', true);
  } finally {
    button.disabled = false;
  }
});

supabase.auth.onAuthStateChange(() => {
  setTimeout(() => refreshAccess(), 0);
});
refreshAccess();
