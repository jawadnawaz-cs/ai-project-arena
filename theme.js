const key='arena-theme';
const button=document.getElementById('themeToggle');
function applyTheme(mode){document.body.classList.toggle('dark-mode',mode==='dark');if(button){button.textContent=mode==='dark'?'☀ Light mode':'☾ Dark mode';button.setAttribute('aria-pressed',String(mode==='dark'));}}
const saved=localStorage.getItem(key)||'light';applyTheme(saved);
button?.addEventListener('click',()=>{const next=document.body.classList.contains('dark-mode')?'light':'dark';localStorage.setItem(key,next);applyTheme(next);});
