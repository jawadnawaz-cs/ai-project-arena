// Authentication, Create Account, Google OAuth, and Forgot Password (via Email OTP) for AI Project Arena
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

const authRolePicker = document.getElementById("authRolePicker");
const authModeTabs = document.getElementById("authModeTabs");
const nameField = document.getElementById("nameField");
const typeField = document.getElementById("typeField");
const emailField = document.getElementById("emailField");
const passwordField = document.getElementById("passwordField");
const passwordLabelText = document.getElementById("passwordLabelText");
const confirmPasswordField = document.getElementById("confirmPasswordField");
const otpCodeField = document.getElementById("otpCodeField");

const emailInput = document.getElementById("email");
const passwordInput = document.getElementById("password");
const confirmPasswordInput = document.getElementById("confirmPassword");
const otpCodeInput = document.getElementById("otpCode");
const togglePasswordBtn = document.getElementById("togglePasswordBtn");
const forgotPasswordLink = document.getElementById("forgotPasswordLink");
const backToSignInLink = document.getElementById("backToSignInLink");
const resendOtpLink = document.getElementById("resendOtpLink");
const googleBtn = document.getElementById("googleSignIn");
const authDivider = document.getElementById("authDivider");

const tabs = [...document.querySelectorAll("[data-mode]")];
const roleButtons = [...document.querySelectorAll("[data-pick-role]")];

// Modes: "signin" | "signup" | "forgot" | "forgot-verify" | "reset-password"
let mode = "signin";
let recoveryEmail = "";

function showMessage(text, isError = false) {
  if (!message) return;
  message.textContent = text || "";
  message.dataset.error = String(Boolean(isError));
}

function getSelectedRole() {
  return sessionStorage.getItem("arena_selected_role") || "voter";
}

function setSelectedRole(role) {
  const validRole = role === "team" ? "team" : "voter";
  sessionStorage.setItem("arena_selected_role", validRole);
  roleButtons.forEach((btn) => {
    const active = btn.dataset.pickRole === validRole;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", String(active));
  });
  updateSubtitle();
}

function updateSubtitle() {
  if (!subtitle) return;
  const roleLabel = getSelectedRole() === "team" ? "Uploader / Team Lead" : "Voter / Evaluator";
  if (mode === "signup") {
    subtitle.textContent = `Create your ${roleLabel} account to join the arena.`;
  } else if (mode === "forgot") {
    subtitle.textContent = "Enter your email address to receive a one-time recovery OTP code.";
  } else if (mode === "forgot-verify") {
    subtitle.textContent = `Enter the OTP code sent to ${recoveryEmail || "your email"} and choose a new password.`;
  } else if (mode === "reset-password") {
    subtitle.textContent = "Choose a strong new password (at least 8 characters) for your Arena account.";
  } else {
    subtitle.textContent = `Sign in to your ${roleLabel} workspace.`;
  }
}

