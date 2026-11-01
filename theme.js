const key = 'arena-theme-v2';
const button = document.getElementById('themeToggle');

function applyTheme(mode) {
  const isDark = mode !== 'light';
  document.body.classList.toggle('dark-mode', isDark);
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) {
    metaTheme.setAttribute('content', isDark ? '#0b0f17' : '#f8f9fb');
  }
  if (button) {
    button.innerHTML = isDark
      ? '<span class="theme-icon" aria-hidden="true">☀</span><span class="theme-label">Light mode</span>'
      : '<span class="theme-icon" aria-hidden="true">☾</span><span class="theme-label">Dark mode</span>';
    button.setAttribute('aria-pressed', String(isDark));
  }
}

const saved = localStorage.getItem(key) || 'dark';
applyTheme(saved);

button?.addEventListener('click', () => {
  const next = document.body.classList.contains('dark-mode') ? 'light' : 'dark';
  localStorage.setItem(key, next);
  applyTheme(next);
});

/* ==========================================================================
   RESPONSIVE MOBILE NAVIGATION DRAWER
   ========================================================================== */

const navContainer = document.querySelector('.topbar .nav');
const navLinks = document.querySelector('.topbar .navlinks');
const navActions = document.querySelector('.topbar .navactions');

if (navContainer && navLinks && navActions && !document.getElementById('mobileMenuBtn')) {
  const menuBtn = document.createElement('button');
  menuBtn.type = 'button';
  menuBtn.id = 'mobileMenuBtn';
  menuBtn.className = 'btn mobile-menu-btn';
  menuBtn.setAttribute('aria-expanded', 'false');
  menuBtn.setAttribute('aria-label', 'Toggle navigation menu');
  menuBtn.innerHTML = '<span class="menu-bars" aria-hidden="true">☰</span>';
  navActions.append(menuBtn);

  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = document.body.classList.toggle('mobile-nav-open');
    menuBtn.setAttribute('aria-expanded', String(open));
    menuBtn.querySelector('.menu-bars').textContent = open ? '✕' : '☰';
  });

  navLinks.querySelectorAll('a').forEach((link) => {
    link.addEventListener('click', () => {
      document.body.classList.remove('mobile-nav-open');
      menuBtn.setAttribute('aria-expanded', 'false');
      menuBtn.querySelector('.menu-bars').textContent = '☰';
    });
  });

  document.addEventListener('click', (e) => {
    if (
      document.body.classList.contains('mobile-nav-open') &&
      !navContainer.contains(e.target)
    ) {
      document.body.classList.remove('mobile-nav-open');
      menuBtn.setAttribute('aria-expanded', 'false');
      menuBtn.querySelector('.menu-bars').textContent = '☰';
    }
  });
}
