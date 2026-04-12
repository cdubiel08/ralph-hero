const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");
const os = require("os");

// Create a fresh test DB
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "fts-bug-"));
const dbPath = path.join(testDir, "test.db");

// Create a fresh database
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

// Create basic schema like KnowledgeDB does
db.exec(`
  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    path TEXT,
    title TEXT,
    date TEXT,
    type TEXT,
    status TEXT,
    github_issue INTEGER,
    content TEXT,
    is_stub INTEGER DEFAULT 0
  );
`);

// Insert a test document
db.prepare(`
  INSERT INTO documents (id, path, title, date, type, status, content)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`).run("test-doc", "test.md", "Test Doc", "2026-04-03", "idea", "active", "searchable content");

// Now try to query the FTS table that doesn't exist
try {
  const results = db.prepare(`
    SELECT d.id FROM documents_fts
    JOIN documents d ON d.rowid = documents_fts.rowid
    WHERE documents_fts MATCH ?
  `).all("test");
  console.log("SUCCESS: Got results:", results);
} catch (err) {
  console.log("ERROR (bug confirmed):");
  console.log("  Message:", err.message);
  console.log("  Code:", err.code);
}

db.close();
fs.rmSync(testDir, { recursive: true });
