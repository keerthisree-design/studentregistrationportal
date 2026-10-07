const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");

const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_DATA_FILE = path.join(__dirname, "data", "portal.json");
const PUBLIC_DIR = path.join(__dirname, "public");

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const newDatabase = () => ({ users: [], studentProfiles: [], sessions: [] });

function validateEmail(value) {
  if (typeof value !== "string") throw new HttpError(400, "Enter a valid email address.");
  const email = String(value || "").trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpError(400, "Enter a valid email address.");
  }
  return email;
}

function validateText(value, label, { required = false, max = 120 } = {}) {
  if (value === null || value === undefined) {
    if (required) throw new HttpError(400, `${label} is required.`);
    return "";
  }
  if (typeof value !== "string") throw new HttpError(400, `${label} must be text.`);
  const text = value.trim();
  if (required && !text) throw new HttpError(400, `${label} is required.`);
  if (text.length > max) throw new HttpError(400, `${label} must be ${max} characters or fewer.`);
  return text;
}

function validateYear(value) {
  if (value === "" || value === null || value === undefined) return "";
  if (typeof value !== "number" && typeof value !== "string") {
    throw new HttpError(400, "Study year must be a number between 1 and 8.");
  }
  const year = Number(value);
  if (!Number.isInteger(year) || year < 1 || year > 8) {
    throw new HttpError(400, "Study year must be a number between 1 and 8.");
  }
  return year;
}

function publicUser(user) {
  return { id: user.id, email: user.email, createdAt: user.createdAt };
}

