// Authentication, Email OTP, Forgot Password, Password Recovery, and Google OAuth for AI Project Arena
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
const resendOtpLink = document.getElementById("resendOtpLink");
const googleBtn = document.getElementById("googleSignIn");
const authDivider = document.getElementById("authDivider");

const tabs = [...document.querySelectorAll("[data-mode]")];
const roleButtons = [...document.querySelectorAll("[data-pick-role]")];

// Modes: "signin" | "signup" | "otp" | "otp-verify" | "forgot" | "reset-password"
let mode = "signin";
let otpTargetEmail = "";
let otpVerificationType = "email"; // "email" | "signup" | "recovery"

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
    subtitle.textContent = `Create your ${roleLabel} account. You will receive a verification link or OTP code.`;
  } else if (mode === "otp") {
    subtitle.textContent = `Receive a one-time 6-digit code in your email to sign in as ${roleLabel} without a password.`;
  } else if (mode === "otp-verify") {
    subtitle.textContent = `Enter the verification code sent to ${otpTargetEmail || "your email"}.`;
  } else if (mode === "forgot") {
    subtitle.textContent = "Enter your account email and we will send a password recovery link & code.";
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
  const isOtpRequest = mode === "otp";
  const isOtpVerify = mode === "otp-verify";
  const isForgot = mode === "forgot";
  const isReset = mode === "reset-password";

  tabs.forEach((b) => {
    const active = b.dataset.mode === mode || (isOtpVerify && b.dataset.mode === "otp");
    b.classList.toggle("active", active);
    b.setAttribute("aria-selected", String(active));
  });

  if (nameField) nameField.style.display = isSignup ? "" : "none";
  if (typeField) typeField.style.display = isSignup ? "" : "none";
  if (emailField) emailField.style.display = isReset ? "none" : "";
  if (emailInput) emailInput.required = !isReset;

  const showPassword = isSignin || isSignup || isReset;
  if (passwordField) passwordField.style.display = showPassword ? "" : "none";
  if (passwordInput) {
    passwordInput.required = showPassword;
    passwordInput.autocomplete = isSignin ? "current-password" : "new-password";
  }
  if (passwordLabelText) {
    passwordLabelText.textContent = isReset ? "New Password" : "Password";
  }

  if (confirmPasswordField) confirmPasswordField.style.display = isReset ? "" : "none";
  if (confirmPasswordInput) confirmPasswordInput.required = isReset;

  if (otpCodeField) otpCodeField.style.display = isOtpVerify ? "" : "none";
  if (otpCodeInput) otpCodeInput.required = isOtpVerify;

  if (forgotPasswordLink) {
    forgotPasswordLink.style.display = isSignin ? "" : "none";
  }
  if (resendOtpLink) {
    resendOtpLink.style.display = isOtpVerify ? "" : "none";
  }

  if (googleBtn) googleBtn.style.display = isReset || isOtpVerify ? "none" : "";
  if (authDivider) authDivider.style.display = isReset || isOtpVerify ? "none" : "";

  if (title) {
    if (isSignup) title.textContent = "Create your Arena account";
    else if (isOtpRequest) title.textContent = "Sign in with Email OTP";
    else if (isOtpVerify) title.textContent = "Verify your email code";
    else if (isForgot) title.textContent = "Reset your password";
    else if (isReset) title.textContent = "Set a new password";
    else title.textContent = "Welcome to the Arena";
  }

  if (submit) {
    if (isSignup) submit.textContent = "Create account";
    else if (isOtpRequest) submit.textContent = "Send verification code";
    else if (isOtpVerify) submit.textContent = "Verify code & continue";
    else if (isForgot) submit.textContent = "Send recovery email";
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
    if (next === "otp-verify") otpCodeInput?.focus();
    else if (next === "reset-password") passwordInput?.focus();
    else emailInput?.focus();
  }, 40);
}

export function closeAuth() {
  if (!modal) return;
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
}

// Expose openAuth globally so app.js can invoke it cleanly
window.openArenaAuth = openAuth;