function setMode(next) {
  mode = next;
  const isSignup = mode === "signup";
  const isSignin = mode === "signin";
  const isForgotRequest = mode === "forgot";
  const isForgotVerify = mode === "forgot-verify";
  const isReset = mode === "reset-password";
  const inRecoveryFlow = isForgotRequest || isForgotVerify || isReset;

  tabs.forEach((b) => {
    const active = b.dataset.mode === mode;
    b.classList.toggle("active", active);
    b.setAttribute("aria-selected", String(active));
  });

  // Hide role picker, Sign In/Up tabs, and Google button when inside Forgot Password flow
  if (authRolePicker) authRolePicker.style.display = inRecoveryFlow ? "none" : "";
  if (authModeTabs) authModeTabs.style.display = inRecoveryFlow ? "none" : "";
  if (googleBtn) googleBtn.style.display = inRecoveryFlow ? "none" : "";
  if (authDivider) authDivider.style.display = inRecoveryFlow ? "none" : "";

  if (nameField) nameField.style.display = isSignup ? "" : "none";
  if (typeField) typeField.style.display = isSignup ? "" : "none";

  if (emailField) emailField.style.display = isReset ? "none" : "";
  if (emailInput) {
    emailInput.required = !isReset;
    emailInput.readOnly = isForgotVerify;
  }

  // OTP code field ONLY appears inside Forgot Password verification step
  if (otpCodeField) otpCodeField.style.display = isForgotVerify ? "" : "none";
  if (otpCodeInput) otpCodeInput.required = isForgotVerify;

  const showPassword = isSignin || isSignup || isForgotVerify || isReset;
  if (passwordField) passwordField.style.display = showPassword ? "" : "none";
  if (passwordInput) {
    passwordInput.required = showPassword;
    passwordInput.autocomplete = isSignin ? "current-password" : "new-password";
  }
  if (passwordLabelText) {
    passwordLabelText.textContent = isForgotVerify || isReset ? "New Password" : "Password";
  }

  const showConfirm = isForgotVerify || isReset;
  if (confirmPasswordField) confirmPasswordField.style.display = showConfirm ? "" : "none";
  if (confirmPasswordInput) confirmPasswordInput.required = showConfirm;

  if (forgotPasswordLink) forgotPasswordLink.style.display = isSignin ? "" : "none";
  if (backToSignInLink) backToSignInLink.style.display = inRecoveryFlow ? "" : "none";
  if (resendOtpLink) resendOtpLink.style.display = isForgotVerify ? "" : "none";

  if (title) {
    if (isSignup) title.textContent = "Create your account";
    else if (isForgotRequest) title.textContent = "Forgot your password?";
    else if (isForgotVerify) title.textContent = "Verify Email OTP";
    else if (isReset) title.textContent = "Set a new password";
    else title.textContent = "Welcome to the Arena";
  }

  if (submit) {
    if (isSignup) submit.textContent = "Create account";
    else if (isForgotRequest) submit.textContent = "Send recovery OTP code";
    else if (isForgotVerify) submit.textContent = "Verify OTP & reset password";
    else if (isReset) submit.textContent = "Save new password";
    else submit.textContent = "Sign in";
  }

  updateSubtitle();
  showMessage("");
}

export function openAuth(next = "signin", roleOverride = null) {
  if (roleOverride) setSelectedRole(roleOverride);
  else if (!sessionStorage.getItem("arena_selected_role")) setSelectedRole("voter");
  else setSelectedRole(getSelectedRole());

  setMode(next);
  if (!modal) return;
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  setTimeout(() => {
    if (next === "forgot-verify") otpCodeInput?.focus();
    else if (next === "reset-password") passwordInput?.focus();
    else emailInput?.focus();
  }, 40);
}

export function closeAuth() {
  if (!modal) return;
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
}

window.openArenaAuth = openAuth;

roleButtons.forEach((btn) => {
  btn.addEventListener("click", () => setSelectedRole(btn.dataset.pickRole));
});

document.querySelectorAll("[data-auth]").forEach((b) =>
  b.addEventListener("click", () => {
    openAuth(b.dataset.auth || "signin", b.dataset.role || null);
  })
);

tabs.forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
document.getElementById("authClose")?.addEventListener("click", closeAuth);
modal?.addEventListener("click", (e) => {
  if (e.target === modal) closeAuth();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && modal?.classList.contains("open")) closeAuth();
});

// Show / Hide password toggle
togglePasswordBtn?.addEventListener("click", () => {
  if (!passwordInput) return;
  const showing = passwordInput.type === "text";
  passwordInput.type = showing ? "password" : "text";
  togglePasswordBtn.textContent = showing ? "Show" : "Hide";
  togglePasswordBtn.setAttribute("aria-label", showing ? "Show password" : "Hide password");
});

// Forgot password -> opens Email OTP recovery request
forgotPasswordLink?.addEventListener("click", () => {
  setMode("forgot");
});

// Back to Sign in from recovery flow
backToSignInLink?.addEventListener("click", () => {
  if (emailInput) emailInput.readOnly = false;
  setMode("signin");
});

// Resend recovery OTP code
resendOtpLink?.addEventListener("click", async () => {
  const email = (emailInput?.value || recoveryEmail || "").trim();
  if (!email) {
    setMode("forgot");
    showMessage("Enter your email address first.", true);
    return;
  }
  resendOtpLink.disabled = true;
  try {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: ARENA_REDIRECT + "?reset=1",
    });
    if (error) throw error;
    showMessage(`A fresh recovery OTP code was sent to ${email}.`);
  } catch (err) {
    showMessage(err.message || "Could not resend OTP code.", true);
  } finally {
    resendOtpLink.disabled = false;
  }
});