function createStudentProfile(userId, details = {}) {
  const registeredAt = details.registeredAt || new Date().toISOString();
  const year = new Date(registeredAt).getUTCFullYear();
  const studentId = details.studentId || `STU-${year}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
  return {
    studentId,
    userId,
    name: details.name || "",
    phone: details.phone || "",
    program: details.program || "",
    year: details.year || "",
    enrollmentStatus: "Registered",
    registeredAt,
    updatedAt: details.updatedAt || registeredAt
  };
}

function publicStudent(student) {
  const { userId, ...profile } = student;
  return profile;
}

function createPasswordHash(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(password, salt, 64, (error, derivedKey) => {
      if (error) return reject(error);
      resolve(`${salt.toString("hex")}:${derivedKey.toString("hex")}`);
    });
  });
}

function verifyPassword(password, storedHash) {
  const [saltHex, keyHex] = storedHash.split(":");
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(keyHex, "hex");
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, expected.length, (error, actual) => {
      if (error) return reject(error);
      resolve(actual.length === expected.length && crypto.timingSafeEqual(actual, expected));
    });
  });
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request body is too large.");
    chunks.push(chunk);
  }
  if (!size) return {};
  const contentType = String(request.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new HttpError(415, "Content-Type must be application/json.");
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Request body must contain valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "Request body must be a JSON object.");
  }
  return value;
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(payload));
}

function safeStaticPath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    throw new HttpError(400, "Invalid URL path.");
  }
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const resolved = path.resolve(PUBLIC_DIR, relative);
  if (!resolved.startsWith(`${PUBLIC_DIR}${path.sep}`) && resolved !== PUBLIC_DIR) {
    throw new HttpError(403, "Forbidden.");
  }
  return resolved;
}

async function createPortalServer(options = {}) {
  const dataFile = options.dataFile || process.env.DATA_FILE || DEFAULT_DATA_FILE;
  const publicDir = options.publicDir || PUBLIC_DIR;
  const production = options.production === true || process.env.NODE_ENV === "production";
  const configuredSecret = options.secret || process.env.SESSION_SECRET || "";
  if (production && configuredSecret.length < 32) {
    throw new Error("SESSION_SECRET must contain at least 32 characters in production.");
  }
  const secret = configuredSecret || "local-development-session-secret";
  const hashSessionToken = (token) => crypto.createHmac("sha256", secret).update(token).digest("hex");

  let database = newDatabase();
  try {
    const saved = JSON.parse(await fs.readFile(dataFile, "utf8"));
    const legacyUsers = Array.isArray(saved.users) ? saved.users : [];
    const studentProfiles = Array.isArray(saved.studentProfiles) ? saved.studentProfiles : [];
    const profileUserIds = new Set(studentProfiles.map((student) => student.userId));
    for (const legacyUser of legacyUsers) {
      if (!profileUserIds.has(legacyUser.id)) {
        studentProfiles.push(createStudentProfile(legacyUser.id, legacyUser));
      }
    }
    database = {
      users: legacyUsers.map(({ id, email, createdAt, passwordHash }) => ({ id, email, createdAt, passwordHash })),
      studentProfiles,
      sessions: Array.isArray(saved.sessions) ? saved.sessions : []
    };
    if (!Array.isArray(saved.studentProfiles) || Array.isArray(saved.students) ||
        legacyUsers.some((user) => "name" in user || "program" in user || "phone" in user || "year" in user)) {
      const snapshot = JSON.stringify(database, null, 2);
      await fs.mkdir(path.dirname(dataFile), { recursive: true });
      await fs.writeFile(dataFile, snapshot, { mode: 0o600 });
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error(`Could not load portal data: ${error.message}`);
  }

  let writeQueue = Promise.resolve();
  const persist = () => {
    const snapshot = JSON.stringify(database, null, 2);
    writeQueue = writeQueue.then(async () => {
      await fs.mkdir(path.dirname(dataFile), { recursive: true });
      const temporaryFile = `${dataFile}.${crypto.randomUUID()}.tmp`;
      await fs.writeFile(temporaryFile, snapshot, { mode: 0o600 });
      await fs.rename(temporaryFile, dataFile);
    });
    return writeQueue;
  };

  const makeSession = async (user, response, status = 200) => {
    const token = crypto.randomBytes(32).toString("base64url");
    database.sessions.push({
      id: crypto.randomUUID(),
      userId: user.id,
      tokenHash: hashSessionToken(token),
      expiresAt: Date.now() + SESSION_DURATION_MS
    });
    await persist();
    sendJson(response, status, {
      token,
      user: publicUser(user),
      student: publicStudent(database.studentProfiles.find((student) => student.userId === user.id))
    });
  };

  const requireUser = (request) => {
    const authorization = request.headers.authorization || "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!token) throw new HttpError(401, "Please sign in to continue.");
    const tokenHash = hashSessionToken(token);
    const session = database.sessions.find((item) => item.tokenHash === tokenHash);
    if (!session || session.expiresAt <= Date.now()) {
      if (session) database.sessions = database.sessions.filter((item) => item.id !== session.id);
      throw new HttpError(401, "Your session has expired. Please sign in again.");
    }
    const user = database.users.find((item) => item.id === session.userId);
    if (!user) throw new HttpError(401, "Your session is no longer valid. Please sign in again.");
    return user;
  };

  const server = http.createServer(async (request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
    const url = new URL(request.url, "http://localhost");
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    try {
      if (pathname === "/api/health" && request.method === "GET") {
        return sendJson(response, 200, { status: "ok" });
      }

      if (pathname === "/api/auth/register" && request.method === "POST") {
        const body = await readJsonBody(request);
        const name = validateText(body.name, "Name", { required: true, max: 80 });
        const email = validateEmail(body.email);
        if (typeof body.password !== "string" || body.password.length < 8 || body.password.length > 128) {
          throw new HttpError(400, "Password must be between 8 and 128 characters.");
        }
        if (database.users.some((user) => user.email === email)) {
          throw new HttpError(409, "An account with this email already exists.");
        }
        const user = {
          id: crypto.randomUUID(),
          email,
          createdAt: new Date().toISOString(),
          passwordHash: await createPasswordHash(body.password)
        };
        const student = createStudentProfile(user.id, {
          name,
          phone: validateText(body.phone, "Phone", { max: 30 }),
          program: validateText(body.program, "Program", { max: 100 }),
          year: validateYear(body.year)
        });
        database.users.push(user);
        database.studentProfiles.push(student);
        await makeSession(user, response, 201);
        return;
      }

      if (pathname === "/api/auth/login" && request.method === "POST") {
        const body = await readJsonBody(request);
        const email = validateEmail(body.email);
        if (typeof body.password !== "string" || body.password.length > 128) {
          throw new HttpError(401, "Email or password is incorrect.");
        }
        const user = database.users.find((item) => item.email === email);
        if (!user || !(await verifyPassword(String(body.password || ""), user.passwordHash))) {
          throw new HttpError(401, "Email or password is incorrect.");
        }
        await makeSession(user, response);
        return;
      }

      if (pathname.startsWith("/api/")) {
        const user = requireUser(request);
        if (pathname === "/api/auth/me" && request.method === "GET") {
          return sendJson(response, 200, {
            user: publicUser(user),
            student: publicStudent(database.studentProfiles.find((student) => student.userId === user.id))
          });
        }
        if (pathname === "/api/auth/logout" && request.method === "POST") {
          const token = request.headers.authorization.slice(7);
          const tokenHash = hashSessionToken(token);
          database.sessions = database.sessions.filter((item) => item.tokenHash !== tokenHash);
          await persist();
          return sendJson(response, 200, { message: "You have been signed out." });
        }
        if (pathname === "/api/student" && request.method === "GET") {
          const student = database.studentProfiles.find((item) => item.userId === user.id);
          if (!student) throw new HttpError(404, "Student profile not found.");
          return sendJson(response, 200, { student: publicStudent(student) });
        }
        if (pathname === "/api/student/profile" && request.method === "PUT") {
          const body = await readJsonBody(request);
          const name = validateText(body.name, "Name", { required: true, max: 80 });
          const email = validateEmail(body.email);
          if (database.users.some((item) => item.email === email && item.id !== user.id)) {
            throw new HttpError(409, "An account with this email already exists.");
          }
          const student = database.studentProfiles.find((item) => item.userId === user.id);
          if (!student) throw new HttpError(404, "Student profile not found.");
          user.email = email;
          Object.assign(student, {
            name,
            phone: validateText(body.phone, "Phone", { max: 30 }),
            program: validateText(body.program, "Program", { max: 100 }),
            year: validateYear(body.year),
            updatedAt: new Date().toISOString()
          });
          await persist();
          return sendJson(response, 200, { user: publicUser(user), student: publicStudent(student) });
        }
        if (pathname === "/api/auth/password" && request.method === "PUT") {
          const body = await readJsonBody(request);
          if (!(await verifyPassword(String(body.currentPassword || ""), user.passwordHash))) {
            throw new HttpError(400, "Current password is incorrect.");
          }
          if (typeof body.newPassword !== "string" || body.newPassword.length < 8 || body.newPassword.length > 128) {
            throw new HttpError(400, "New password must be between 8 and 128 characters.");
          }
          user.passwordHash = await createPasswordHash(body.newPassword);
          await persist();
          return sendJson(response, 200, { message: "Password updated successfully." });
        }
        throw new HttpError(404, "API endpoint not found.");
      }

      if (request.method !== "GET" && request.method !== "HEAD") throw new HttpError(404, "Page not found.");
      let filePath;
      try {
        filePath = safeStaticPath(pathname);
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(400, "Invalid URL path.");
      }
      const relativeFile = path.relative(PUBLIC_DIR, filePath);
      const finalFilePath = path.join(publicDir, relativeFile);
      let contents;
      try {
        contents = await fs.readFile(finalFilePath);
      } catch (error) {
        if (error.code === "ENOENT" || error.code === "EISDIR") throw new HttpError(404, "Page not found.");
        throw error;
      }
      const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" };
      response.writeHead(200, { "Content-Type": types[path.extname(finalFilePath)] || "application/octet-stream" });
      response.end(request.method === "HEAD" ? undefined : contents);
    } catch (error) {
      if (error instanceof HttpError) return sendJson(response, error.status, { error: error.message });
      console.error("Request failed:", error);
      if (!response.headersSent) sendJson(response, 500, { error: "Something went wrong. Please try again." });
      else response.destroy();
    }
  });

  return server;
}

if (require.main === module) {
  createPortalServer().then((server) => {
    const port = Number(process.env.PORT || 3000);
    server.listen(port, "0.0.0.0", () => console.log(`Student portal listening on port ${port}`));
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { createPortalServer };
