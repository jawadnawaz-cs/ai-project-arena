// Sign-in, sign-up, and Google sign-in for the AI Project Arena modal.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.118.0";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const ARENA_REDIRECT = window.location.origin + "/";
const UNIVERSITY_DOMAIN = "@students.duet.edu.pk";

const modal = document.getElementById("authModal");
const form = document.getElementById("authForm");
const message = document.getElementById("authMessage");
const submit = document.getElementById("authSubmit");
const title = document.getElementById("authTitle");
const subtitle = document.getElementById("authSubtitle");
const nameField = document.getElementById("nameField");
const typeField = document.getElementById("typeField");
const passwordInput = document.getElementById("password");
const tabs = [...document.querySelectorAll("[data-mode]")];
let mode = "signin";

function showMessage(text, isError = false) {
  message.textContent = text;
  message.dataset.error = String(isError);
}

function setMode(next) {
  mode = next;
  const signup = mode === "signup";
  tabs.forEach((b) => {
    const active = b.dataset.mode === mode;
    b.classList.toggle("active", active);
    b.setAttribute("aria-selected", String(active));
  });
  nameField.style.display = signup ? "" : "none";
  typeField.style.display = signup ? "" : "none";
  title.textContent = signup ? "Create your account" : "Welcome to the arena";
  const selectedRole = sessionStorage.getItem("arena_selected_role");
  const roleLabel = selectedRole === "team" ? "Uploader / Team" : selectedRole === "voter" ? "Voter" : "Arena";
  subtitle.textContent = signup
    ? "Create your " + roleLabel + " account to join the arena."
    : "Sign in to continue as " + roleLabel + ".";
  submit.textContent = signup ? "Create account" : "Sign in";
  passwordInput.autocomplete = signup ? "new-password" : "current-password";
  showMessage("");
}

function openAuth(next = "signin") {
  setMode(next);
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  document.getElementById("email").focus();
}

function closeAuth() {
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
}

document.querySelectorAll("[data-auth]").forEach((b) =>
  b.addEventListener("click", () => {
    if (b.dataset.role) sessionStorage.setItem("arena_selected_role", b.dataset.role);
    if (!sessionStorage.getItem("arena_selected_role")) {
      document.getElementById("roleChooser")?.scrollIntoView({ behavior: "smooth" });
      return;
    }
    openAuth(b.dataset.auth);
  })
);
tabs.forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
document.getElementById("authClose").addEventListener("click", closeAuth);
modal.addEventListener("click", (e) => {
  if (e.target === modal) closeAuth();
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = document.getElementById("email").value.trim();
  const password = passwordInput.value;
  const accountType = document.getElementById("accountType").value;
  const fullName = document.getElementById("fullName").value.trim();
  const arenaRole = sessionStorage.getItem("arena_selected_role");

  if (!arenaRole) {
    showMessage("Choose Voter or Uploader / Team before signing in.", true);
    closeAuth();
    document.getElementById("roleChooser")?.scrollIntoView({ behavior: "smooth" });
    return;
  }

  if (mode === "signup" && accountType === "university" && !email.toLowerCase().endsWith(UNIVERSITY_DOMAIN)) {
    showMessage(`Use your official ${UNIVERSITY_DOMAIN} email address.`, true);
    return;
  }

  submit.disabled = true;
  submit.textContent = "Please wait…";
  try {
    if (mode === "signup") {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: { account_type: accountType, full_name: fullName, arena_role: arenaRole },
          emailRedirectTo: ARENA_REDIRECT,
        },
      });
      if (error) throw error;
      showMessage(
        data.session
          ? "Account created. You are signed in."
          : "Account created. Check your email to verify your address."
      );
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      showMessage("Signed in successfully.");
      setTimeout(closeAuth, 700);
    }
  } catch (err) {
    showMessage(err.message || "Authentication failed. Please try again.", true);
  } finally {
    submit.disabled = false;
    submit.textContent = mode === "signup" ? "Create account" : "Sign in";
  }
});

document.getElementById("googleSignIn").addEventListener("click", async () => {
  try {
    if (!sessionStorage.getItem("arena_selected_role")) {
      showMessage("Choose Voter or Uploader / Team before using Google sign-in.", true);
      closeAuth();
      document.getElementById("roleChooser")?.scrollIntoView({ behavior: "smooth" });
      return;
    }
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: ARENA_REDIRECT },
    });
    if (error) throw error;
  } catch (err) {
    showMessage(err.message || "Google sign-in could not start.", true);
  }
});

setMode("signin");