// Main Form Submission Handler
form?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = (emailInput?.value || recoveryEmail || "").trim();
  const password = passwordInput?.value || "";
  const confirmPassword = confirmPasswordInput?.value || "";
  const otpToken = (otpCodeInput?.value || "").trim();
  const accountType = document.getElementById("accountType")?.value || "general";
  const fullName = (document.getElementById("fullName")?.value || "").trim();
  const arenaRole = getSelectedRole();

  if (mode === "signup" && accountType === "university" && !email.toLowerCase().endsWith(UNIVERSITY_DOMAIN)) {
    showMessage(`University accounts must use an official ${UNIVERSITY_DOMAIN} address.`, true);
    return;
  }

  submit.disabled = true;
  const previousLabel = submit.textContent;
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
          ? "Account created. You are now signed in."
          : "Account created! Please check your email to confirm your address."
      );
      if (data.session) setTimeout(closeAuth, 650);
    } else if (mode === "signin") {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      showMessage("Signed in successfully.");
      setTimeout(closeAuth, 550);
    } else if (mode === "forgot") {
      // Send password recovery email (contains OTP token / recovery link)
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: ARENA_REDIRECT + "?reset=1",
      });
      if (error) throw error;
      recoveryEmail = email;
      setMode("forgot-verify");
      showMessage(
        `Recovery OTP sent to ${email}. Enter the code from your email and your new password above (or click the email link).`
      );
    } else if (mode === "forgot-verify") {
      if (!otpToken || otpToken.length < 6) {
        throw new Error("Please enter the verification OTP code from your email.");
      }
      if (password.length < 8) {
        throw new Error("Your new password must be at least 8 characters long.");
      }
      if (password !== confirmPassword) {
        throw new Error("Passwords do not match. Please re-enter them carefully.");
      }
      // Verify the recovery OTP code
      let verifyResult = await supabase.auth.verifyOtp({
        email: recoveryEmail || email,
        token: otpToken,
        type: "recovery",
      });
      if (verifyResult.error) {
        verifyResult = await supabase.auth.verifyOtp({
          email: recoveryEmail || email,
          token: otpToken,
          type: "email",
        });
      }
      if (verifyResult.error) throw verifyResult.error;

      // Update the user's password now that the recovery OTP session is active
      const { error: updateErr } = await supabase.auth.updateUser({ password });
      if (updateErr) throw updateErr;

      if (emailInput) emailInput.readOnly = false;
      showMessage("Password updated! You are now signed in.");
      setTimeout(closeAuth, 750);
    } else if (mode === "reset-password") {
      if (password.length < 8) {
        throw new Error("Your new password must be at least 8 characters long.");
      }
      if (password !== confirmPassword) {
        throw new Error("Passwords do not match. Please re-enter them carefully.");
      }
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      showMessage("Your password has been updated. You are now signed in.");
      setTimeout(closeAuth, 800);
    }
  } catch (err) {
    showMessage(err.message || "Authentication failed. Please try again.", true);
  } finally {
    submit.disabled = false;
    if (submit.textContent === "Please wait…") {
      submit.textContent = previousLabel;
    }
  }
});

// Google OAuth Sign-In
googleBtn?.addEventListener("click", async () => {
  try {
    if (!sessionStorage.getItem("arena_selected_role")) {
      setSelectedRole("voter");
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

// Listen for Supabase PASSWORD_RECOVERY event (when user clicks recovery link in email)
supabase.auth.onAuthStateChange((event) => {
  if (event === "PASSWORD_RECOVERY") {
    openAuth("reset-password");
    showMessage("Recovery verified. Enter your new password below.");
  }
});

if (
  window.location.hash.includes("type=recovery") ||
  new URLSearchParams(window.location.search).get("reset") === "1"
) {
  setTimeout(() => {
    openAuth("reset-password");
  }, 150);
}

setSelectedRole(sessionStorage.getItem("arena_selected_role") || "voter");
setMode("signin");