// Role buttons inside modal
roleButtons.forEach((btn) => {
  btn.addEventListener("click", () => setSelectedRole(btn.dataset.pickRole));
});

// Trigger buttons across the page
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

// Forgot password link
forgotPasswordLink?.addEventListener("click", () => {
  setMode("forgot");
});

// Resend OTP code link
resendOtpLink?.addEventListener("click", async () => {
  const email = (emailInput?.value || otpTargetEmail || "").trim();
  if (!email) {
    setMode("otp");
    showMessage("Enter your email address first.", true);
    return;
  }
  resendOtpLink.disabled = true;
  try {
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: true,
        emailRedirectTo: ARENA_REDIRECT,
        data: { arena_role: getSelectedRole() },
      },
    });
    if (error) throw error;
    showMessage(`A fresh verification code was sent to ${email}.`);
  } catch (err) {
    showMessage(err.message || "Could not resend verification code.", true);
  } finally {
    resendOtpLink.disabled = false;
  }
});

// Main Form Submission Handler
form?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = (emailInput?.value || otpTargetEmail || "").trim();
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
      if (data.session) {
        showMessage("Account created and signed in.");
        setTimeout(closeAuth, 650);
      } else {
        otpTargetEmail = email;
        otpVerificationType = "signup";
        setMode("otp-verify");
        showMessage(
          "Account created! If your email contains a 6-digit code, enter it above — or click the confirmation link in your inbox."
        );
      }
    } else if (mode === "signin") {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      showMessage("Signed in successfully.");
      setTimeout(closeAuth, 550);
    } else if (mode === "otp") {
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: {
          shouldCreateUser: true,
          emailRedirectTo: ARENA_REDIRECT,
          data: { arena_role: arenaRole },
        },
      });
      if (error) throw error;
      otpTargetEmail = email;
      otpVerificationType = "email";
      setMode("otp-verify");
      showMessage(`Verification code / magic link sent to ${email}. Enter the 6-digit code or click the email link.`);
    } else if (mode === "otp-verify") {
      if (!otpToken || otpToken.length < 6) {
        throw new Error("Please enter the 6-digit verification code from your email.");
      }
      // Try verifying with the primary OTP type, falling back to 'email' or 'signup' if needed
      let verifyResult = await supabase.auth.verifyOtp({
        email: otpTargetEmail || email,
        token: otpToken,
        type: otpVerificationType,
      });
      if (verifyResult.error && otpVerificationType !== "email") {
        verifyResult = await supabase.auth.verifyOtp({
          email: otpTargetEmail || email,
          token: otpToken,
          type: "email",
        });
      }
      if (verifyResult.error) throw verifyResult.error;
      if (otpVerificationType === "recovery") {
        setMode("reset-password");
        showMessage("Code verified. Please enter your new password below.");
      } else {
        showMessage("Email verified! Opening your workspace…");
        setTimeout(closeAuth, 600);
      }
    } else if (mode === "forgot") {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: ARENA_REDIRECT + "?reset=1",
      });
      if (error) throw error;
      otpTargetEmail = email;
      otpVerificationType = "recovery";
      showMessage(
        `Password recovery instructions sent to ${email}. Click the link in your email to set a new password.`
      );
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

// Listen for Supabase PASSWORD_RECOVERY event (triggered when user clicks recovery link in email)
supabase.auth.onAuthStateChange((event) => {
  if (event === "PASSWORD_RECOVERY") {
    openAuth("reset-password");
    showMessage("Recovery link verified. Enter your new password below.");
  }
});

// Also check URL hash/query on load in case recovery redirect arrived with ?reset=1 or type=recovery
if (
  window.location.hash.includes("type=recovery") ||
  new URLSearchParams(window.location.search).get("reset") === "1"
) {
  setTimeout(() => {
    openAuth("reset-password");
  }, 150);
}

// Initialize default role and mode
setSelectedRole(sessionStorage.getItem("arena_selected_role") || "voter");
setMode("signin");
