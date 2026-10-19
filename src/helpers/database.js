const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const debugLogger = require("./debugLogger");
const { app } = require("electron");

class DatabaseManager {
  constructor() {
    this.db = null;
    this.initDatabase();
  }

  initDatabase() {
    try {
      const dbFileName =
        process.env.NODE_ENV === "development" ? "transcriptions-dev.db" : "transcriptions.db";

      const dbPath = path.join(app.getPath("userData"), dbFileName);

      this.db = new Database(dbPath);
      this.db.pragma("journal_mode = WAL");

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS transcriptions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          text TEXT NOT NULL,
          timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS transcriptions_timestamp_id
        ON transcriptions (timestamp DESC, id DESC)
      `);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS custom_dictionary (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          word TEXT NOT NULL UNIQUE,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS notes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL DEFAULT 'Untitled Note',
          content TEXT NOT NULL DEFAULT '',
          note_type TEXT NOT NULL DEFAULT 'personal',
          source_file TEXT,
          audio_duration_seconds REAL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN enhanced_content TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN enhancement_prompt TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN enhanced_at_content_hash TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS folders (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          is_default INTEGER NOT NULL DEFAULT 0,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      const folderCount = this.db.prepare("SELECT COUNT(*) as count FROM folders").get();
      if (folderCount.count === 0) {
        const seedFolder = this.db.prepare(
          "INSERT INTO folders (name, is_default, sort_order) VALUES (?, 1, ?)"
        );
        seedFolder.run("Personal", 0);
        seedFolder.run("Meetings", 1);
      }

      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN folder_id INTEGER REFERENCES folders(id)");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      const personalFolder = this.db
        .prepare("SELECT id FROM folders WHERE name = 'Personal' AND is_default = 1")
        .get();
      if (personalFolder) {
        this.db
          .prepare("UPDATE notes SET folder_id = ? WHERE folder_id IS NULL")
          .run(personalFolder.id);
      }

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS actions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          prompt TEXT NOT NULL,
          icon TEXT NOT NULL DEFAULT 'sparkles',
          is_builtin INTEGER NOT NULL DEFAULT 0,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      try {
        this.db.exec("ALTER TABLE actions ADD COLUMN translation_key TEXT");
      } catch (err) {
        if (!err.message.includes("duplicate column")) throw err;
      }

      const actionCount = this.db.prepare("SELECT COUNT(*) as count FROM actions").get();
      if (actionCount.count === 0) {
        this.db
          .prepare(
            "INSERT INTO actions (name, description, prompt, icon, is_builtin, sort_order, translation_key) VALUES (?, ?, ?, ?, 1, 0, ?)"
          )
          .run(
            "Clean Up Notes",
            "Fix grammar, structure, and formatting",
            "Clean up grammar, improve structure, and format these notes for readability while preserving all original meaning.",
            "sparkles",
            "notes.actions.builtin.cleanupNotes"
          );
      }

      this.db
        .prepare(
          "UPDATE actions SET translation_key = ? WHERE is_builtin = 1 AND name = ? AND translation_key IS NULL"
        )
        .run("notes.actions.builtin.cleanupNotes", "Clean Up Notes");

      // ScottySpeaks: Usage stats table
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS usage_stats (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          date TEXT NOT NULL UNIQUE,
          word_count INTEGER NOT NULL DEFAULT 0,
          dictation_count INTEGER NOT NULL DEFAULT 0,
          total_duration_seconds REAL NOT NULL DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // ScottySpeaks: Snippets table
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS snippets (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          keyword TEXT NOT NULL UNIQUE COLLATE NOCASE,
          expansion TEXT NOT NULL,
          use_count INTEGER NOT NULL DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // ScottySpeaks: Style profiles table
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS style_profiles (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          rules TEXT NOT NULL DEFAULT '{}',
          is_active INTEGER NOT NULL DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // The dictionary's UNIQUE constraint is case-sensitive, so "Aravo" and
      // "aravo" could both be stored — teaching the polish pass two different
      // spellings of the same term. Collapse duplicates (preferring the
      // capitalized form) and enforce case-insensitive uniqueness from here on.
      try {
        const dupes = this.db
          .prepare(
            `SELECT lower(word) AS key, COUNT(*) AS n FROM custom_dictionary
             GROUP BY lower(word) HAVING n > 1`
          )
          .all();
        for (const { key } of dupes) {
          const variants = this.db
            .prepare("SELECT id, word FROM custom_dictionary WHERE lower(word) = ? ORDER BY id ASC")
            .all(key);
          // Prefer a spelling that contains an uppercase letter
          const keeper =
            variants.find((v) => /[A-Z]/.test(v.word)) || variants[0];
          for (const v of variants) {
            if (v.id !== keeper.id) {
              this.db.prepare("DELETE FROM custom_dictionary WHERE id = ?").run(v.id);
            }
          }
          debugLogger.info(
            "Merged case-duplicate dictionary entries",
            { kept: keeper.word, removed: variants.length - 1 },
            "database"
          );
        }
        this.db.exec(
          "CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_dictionary_word_nocase ON custom_dictionary (word COLLATE NOCASE)"
        );
      } catch (e) {
        debugLogger.warn("Dictionary dedupe migration failed", { error: e.message }, "database");
      }

      // raw_text: the pre-polish transcript, kept so user edits can teach the
      // polish pass (raw → preferred output pairs)
      try {
        const cols = this.db.prepare("PRAGMA table_info(transcriptions)").all();
        if (!cols.some((c) => c.name === "raw_text")) {
          this.db.exec("ALTER TABLE transcriptions ADD COLUMN raw_text TEXT");
        }
      } catch (e) {
        debugLogger.warn("raw_text migration failed", { error: e.message }, "database");
      }

      // Learned style examples: before/after pairs harvested from the user's
      // edits, injected as few-shot context into the polish prompt
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS style_examples (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          before_text TEXT NOT NULL,
          after_text TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'history-edit',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Seed default style profiles
      const profileCount = this.db.prepare("SELECT COUNT(*) as count FROM style_profiles").get();
      if (profileCount.count === 0) {
        const seedProfile = this.db.prepare(
          "INSERT INTO style_profiles (name, rules, is_active) VALUES (?, ?, ?)"
        );
        seedProfile.run("Casual", JSON.stringify({
          removeFillers: true,
          capitalization: "sentence",
          autoPunctuation: true,
          formality: "casual",
          instructions:
            "Keep it relaxed and conversational. Contractions are fine. Short sentences over long ones. No sign-offs unless spoken.",
        }), 1);
        seedProfile.run("Professional", JSON.stringify({
          removeFillers: true,
          capitalization: "sentence",
          autoPunctuation: true,
          formality: "formal",
          instructions:
            "Polished business tone. Complete sentences, no slang. Keep it concise and direct.",
        }), 0);
        seedProfile.run("Email", JSON.stringify({
          removeFillers: true,
          capitalization: "sentence",
          autoPunctuation: true,
          formality: "formal",
          greeting: "Hi,",
          signoff: "Best,\nScott",
          instructions:
            "Format as an email: greeting line, short paragraphs separated by blank lines, sign-off on its own line if one was spoken.",
        }), 0);
        seedProfile.run("Raw", JSON.stringify({
          removeFillers: false,
          capitalization: "none",
          autoPunctuation: false,
          formality: "none",
          aiPolish: false,
          instructions: "",
        }), 0);
      } else {
        // One-time upgrade for existing installs: give the seeded profiles AI
        // instructions (and mark "Raw" as bypassing AI polish) without
        // touching profiles the user customized.
        const known = {
          Casual:
            "Keep it relaxed and conversational. Contractions are fine. Short sentences over long ones. No sign-offs unless spoken.",
          Professional:
            "Polished business tone. Complete sentences, no slang. Keep it concise and direct.",
          Email:
            "Format as an email: greeting line, short paragraphs separated by blank lines, sign-off on its own line if one was spoken.",
          Raw: "",
        };
        const rows = this.db.prepare("SELECT id, name, rules FROM style_profiles").all();
        const update = this.db.prepare("UPDATE style_profiles SET rules = ? WHERE id = ?");
        for (const row of rows) {
          if (!(row.name in known)) continue;
          let rules;
          try {
            rules = JSON.parse(row.rules || "{}");
          } catch {
            continue;
          }
          if (rules.instructions !== undefined) continue;
          rules.instructions = known[row.name];
          if (row.name === "Raw" && rules.aiPolish === undefined) rules.aiPolish = false;
          update.run(JSON.stringify(rules), row.id);
        }
      }

      return true;
    } catch (error) {
      debugLogger.error("Database initialization failed", { error: error.message }, "database");
      throw error;
    }
  }

  saveTranscription(text, rawText = null) {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      const stmt = this.db.prepare("INSERT INTO transcriptions (text, raw_text) VALUES (?, ?)");
      const result = stmt.run(text, rawText && rawText !== text ? rawText : null);

      const fetchStmt = this.db.prepare("SELECT * FROM transcriptions WHERE id = ?");
      const transcription = fetchStmt.get(result.lastInsertRowid);

      return { id: result.lastInsertRowid, success: true, transcription };
    } catch (error) {
      debugLogger.error("Error saving transcription", { error: error.message }, "database");
      throw error;
    }
  }

  updateTranscription(id, text) {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      this.db.prepare("UPDATE transcriptions SET text = ? WHERE id = ?").run(text, id);
      const transcription = this.db.prepare("SELECT * FROM transcriptions WHERE id = ?").get(id);
      return { success: !!transcription, transcription };
    } catch (error) {
      debugLogger.error("Error updating transcription", { error: error.message }, "database");
      throw error;
    }
  }

  getTranscriptions(limit = 50) {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      const stmt = this.db.prepare(
        "SELECT * FROM transcriptions ORDER BY timestamp DESC, id DESC LIMIT ?"
      );
      const transcriptions = stmt.all(limit);
      return transcriptions;
    } catch (error) {
      debugLogger.error("Error getting transcriptions", { error: error.message }, "database");
      throw error;
    }
  }

  queryTranscriptions(options = {}) {
    if (!this.db) throw new Error("Database not initialized");
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new Error("Invalid history query");
    }
    const { query = "", limit = 50, cursor = null } = options;
    if (typeof query !== "string" || query.length > 500) {
      throw new Error("History search must be at most 500 characters");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("History page size must be between 1 and 100");
    }
    const conditions = [];
    const parameters = [];
    const search = query.trim();
    if (search) {
      // Search literal text, including SQL LIKE metacharacters in dictated code.
      const pattern = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
      conditions.push("(text LIKE ? ESCAPE '\\' OR raw_text LIKE ? ESCAPE '\\')");
      parameters.push(pattern, pattern);
    }
    if (cursor !== null) {
      if (
        !cursor ||
        typeof cursor.timestamp !== "string" ||
        cursor.timestamp.length > 64 ||
        !Number.isSafeInteger(cursor.id) ||
        cursor.id < 1
      ) {
        throw new Error("Invalid history cursor");
      }
      conditions.push("(timestamp < ? OR (timestamp = ? AND id < ?))");
      parameters.push(cursor.timestamp, cursor.timestamp, cursor.id);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM transcriptions ${where} ORDER BY timestamp DESC, id DESC LIMIT ?`)
      .all(...parameters, limit + 1);
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    return {
      items,
      hasMore,
      nextCursor: hasMore && last ? { timestamp: last.timestamp, id: last.id } : null,
    };
  }

