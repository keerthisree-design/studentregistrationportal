const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const authScreen = $("#auth-screen");
const appScreen = $("#app-screen");
const tokenKey = "peachwood-session";
let token = localStorage.getItem(tokenKey) || "";
let currentUser = null;
let currentStudent = null;
let authMode = "login";
let toastTimer;

async function api(path, options = {}) {
  const headers = { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(path, { ...options, headers });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && token) {
      clearSession();
      showAuth();
    }
    throw new Error(data.error || "The request could not be completed.");
  }
  return data;
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 3000);
}

function clearSession() {
  token = "";
  currentUser = null;
  currentStudent = null;
  localStorage.removeItem(tokenKey);
}

function showAuth() {
  appScreen.classList.add("hidden");
  authScreen.classList.remove("hidden");
  $("#auth-error").textContent = "";
  setAuthMode("login");
}

function setAuthMode(mode) {
  authMode = mode;
  const registering = mode === "register";
  $("#name-field").classList.toggle("hidden", !registering);
  $("#extra-fields").classList.toggle("hidden", !registering);
  $("#auth-eyebrow").textContent = registering ? "YOUR STUDENT REGISTRATION" : "WELCOME BACK";
  $("#auth-title").textContent = registering ? "Start your student journey." : "Good to see you.";
  $("#auth-subtitle").textContent = registering
    ? "Create your student account and receive your own student ID."
    : "Sign in to view your student registration and profile.";
  $("#auth-submit").textContent = registering ? "Register as a student →" : "Sign in →";
  $("#switch-prompt").textContent = registering ? "Already registered?" : "New to Peachwood?";
  $("#switch-auth").textContent = registering ? "Sign in" : "Register as a student";
  $('input[name="password"]', $("#auth-form")).autocomplete = registering ? "new-password" : "current-password";
  $("#auth-error").textContent = "";
}

function initials(name) {
  return String(name || "S").trim().split(/\s+/).slice(0, 2).map((part) => part[0] || "").join("").toUpperCase();
}

function dateLabel(date) {
  if (!date) return "—";
  return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "long", day: "numeric" }).format(new Date(date));
}

function setStudentData(user, student) {
  currentUser = user;
  currentStudent = student;
  const name = student.name || "Student";
  const lettermark = initials(name);
  $("#sidebar-name").textContent = name;
  $("#sidebar-email").textContent = user.email;
  $("#sidebar-avatar").textContent = lettermark;
  $("#welcome-title").textContent = `Welcome back, ${name.split(/\s+/)[0]}.`;
  $("#profile-avatar").textContent = lettermark;
  $("#profile-name").textContent = name;
  $("#profile-student-id").textContent = `Student ID · ${student.studentId}`;
  $$(".top-avatar").forEach((element) => { element.textContent = lettermark; });

  $("#student-id").textContent = student.studentId;
  $("#student-program").textContent = student.program || "Not set";
  $("#student-year").textContent = student.year ? `Year ${student.year}` : "Not set";
  $("#registration-status").textContent = student.enrollmentStatus;
  $("#detail-name").textContent = name;
  $("#detail-email").textContent = user.email;
  $("#detail-phone").textContent = student.phone || "Not provided";
  $("#detail-registered").textContent = dateLabel(student.registeredAt);

  const form = $("#profile-form");
  for (const field of ["name", "phone", "program", "year"]) form.elements[field].value = student[field] ?? "";
  form.elements.email.value = user.email;
}

async function enterApp(user, student) {
  setStudentData(user, student);
  authScreen.classList.add("hidden");
  appScreen.classList.remove("hidden");
  $("#today-label").textContent = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" }).format(new Date());
  showView("overview");
}

function showView(view) {
  $$(".content-view").forEach((section) => section.classList.toggle("hidden", section.id !== `view-${view}`));
  $$(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  $("#page-crumb").textContent = view === "overview" ? "My overview" : "My profile";
}

$("#switch-auth").addEventListener("click", () => {
  setAuthMode(authMode === "login" ? "register" : "login");
  $("#auth-form").elements.email.focus();
});

$("#auth-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const body = Object.fromEntries(new FormData(event.currentTarget));
  $("#auth-error").textContent = "";
  $("#auth-submit").disabled = true;
  try {
    const result = await api(authMode === "register" ? "/api/auth/register" : "/api/auth/login", {
      method: "POST",
      body: JSON.stringify(body)
    });
    token = result.token;
    localStorage.setItem(tokenKey, token);
    await enterApp(result.user, result.student);
  } catch (error) {
    $("#auth-error").textContent = error.message;
  } finally {
    $("#auth-submit").disabled = false;
  }
});

$$("[data-view]").forEach((button) => button.addEventListener("click", () => showView(button.dataset.view)));

$("#profile-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  $("#profile-error").textContent = "";
  try {
    const result = await api("/api/student/profile", {
      method: "PUT",
      body: JSON.stringify(Object.fromEntries(new FormData(form)))
    });
    setStudentData(result.user, result.student);
    showToast("Your student details have been updated.");
  } catch (error) {
    $("#profile-error").textContent = error.message;
  }
});

$("#password-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  $("#password-error").textContent = "";
  try {
    await api("/api/auth/password", {
      method: "PUT",
      body: JSON.stringify(Object.fromEntries(new FormData(form)))
    });
    form.reset();
    showToast("Your password has been updated.");
  } catch (error) {
    $("#password-error").textContent = error.message;
  }
});

$("#logout-button").addEventListener("click", async () => {
  try {
    if (token) await api("/api/auth/logout", { method: "POST" });
  } catch (error) {
    showToast(error.message);
  } finally {
    clearSession();
    showAuth();
  }
});

if (token) {
  api("/api/auth/me")
    .then(({ user, student }) => enterApp(user, student))
    .catch(() => {
      clearSession();
      showAuth();
    });
} else {
  showAuth();
}
