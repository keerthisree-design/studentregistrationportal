const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createPortalServer } = require("../server");

const testSecret = "test-secret-that-is-at-least-thirty-two-characters";

async function startServer(dataFile) {
  const server = await createPortalServer({ dataFile, secret: testSecret });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const request = async (route, { token, ...options } = {}) => {
    const headers = {
      ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {})
    };
    const response = await fetch(`${baseUrl}${route}`, { ...options, headers });
    return { status: response.status, body: await response.json() };
  };
  return { server, request };
}

test("students register, access only their own profile, and manage their account", async (t) => {
  await assert.rejects(
    createPortalServer({ production: true, dataFile: path.join(os.tmpdir(), "peachwood-production-test.json") }),
    /SESSION_SECRET must contain at least 32 characters/
  );
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "peachwood-test-"));
  const dataFile = path.join(directory, "portal.json");
  let { server, request } = await startServer(dataFile);
  t.after(async () => {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });

  assert.deepEqual((await request("/api/health")).body, { status: "ok" });
  const home = await fetch(`http://127.0.0.1:${server.address().port}/`);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /STUDENT PORTAL/);
  assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/favicon.ico`)).status, 404);

  assert.equal((await request("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ name: "", email: "not-an-email", password: "short" })
  })).status, 400);
  assert.equal((await request("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ name: { value: "Jordan" }, email: "jordan@university.edu", password: "correct-horse" })
  })).status, 400);

  const registration = await request("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({
      name: "Jordan Lee",
      email: "JORDAN@university.edu",
      password: "correct-horse",
      program: "Design",
      year: 2
    })
  });
  assert.equal(registration.status, 201);
  assert.equal(registration.body.user.email, "jordan@university.edu");
  assert.equal(registration.body.student.name, "Jordan Lee");
  assert.match(registration.body.student.studentId, /^STU-\d{4}-[A-F0-9]{6}$/);
  assert.equal(registration.body.student.enrollmentStatus, "Registered");
  assert.equal("passwordHash" in registration.body.user, false);
  const token = registration.body.token;

  assert.equal((await request("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ name: "Jordan Lee", email: "jordan@university.edu", password: "correct-horse" })
  })).status, 409);
  assert.equal((await request("/api/auth/me")).status, 401);
  const me = await request("/api/auth/me", { token });
  assert.equal(me.body.student.studentId, registration.body.student.studentId);
  const ownStudent = await request("/api/student", { token });
  assert.equal(ownStudent.body.student.name, "Jordan Lee");
  assert.equal(ownStudent.body.student.userId, undefined);

  const wrongYear = await request("/api/student/profile", {
    method: "PUT",
    token,
    body: JSON.stringify({ name: "Jordan Lee", email: "jordan@university.edu", program: "Design", year: 9 })
  });
  assert.equal(wrongYear.status, 400);

  const other = await request("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ name: "Sam Student", email: "sam@university.edu", password: "another-password" })
  });
  assert.notEqual(other.body.student.studentId, registration.body.student.studentId);
  assert.equal((await request("/api/students", { token })).status, 404);
  assert.equal((await request("/api/profile", { method: "PUT", token, body: "{}" })).status, 404);

  const profile = await request("/api/student/profile", {
    method: "PUT",
    token,
    body: JSON.stringify({
      name: "Jordan L.",
      email: "jordan@university.edu",
      phone: "555-0100",
      program: "Environmental Science",
      year: 3
    })
  });
  assert.equal(profile.body.student.name, "Jordan L.");
  assert.equal(profile.body.student.phone, "555-0100");
  assert.equal(profile.body.student.program, "Environmental Science");
  assert.equal(profile.body.student.year, 3);
  assert.equal(profile.body.student.studentId, registration.body.student.studentId);
  assert.equal((await request("/api/student", { token: other.body.token })).body.student.name, "Sam Student");

  assert.equal((await request("/api/auth/password", {
    method: "PUT",
    token,
    body: JSON.stringify({ currentPassword: "wrong-password", newPassword: "new-secure-password" })
  })).status, 400);
  assert.equal((await request("/api/auth/password", {
    method: "PUT",
    token,
    body: JSON.stringify({ currentPassword: "correct-horse", newPassword: "new-secure-password" })
  })).status, 200);
  assert.equal((await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: "jordan@university.edu", password: "new-secure-password" })
  })).status, 200);
  assert.equal((await request("/api/auth/logout", { method: "POST", token })).status, 200);
  assert.equal((await request("/api/auth/me", { token })).status, 401);

  const stored = JSON.parse(await fs.readFile(dataFile, "utf8"));
  assert.equal("students" in stored, false);
  assert.equal(stored.studentProfiles.length, 2);

  await new Promise((resolve) => server.close(resolve));
  ({ server, request } = await startServer(dataFile));
  assert.equal((await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: "jordan@university.edu", password: "new-secure-password" })
  })).body.student.program, "Environmental Science");
});

test("legacy accounts become individual student profiles and teacher-created records are discarded", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "peachwood-migration-test-"));
  const dataFile = path.join(directory, "portal.json");
  await fs.writeFile(dataFile, JSON.stringify({
    users: [{
      id: "legacy-user",
      name: "Legacy Student",
      email: "legacy@university.edu",
      phone: "555-0142",
      program: "History",
      year: 4,
      createdAt: "2025-01-15T12:00:00.000Z",
      passwordHash: `${"ab".repeat(16)}:${"cd".repeat(64)}`
    }],
    students: [{ id: "old-directory-record", userId: "legacy-user", name: "Someone Else" }],
    sessions: []
  }));

  const { server, request } = await startServer(dataFile);
  t.after(async () => {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const saved = JSON.parse(await fs.readFile(dataFile, "utf8"));
  assert.equal("students" in saved, false);
  assert.equal(saved.studentProfiles.length, 1);
  assert.equal(saved.studentProfiles[0].name, "Legacy Student");
  assert.equal(saved.studentProfiles[0].program, "History");
  assert.equal(saved.studentProfiles[0].year, 4);
  assert.equal(saved.studentProfiles[0].enrollmentStatus, "Registered");
  assert.equal("name" in saved.users[0], false);
  assert.equal((await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: "legacy@university.edu", password: "wrong-password" })
  })).status, 401);
});
