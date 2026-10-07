# Peachwood Student Portal

A student-only self-service registration portal with a responsive peach-and-white interface. Every account belongs to one student: students can register, view their own student ID and registration details, update their profile, and change their password. There is no student directory or teacher-facing record-management interface.

## Run locally

Requires Node.js 18 or newer; there are no third-party runtime dependencies.

```powershell
npm start
```

Open `http://localhost:3000`. The local data file is created at `data/portal.json`. Set `DATA_FILE` to use another location:

```powershell
$env:DATA_FILE = "C:\path\to\portal.json"
npm start
```

Run the API and migration tests with `npm test`.

## Student domain model

- **User account** stores only the authentication identity: account ID, email, password hash, and creation time.
- **Student profile** is a one-to-one domain record linked to its account. It stores the unique student ID, name, phone, study program/year, registration status, and registration/update dates.
- **Session** stores a hash of a random bearer token, the owning account ID, and its expiry.

New students receive a unique `STU-YYYY-XXXXXX` ID and a `Registered` status when they create an account. Student IDs and registration dates are assigned by the server and are not editable from the profile.

The server migrates the previous file format on startup: each existing account becomes its own student profile, account-only fields are moved into that profile, and the old directory of independently managed student records is removed. Existing account IDs, emails, password hashes, and sessions are retained.

## Architecture

- `public/index.html`, `public/styles.css`, and `public/app.js` provide the student sign-in/registration, overview, and profile screens.
- `server.js` serves the UI and JSON REST API using Node's built-in HTTP and crypto modules.
- `data/portal.json` stores accounts, student profiles, and sessions. Passwords are hashed with `scrypt`; session tokens are stored as keyed hashes.
- Profile and account endpoints require a valid student session. Profile updates can only change the signed-in student's own record.

The JSON store is suitable for a small, single-instance deployment. For a multi-instance or high-volume system, replace file persistence with a managed database.

## API

Authenticated endpoints require `Authorization: Bearer <token>`. Registration and sign-in return `{ "token": "...", "user": { ... }, "student": { ... } }`. Send the token on subsequent requests. Sessions expire after seven days. Errors use `{ "error": "Description" }`.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Public service health check |
| `POST` | `/api/auth/register` | Register a student account and assign a student ID |
| `POST` | `/api/auth/login` | Sign in to a student account |
| `GET` | `/api/auth/me` | Return the signed-in account and student profile |
| `POST` | `/api/auth/logout` | Revoke the current session |
| `PUT` | `/api/auth/password` | Change the account password after verifying the current password |
| `GET` | `/api/student` | Return only the signed-in student's profile |
| `PUT` | `/api/student/profile` | Update the signed-in student's personal and study details |

Student registration example:

```json
{
  "name": "Jordan Lee",
  "email": "jordan@university.edu",
  "password": "a-unique-password",
  "program": "Environmental Science",
  "year": 2
}
```

Profile update example:

```json
{
  "name": "Jordan Lee",
  "email": "jordan@university.edu",
  "phone": "555-0100",
  "program": "Environmental Science",
  "year": 2
}
```

Names are limited to 80 characters, emails must be valid and at most 254 characters, passwords must be 8–128 characters, and study year must be an integer from 1 to 8 (or empty). Student profile update requests cannot change the assigned student ID, status, or registration date. The former `/api/students` directory endpoints are not available.

## Public cloud deployment

`render.yaml` is a Render Blueprint for a public Node web service. It configures the production environment, a generated session secret, health check, and persistent disk for the student-account data file.

1. Push this project to a public or private GitHub repository.
2. In Render, choose **New → Blueprint**, connect the repository, and apply `render.yaml`. Render provisions a public HTTPS URL; students can register for their own accounts.
3. Keep the service to one instance while using file-backed storage. Back up the mounted `/var/data` disk and move to a managed database before scaling to multiple instances.

The service listens on Render's `PORT` and binds to `0.0.0.0`. Production startup requires a `SESSION_SECRET` of at least 32 characters; the Blueprint generates one. Cloud deployment must be launched from the provider dashboard after publishing the source.