  clearTranscriptions() {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      const stmt = this.db.prepare("DELETE FROM transcriptions");
      const result = stmt.run();
      return { cleared: result.changes, success: true };
    } catch (error) {
      debugLogger.error("Error clearing transcriptions", { error: error.message }, "database");
      throw error;
    }
  }

  deleteTranscription(id) {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      const stmt = this.db.prepare("DELETE FROM transcriptions WHERE id = ?");
      const result = stmt.run(id);
      return { success: result.changes > 0, id };
    } catch (error) {
      debugLogger.error("Error deleting transcription", { error: error.message }, "database");
      throw error;
    }
  }

  getDictionary() {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      const stmt = this.db.prepare("SELECT word FROM custom_dictionary ORDER BY id ASC");
      const rows = stmt.all();
      return rows.map((row) => row.word);
    } catch (error) {
      debugLogger.error("Error getting dictionary", { error: error.message }, "database");
      throw error;
    }
  }

  setDictionary(words) {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      const transaction = this.db.transaction((wordList) => {
        this.db.prepare("DELETE FROM custom_dictionary").run();
        const insert = this.db.prepare("INSERT OR IGNORE INTO custom_dictionary (word) VALUES (?)");
        for (const word of wordList) {
          const trimmed = typeof word === "string" ? word.trim() : "";
          if (trimmed) {
            insert.run(trimmed);
          }
        }
      });
      transaction(words);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error setting dictionary", { error: error.message }, "database");
      throw error;
    }
  }

  saveNote(
    title,
    content,
    noteType = "personal",
    sourceFile = null,
    audioDuration = null,
    folderId = null
  ) {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      if (!folderId) {
        const personal = this.db
          .prepare("SELECT id FROM folders WHERE name = 'Personal' AND is_default = 1")
          .get();
        folderId = personal?.id || null;
      }
      const stmt = this.db.prepare(
        "INSERT INTO notes (title, content, note_type, source_file, audio_duration_seconds, folder_id) VALUES (?, ?, ?, ?, ?, ?)"
      );
      const result = stmt.run(title, content, noteType, sourceFile, audioDuration, folderId);

      const fetchStmt = this.db.prepare("SELECT * FROM notes WHERE id = ?");
      const note = fetchStmt.get(result.lastInsertRowid);

      return { success: true, note };
    } catch (error) {
      debugLogger.error("Error saving note", { error: error.message }, "notes");
      throw error;
    }
  }

  getNote(id) {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      const stmt = this.db.prepare("SELECT * FROM notes WHERE id = ?");
      return stmt.get(id) || null;
    } catch (error) {
      debugLogger.error("Error getting note", { error: error.message }, "notes");
      throw error;
    }
  }

  getNotes(noteType = null, limit = 100, folderId = null) {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      const conditions = [];
      const params = [];
      if (noteType) {
        conditions.push("note_type = ?");
        params.push(noteType);
      }
      if (folderId) {
        conditions.push("folder_id = ?");
        params.push(folderId);
      }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const stmt = this.db.prepare(`SELECT * FROM notes ${where} ORDER BY updated_at DESC LIMIT ?`);
      params.push(limit);
      return stmt.all(...params);
    } catch (error) {
      debugLogger.error("Error getting notes", { error: error.message }, "notes");
      throw error;
    }
  }

  updateNote(id, updates) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const allowedFields = [
        "title",
        "content",
        "enhanced_content",
        "enhancement_prompt",
        "enhanced_at_content_hash",
        "folder_id",
      ];
      const fields = [];
      const values = [];
      for (const [key, value] of Object.entries(updates)) {
        if (allowedFields.includes(key) && value !== undefined) {
          fields.push(`${key} = ?`);
          values.push(value);
        }
      }
      if (fields.length === 0) return { success: false };
      fields.push("updated_at = CURRENT_TIMESTAMP");
      values.push(id);
      const stmt = this.db.prepare(`UPDATE notes SET ${fields.join(", ")} WHERE id = ?`);
      stmt.run(...values);
      const fetchStmt = this.db.prepare("SELECT * FROM notes WHERE id = ?");
      const note = fetchStmt.get(id);
      return { success: true, note };
    } catch (error) {
      debugLogger.error("Error updating note", { error: error.message }, "notes");
      throw error;
    }
  }

  getFolders() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db.prepare("SELECT * FROM folders ORDER BY sort_order ASC, created_at ASC").all();
    } catch (error) {
      debugLogger.error("Error getting folders", { error: error.message }, "notes");
      throw error;
    }
  }

  createFolder(name) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const trimmed = (name || "").trim();
      if (!trimmed) return { success: false, error: "Folder name is required" };
      const existing = this.db.prepare("SELECT id FROM folders WHERE name = ?").get(trimmed);
      if (existing) return { success: false, error: "A folder with that name already exists" };
      const maxOrder = this.db.prepare("SELECT MAX(sort_order) as max_order FROM folders").get();
      const sortOrder = (maxOrder?.max_order ?? 0) + 1;
      const result = this.db
        .prepare("INSERT INTO folders (name, sort_order) VALUES (?, ?)")
        .run(trimmed, sortOrder);
      const folder = this.db
        .prepare("SELECT * FROM folders WHERE id = ?")
        .get(result.lastInsertRowid);
      return { success: true, folder };
    } catch (error) {
      debugLogger.error("Error creating folder", { error: error.message }, "notes");
      throw error;
    }
  }

  deleteFolder(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const folder = this.db.prepare("SELECT * FROM folders WHERE id = ?").get(id);
      if (!folder) return { success: false, error: "Folder not found" };
      if (folder.is_default) return { success: false, error: "Cannot delete default folders" };
      const personal = this.db
        .prepare("SELECT id FROM folders WHERE name = 'Personal' AND is_default = 1")
        .get();
      if (personal) {
        this.db.prepare("UPDATE notes SET folder_id = ? WHERE folder_id = ?").run(personal.id, id);
      }
      this.db.prepare("DELETE FROM folders WHERE id = ?").run(id);
      return { success: true, id };
    } catch (error) {
      debugLogger.error("Error deleting folder", { error: error.message }, "notes");
      throw error;
    }
  }

  renameFolder(id, name) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const folder = this.db.prepare("SELECT * FROM folders WHERE id = ?").get(id);
      if (!folder) return { success: false, error: "Folder not found" };
      if (folder.is_default) return { success: false, error: "Cannot rename default folders" };
      const trimmed = (name || "").trim();
      if (!trimmed) return { success: false, error: "Folder name is required" };
      const existing = this.db
        .prepare("SELECT id FROM folders WHERE name = ? AND id != ?")
        .get(trimmed, id);
      if (existing) return { success: false, error: "A folder with that name already exists" };
      this.db.prepare("UPDATE folders SET name = ? WHERE id = ?").run(trimmed, id);
      const updated = this.db.prepare("SELECT * FROM folders WHERE id = ?").get(id);
      return { success: true, folder: updated };
    } catch (error) {
      debugLogger.error("Error renaming folder", { error: error.message }, "notes");
      throw error;
    }
  }

  getFolderNoteCounts() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db
        .prepare("SELECT folder_id, COUNT(*) as count FROM notes GROUP BY folder_id")
        .all();
    } catch (error) {
      debugLogger.error("Error getting folder note counts", { error: error.message }, "notes");
      throw error;
    }
  }

  getActions() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db.prepare("SELECT * FROM actions ORDER BY sort_order ASC, created_at ASC").all();
    } catch (error) {
      debugLogger.error("Error getting actions", { error: error.message }, "notes");
      throw error;
    }
  }

  getAction(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db.prepare("SELECT * FROM actions WHERE id = ?").get(id) || null;
    } catch (error) {
      debugLogger.error("Error getting action", { error: error.message }, "notes");
      throw error;
    }
  }

  createAction(name, description, prompt, icon = "sparkles") {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const trimmedName = (name || "").trim();
      const trimmedPrompt = (prompt || "").trim();
      if (!trimmedName) return { success: false, error: "Action name is required" };
      if (!trimmedPrompt) return { success: false, error: "Action prompt is required" };
      const maxOrder = this.db.prepare("SELECT MAX(sort_order) as max_order FROM actions").get();
      const sortOrder = (maxOrder?.max_order ?? 0) + 1;
      const result = this.db
        .prepare(
          "INSERT INTO actions (name, description, prompt, icon, sort_order) VALUES (?, ?, ?, ?, ?)"
        )
        .run(trimmedName, (description || "").trim(), trimmedPrompt, icon || "sparkles", sortOrder);
      const action = this.db
        .prepare("SELECT * FROM actions WHERE id = ?")
        .get(result.lastInsertRowid);
      return { success: true, action };
    } catch (error) {
      debugLogger.error("Error creating action", { error: error.message }, "notes");
      throw error;
    }
  }

  updateAction(id, updates) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const allowedFields = ["name", "description", "prompt", "icon", "sort_order"];
      const fields = [];
      const values = [];
      for (const [key, value] of Object.entries(updates)) {
        if (allowedFields.includes(key) && value !== undefined) {
          fields.push(`${key} = ?`);
          values.push(value);
        }
      }
      if (fields.length === 0) return { success: false };
      fields.push("updated_at = CURRENT_TIMESTAMP");
      values.push(id);
      this.db.prepare(`UPDATE actions SET ${fields.join(", ")} WHERE id = ?`).run(...values);
      const action = this.db.prepare("SELECT * FROM actions WHERE id = ?").get(id);
      return { success: true, action };
    } catch (error) {
      debugLogger.error("Error updating action", { error: error.message }, "notes");
      throw error;
    }
  }

  deleteAction(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const action = this.db.prepare("SELECT * FROM actions WHERE id = ?").get(id);
      if (!action) return { success: false, error: "Action not found" };
      if (action.is_builtin) return { success: false, error: "Cannot delete built-in actions" };
      this.db.prepare("DELETE FROM actions WHERE id = ?").run(id);
      return { success: true, id };
    } catch (error) {
      debugLogger.error("Error deleting action", { error: error.message }, "notes");
      throw error;
    }
  }

  deleteNote(id) {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      const stmt = this.db.prepare("DELETE FROM notes WHERE id = ?");
      const result = stmt.run(id);
      return { success: result.changes > 0, id };
    } catch (error) {
      debugLogger.error("Error deleting note", { error: error.message }, "notes");
      throw error;
    }
  }

  // === Usage Stats ===

  recordUsage(wordCount, durationSeconds) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const today = new Date().toISOString().split("T")[0];
      this.db
        .prepare(
          `INSERT INTO usage_stats (date, word_count, dictation_count, total_duration_seconds)
           VALUES (?, ?, 1, ?)
           ON CONFLICT(date) DO UPDATE SET
             word_count = word_count + excluded.word_count,
             dictation_count = dictation_count + 1,
             total_duration_seconds = total_duration_seconds + excluded.total_duration_seconds`
        )
        .run(today, wordCount, durationSeconds);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error recording usage", { error: error.message }, "database");
      return { success: false };
    }
  }

  getUsageStats() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const row = this.db
        .prepare(
          `SELECT
             COUNT(DISTINCT date) as total_days,
             COALESCE(SUM(word_count), 0) as total_words,
             COALESCE(SUM(dictation_count), 0) as total_dictations,
             COALESCE(SUM(total_duration_seconds), 0) as total_duration_seconds
           FROM usage_stats`
        )
        .get();
      const avgWpm =
        row.total_duration_seconds > 0
          ? Math.round(row.total_words / (row.total_duration_seconds / 60))
          : 0;
      return {
        totalDays: row.total_days,
        totalWords: row.total_words,
        totalDictations: row.total_dictations,
        averageWpm: avgWpm,
      };
    } catch (error) {
      debugLogger.error("Error getting usage stats", { error: error.message }, "database");
      return { totalDays: 0, totalWords: 0, totalDictations: 0, averageWpm: 0 };
    }
  }

  // === Snippets ===

  getSnippets() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db.prepare("SELECT * FROM snippets ORDER BY use_count DESC, created_at DESC").all();
    } catch (error) {
      debugLogger.error("Error getting snippets", { error: error.message }, "database");
      return [];
    }
  }

  createSnippet(keyword, expansion) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const trimmedKeyword = (keyword || "").trim();
      const trimmedExpansion = (expansion || "").trim();
      if (!trimmedKeyword) return { success: false, error: "Keyword is required" };
      if (!trimmedExpansion) return { success: false, error: "Expansion is required" };
      const existing = this.db.prepare("SELECT id FROM snippets WHERE keyword = ?").get(trimmedKeyword);
      if (existing) return { success: false, error: "A snippet with that keyword already exists" };
      const result = this.db
        .prepare("INSERT INTO snippets (keyword, expansion) VALUES (?, ?)")
        .run(trimmedKeyword, trimmedExpansion);
      const snippet = this.db.prepare("SELECT * FROM snippets WHERE id = ?").get(result.lastInsertRowid);
      return { success: true, snippet };
    } catch (error) {
      debugLogger.error("Error creating snippet", { error: error.message }, "database");
      return { success: false, error: error.message };
    }
  }

  updateSnippet(id, updates) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const allowedFields = ["keyword", "expansion"];
      const fields = [];
      const values = [];
      for (const [key, value] of Object.entries(updates)) {
        if (allowedFields.includes(key) && value !== undefined) {
          fields.push(`${key} = ?`);
          values.push(typeof value === "string" ? value.trim() : value);
        }
      }
      if (fields.length === 0) return { success: false };
      fields.push("updated_at = CURRENT_TIMESTAMP");
      values.push(id);
      this.db.prepare(`UPDATE snippets SET ${fields.join(", ")} WHERE id = ?`).run(...values);
      const snippet = this.db.prepare("SELECT * FROM snippets WHERE id = ?").get(id);
      return { success: true, snippet };
    } catch (error) {
      debugLogger.error("Error updating snippet", { error: error.message }, "database");
      return { success: false, error: error.message };
    }
  }

  deleteSnippet(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      this.db.prepare("DELETE FROM snippets WHERE id = ?").run(id);
      return { success: true, id };
    } catch (error) {
      debugLogger.error("Error deleting snippet", { error: error.message }, "database");
      return { success: false, error: error.message };
    }
  }

  findSnippet(text) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const normalized = (text || "").trim().toLowerCase();
      if (!normalized) return null;
      const snippet = this.db
        .prepare("SELECT * FROM snippets WHERE LOWER(TRIM(keyword)) = ?")
        .get(normalized);
      if (snippet) {
        this.db.prepare("UPDATE snippets SET use_count = use_count + 1 WHERE id = ?").run(snippet.id);
      }
      return snippet || null;
    } catch (error) {
      debugLogger.error("Error finding snippet", { error: error.message }, "database");
      return null;
    }
  }

  // Style Profile methods
  getStyleProfiles() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db.prepare("SELECT * FROM style_profiles ORDER BY id ASC").all();
    } catch (error) {
      debugLogger.error("Error getting style profiles", { error: error.message }, "database");
      return [];
    }
  }

  getStyleExamples(limit = 4) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db
        .prepare(
          "SELECT before_text as before, after_text as after, source FROM style_examples ORDER BY id DESC LIMIT ?"
        )
        .all(Math.max(1, Math.min(limit || 4, 20)));
    } catch (error) {
      debugLogger.error("Error getting style examples", { error: error.message }, "database");
      return [];
    }
  }

  addStyleExample(beforeText, afterText, source = "history-edit") {
    try {
      if (!this.db) throw new Error("Database not initialized");
      if (!beforeText?.trim() || !afterText?.trim()) return null;
      if (beforeText.trim() === afterText.trim()) return null;
      const result = this.db
        .prepare("INSERT INTO style_examples (before_text, after_text, source) VALUES (?, ?, ?)")
        .run(beforeText.trim(), afterText.trim(), source);
      // Keep only the most recent 50 examples
      this.db
        .prepare(
          "DELETE FROM style_examples WHERE id NOT IN (SELECT id FROM style_examples ORDER BY id DESC LIMIT 50)"
        )
        .run();
      return { id: result.lastInsertRowid };
    } catch (error) {
      debugLogger.error("Error adding style example", { error: error.message }, "database");
      return null;
    }
  }

  getActiveStyleProfile() {
    try {
      if (!this.db) throw new Error("Database not initialized");
      return this.db.prepare("SELECT * FROM style_profiles WHERE is_active = 1").get() || null;
    } catch (error) {
      debugLogger.error("Error getting active style profile", { error: error.message }, "database");
      return null;
    }
  }

  setActiveStyleProfile(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      this.db.prepare("UPDATE style_profiles SET is_active = 0").run();
      if (id !== null) {
        this.db.prepare("UPDATE style_profiles SET is_active = 1 WHERE id = ?").run(id);
      }
      return { success: true };
    } catch (error) {
      debugLogger.error("Error setting active profile", { error: error.message }, "database");
      return { success: false, error: error.message };
    }
  }

  createStyleProfile(name, rules) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const result = this.db
        .prepare("INSERT INTO style_profiles (name, rules) VALUES (?, ?)")
        .run(name, JSON.stringify(rules));
      return { success: true, id: result.lastInsertRowid };
    } catch (error) {
      debugLogger.error("Error creating style profile", { error: error.message }, "database");
      return { success: false, error: error.message };
    }
  }

  updateStyleProfile(id, updates) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      const fields = [];
      const values = [];
      if (updates.name !== undefined) { fields.push("name = ?"); values.push(updates.name); }
      if (updates.rules !== undefined) { fields.push("rules = ?"); values.push(JSON.stringify(updates.rules)); }
      fields.push("updated_at = CURRENT_TIMESTAMP");
      values.push(id);
      this.db.prepare(`UPDATE style_profiles SET ${fields.join(", ")} WHERE id = ?`).run(...values);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error updating style profile", { error: error.message }, "database");
      return { success: false, error: error.message };
    }
  }

  deleteStyleProfile(id) {
    try {
      if (!this.db) throw new Error("Database not initialized");
      this.db.prepare("DELETE FROM style_profiles WHERE id = ?").run(id);
      return { success: true };
    } catch (error) {
      debugLogger.error("Error deleting style profile", { error: error.message }, "database");
      return { success: false, error: error.message };
    }
  }

  cleanup() {
    try {
      const dbPath = path.join(
        app.getPath("userData"),
        process.env.NODE_ENV === "development" ? "transcriptions-dev.db" : "transcriptions.db"
      );
      if (fs.existsSync(dbPath)) {
        fs.unlinkSync(dbPath);
      }
    } catch (error) {
      debugLogger.error("Error deleting database file", { error: error.message }, "database");
    }
  }
}

module.exports = DatabaseManager;
