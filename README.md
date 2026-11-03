# DuetFlix

Files:
- index.html: the site and dashboards, with the sign-in modal markup.
- login.css: styling for the sign-in modal.
- auth.js: sign-in, sign-up, and Google sign-in.
- config.js: public Supabase settings (anon key only).

Run locally: python -m http.server 8000, then open http://localhost:8000
Supabase → Authentication → URL Configuration → Redirect URLs: add http://localhost:8000/** and https://YOUR-SITE.vercel.app/**
